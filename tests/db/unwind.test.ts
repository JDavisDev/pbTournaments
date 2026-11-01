import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  actAs,
  addEvent,
  addMinutes,
  addPair,
  buildSchedule,
  checkIn,
  createDb,
  createLiveTournament,
  finishPoolPlay,
  generate,
  liveMatches,
  one,
  reportScore,
  rows,
  setClock,
  tick,
} from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

/** A live tournament with one division; `set` is SQL for the event's settings and `absent` teams aren't checked in. */
async function division(n: number, opts: { set?: string; absent?: number[]; grace?: number; pools?: number; format?: 'round_robin' | 'pools_to_bracket' | 'single_elim' } = {}) {
  const { tournamentId, director } = await createLiveTournament(db, { courts: 8, start: START });
  if (opts.grace) await db.query('update public.tournaments set checkin_grace_minutes = $2 where id = $1', [tournamentId, opts.grace]);
  const eventId = await addEvent(db, tournamentId, 'Open', { format: opts.format, pools: opts.pools });
  if (opts.set) await db.query(`update public.events set ${opts.set} where id = $1`, [eventId]);
  const teams: string[] = [];
  for (let i = 1; i <= n; i++) {
    const team = await addPair(db, eventId, [`S${i}a`, `S${i}b`], i);
    if (!opts.absent?.includes(i)) await checkIn(db, team);
    teams.push(team);
  }
  return { tournamentId, director, eventId, teams };
}

const call = (fn: string, ...args: unknown[]) =>
  db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')})`, args);
const correct = (id: string, games: number[][]) =>
  db.query('select public.correct_score($1, $2::jsonb)', [id, JSON.stringify(games)]);
const match = (id: string) => one(db, 'select * from public.matches where id = $1', [id]);
const start = (eventId: string) => call('start_event', eventId);
const teamMatches = (eventId: string, team: string, status: string) =>
  rows(db, `select * from public.matches where event_id = $1 and $2 in (team1_id, team2_id) and status = $3`, [eventId, team, status]);
const byLabel = async (eventId: string) =>
  Object.fromEntries((await rows(db, 'select * from public.matches where event_id = $1', [eventId])).map((m) => [m.label, m]));

/** Reports every match on court until nothing more goes on, the first team winning. */
async function playOut(tournamentId: string) {
  for (let i = 0; i < 12; i++) {
    const live = await liveMatches(db, tournamentId);
    if (live.length === 0) return;
    for (const m of live) await reportScore(db, m.id, [[11, 5]]);
  }
}

describe('correcting results', () => {
  it('changes a winner after the next match started: the record changes, the bracket stands', async () => {
    const { tournamentId, eventId } = await division(4, { format: 'single_elim' });
    await generate(db, eventId);
    const [semi, other] = await liveMatches(db, tournamentId);
    await reportScore(db, semi.id, [[11, 5]]);
    await reportScore(db, other.id, [[11, 5]]);
    const final = (await liveMatches(db, tournamentId))[0];
    await correct(semi.id, [[5, 11]]);
    expect((await match(semi.id)).winner_team_id).toBe(semi.team2_id);
    const after = await match(final.id);
    expect(after.team1_id).toBe(final.team1_id);
    expect(after.team2_id).toBe(final.team2_id);
    expect(after.status).toBe('in_progress');
  });

  it('can put the right team in by sending the next match back to the queue first', async () => {
    const { tournamentId, eventId } = await division(4, { format: 'single_elim' });
    await generate(db, eventId);
    const [semi, other] = await liveMatches(db, tournamentId);
    await reportScore(db, semi.id, [[11, 5]]);
    await reportScore(db, other.id, [[11, 5]]);
    const final = (await liveMatches(db, tournamentId))[0];
    await call('requeue_match', final.id, null, true);
    expect(await liveMatches(db, tournamentId)).toEqual([]);
    await correct(semi.id, [[5, 11]]);
    expect([(await match(final.id)).team1_id, (await match(final.id)).team2_id]).toContain(semi.team2_id);
  });

  it('carries a new loser through a losers-bracket bye', async () => {
    const { tournamentId, eventId, teams } = await division(6, {
      format: 'single_elim',
      set: `bracket_type = 'double', third_place_match = false, grand_final_reset = false`,
    });
    await generate(db, eventId);
    for (const m of await rows(db, `select id from public.matches where event_id = $1 and side = 'main' and round = 2`, [eventId])) {
      await call('hold_match', m.id, true);
    }
    const m = (await liveMatches(db, tournamentId)).find((x) => teams[3] === x.team1_id)!;
    await reportScore(db, m.id, [[11, 5]]);
    await correct(m.id, [[5, 11]]);
    expect(await rows(db, `select id from public.matches where event_id = $1 and side = 'losers' and $2 in (team1_id, team2_id, winner_team_id)`, [eventId, m.team2_id])).toHaveLength(0);
    const bye = await rows(db, `select * from public.matches where event_id = $1 and side = 'losers' and is_bye and winner_team_id = $2`, [eventId, m.team1_id]);
    expect(bye).toHaveLength(1);
  });

  it('brings back or removes the reset final when the grand final’s winner changes', async () => {
    const { tournamentId, eventId } = await division(4, {
      format: 'single_elim',
      set: `bracket_type = 'double', grand_final_reset = true, third_place_match = false`,
    });
    await generate(db, eventId);
    for (let i = 0; i < 8; i++) {
      for (const m of await liveMatches(db, tournamentId)) {
        if (m.round_key !== 'grand_final') await reportScore(db, m.id, [[11, 5]]);
      }
    }
    const gf = await one(db, `select * from public.matches where event_id = $1 and round_key = 'grand_final' and round = 1`, [eventId]);
    const reset = () => one(db, `select * from public.matches where event_id = $1 and round_key = 'grand_final' and round = 2`, [eventId]);
    await reportScore(db, gf.id, [[11, 5]]);
    expect((await reset()).status).toBe('cancelled');

    await correct(gf.id, [[5, 11]]);
    expect((await reset()).status).not.toBe('cancelled');
    expect((await reset()).team1_id).toBe(gf.team1_id);

    // On court, it stands; held off court first, it goes.
    await call('requeue_match', (await reset()).id, null, true);
    await correct(gf.id, [[11, 5]]);
    expect((await reset()).status).toBe('cancelled');
  });

  it('sends a corrected match back to DUPR', async () => {
    const { tournamentId, eventId } = await division(2);
    await generate(db, eventId);
    const [m] = await liveMatches(db, tournamentId);
    await reportScore(db, m.id, [[11, 5]]);
    await db.query('select public.mark_dupr_exported($1, $2::uuid[])', [tournamentId, [m.id]]);
    await correct(m.id, [[11, 7]]);
    expect((await match(m.id)).dupr_exported_at).toBeNull();
  });

  it('turns a result into a forfeit, and gives a forfeit to the other team', async () => {
    const { tournamentId, eventId } = await division(4, { format: 'single_elim' });
    await generate(db, eventId);
    const [semi] = await liveMatches(db, tournamentId);
    await reportScore(db, semi.id, [[11, 5]]);
    await call('forfeit_match', semi.id, semi.team2_id);
    const m = await match(semi.id);
    expect(m).toMatchObject({ forfeit: true, games: null, winner_team_id: semi.team2_id });
    const final = await one(db, 'select * from public.matches where id = $1', [semi.winner_to_match_id]);
    expect([final.team1_id, final.team2_id]).toContain(semi.team2_id);
    expect([final.team1_id, final.team2_id]).not.toContain(semi.team1_id);
  });

  it('undoes a result: back in the queue, off the next match', async () => {
    const { tournamentId, eventId } = await division(4, { format: 'single_elim' });
    await generate(db, eventId);
    const [semi] = await liveMatches(db, tournamentId);
    await reportScore(db, semi.id, [[11, 5]]);
    await call('reopen_match', semi.id);
    const m = await match(semi.id);
    expect(m).toMatchObject({ winner_team_id: null, games: null, forfeit: false });
    expect(['queued', 'in_progress']).toContain(m.status);
    const final = await match(semi.winner_to_match_id);
    expect([final.team1_id, final.team2_id]).not.toContain(semi.team1_id);
  });

  it('won’t undo a result once the next match has started', async () => {
    const { tournamentId, eventId } = await division(4, { format: 'single_elim' });
    await generate(db, eventId);
    const [semi, other] = await liveMatches(db, tournamentId);
    await reportScore(db, semi.id, [[11, 5]]);
    await reportScore(db, other.id, [[11, 5]]);
    await expect(call('reopen_match', semi.id)).rejects.toThrow(/already started/);
  });

  it('needs a final division to be reopened first', async () => {
    const { tournamentId, eventId } = await division(2);
    await generate(db, eventId);
    const [m] = await liveMatches(db, tournamentId);
    await reportScore(db, m.id, [[11, 5]]);
    await call('finalize_event', eventId);
    await expect(call('reopen_match', m.id)).rejects.toThrow(/final/);
    await call('reopen_event', eventId);
    await call('reopen_match', m.id);
  });
});

describe('resetting a bracket', () => {
  /** Two pools of 2 teams, played out and finalized, with the bracket on court. */
  async function bracketOnCourt() {
    const d = await division(4, { format: 'pools_to_bracket', pools: 2, set: `advance_per_pool = 2, third_place_match = false` });
    await generate(db, d.eventId);
    await playOut(d.tournamentId);
    await finishPoolPlay(db, d.eventId);
    return d;
  }

  it('goes back to reviewing pool play until the second round has started', async () => {
    const { tournamentId, eventId } = await bracketOnCourt();
    const [semi] = await liveMatches(db, tournamentId);
    await reportScore(db, semi.id, [[11, 5]]);

    const discarded = (await one(db, 'select public.reset_bracket($1) as n', [eventId])).n;
    expect(discarded).toBe(2);
    expect(await liveMatches(db, tournamentId)).toEqual([]);
    const e = await one(db, 'select * from public.events where id = $1', [eventId]);
    expect(e.pools_finalized_at).toBeNull();
    expect(e.playoffs_seeded_at).toBeNull();
    expect((await rows(db, `select id from public.notifications where kind = 'match_called_off'`)).length).toBeGreaterThan(0);

    // Seeded again.
    await call('finalize_pool_play', eventId);
    expect(await rows(db, `select id from public.matches where event_id = $1 and stage = 'bracket' and team1_id is not null`, [eventId])).not.toHaveLength(0);
  });

  it('stands once the second round has started', async () => {
    const { tournamentId, eventId } = await bracketOnCourt();
    for (const m of await liveMatches(db, tournamentId)) await reportScore(db, m.id, [[11, 5]]);
    expect(await liveMatches(db, tournamentId)).toHaveLength(1);
    await expect(call('reset_bracket', eventId)).rejects.toThrow(/second round/);
  });

  it('rebuilds a bracket-only division from the new seeds, held', async () => {
    const { tournamentId, eventId, teams } = await division(4, { format: 'single_elim' });
    await generate(db, eventId);
    const [semi] = await liveMatches(db, tournamentId);
    await reportScore(db, semi.id, [[11, 5]]);
    await call('set_team_seed', teams[3], 1);
    await call('reset_bracket', eventId);
    expect(await liveMatches(db, tournamentId)).toEqual([]);
    const bracket = await rows(db, `select * from public.matches where event_id = $1 and round = 1 and (team1_id = $2 or team2_id = $2)`, [eventId, teams[3]]);
    expect(bracket).toHaveLength(1);
    expect(bracket[0].team1_seed).toBe(1);
    expect(bracket[0].on_hold).toBe(true);
    await call('start_bracket', eventId);
    expect(await liveMatches(db, tournamentId)).toHaveLength(2);
  });

  it('unseeds when a pool result is undone before the bracket has started', async () => {
    const { eventId } = await (async () => {
      const d = await division(4, { format: 'pools_to_bracket', pools: 2, set: `advance_per_pool = 2, third_place_match = false` });
      await generate(db, d.eventId);
      await playOut(d.tournamentId);
      await call('finalize_pool_play', d.eventId);
      return d;
    })();
    const [pool] = await rows(db, `select * from public.matches where event_id = $1 and stage = 'pool' limit 1`, [eventId]);
    await call('reopen_match', pool.id);
    expect((await one(db, 'select pools_finalized_at from public.events where id = $1', [eventId])).pools_finalized_at).toBeNull();
    expect((await match(pool.id)).winner_team_id).toBeNull();
  });
});

describe('late, missing and dropped teams', () => {
  it('marking a checked-in team missing only checks it out, even past the deadline', async () => {
    const { tournamentId, eventId } = await division(4, { grace: 10 });
    await start(eventId);
    await setClock(db, addMinutes(START, 30));
    const [m] = await liveMatches(db, tournamentId);
    await call('requeue_match', m.id, m.team1_id);
    await tick(db);
    expect(await teamMatches(eventId, m.team1_id, 'completed')).toHaveLength(0);
    expect((await one(db, 'select no_show_at from public.teams where id = $1', [m.team1_id])).no_show_at).toBeNull();
  });

  it('a late check-in brings back the matches forfeited, and they get played', async () => {
    const { tournamentId, eventId, teams } = await division(4, { grace: 10, absent: [4] });
    await start(eventId);
    await setClock(db, addMinutes(START, 11));
    await tick(db);
    expect(await teamMatches(eventId, teams[3], 'completed')).toHaveLength(3);
    await checkIn(db, teams[3]);
    expect(await teamMatches(eventId, teams[3], 'completed')).toHaveLength(0);
    await playOut(tournamentId);
    expect((await teamMatches(eventId, teams[3], 'completed')).every((m) => !m.forfeit)).toBe(true);
    expect(await teamMatches(eventId, teams[3], 'completed')).toHaveLength(3);
  });

  it('a late team keeps a forfeit its opponent has moved on from', async () => {
    const { tournamentId, eventId, teams } = await division(4, { grace: 10, absent: [4], format: 'single_elim' });
    await start(eventId);
    await setClock(db, addMinutes(START, 11));
    await tick(db);
    const [semi] = await teamMatches(eventId, teams[3], 'completed');
    for (const m of await liveMatches(db, tournamentId)) await reportScore(db, m.id, [[11, 5]]);
    expect(await liveMatches(db, tournamentId)).toHaveLength(1);
    await checkIn(db, teams[3]);
    expect((await match(semi.id)).status).toBe('completed');
  });

  it('a director can give a no-show more time', async () => {
    const { eventId, teams } = await division(4, { grace: 10, absent: [4] });
    await start(eventId);
    await setClock(db, addMinutes(START, 11));
    await tick(db);
    expect((await one(db, 'select public.reinstate_team($1) as n', [teams[3]])).n).toBe(3);
    await setClock(db, addMinutes(START, 40));
    await tick(db);
    expect(await teamMatches(eventId, teams[3], 'completed')).toHaveLength(0);
    expect(await teamMatches(eventId, teams[3], 'queued')).toHaveLength(3);
  });

  it('puts a dropped team back, with the matches it forfeited and its check-in', async () => {
    const { tournamentId, eventId, teams } = await division(4);
    await generate(db, eventId);
    const played = (await liveMatches(db, tournamentId)).find((m) => teams[0] === m.team1_id || teams[0] === m.team2_id)!;
    await reportScore(db, played.id, [[11, 5]]);
    await call('withdraw_team', teams[0]);
    expect((await teamMatches(eventId, teams[0], 'completed')).filter((m) => m.forfeit)).toHaveLength(2);

    expect((await one(db, 'select public.reinstate_team($1) as n', [teams[0]])).n).toBe(2);
    const t = await one(db, 'select * from public.teams where id = $1', [teams[0]]);
    expect(t.withdrawn_at).toBeNull();
    expect(t.checked_in_at).not.toBeNull();
    // The result it actually played stays.
    expect((await match(played.id)).games).toEqual([[11, 5]]);
    expect((await teamMatches(eventId, teams[0], 'completed')).filter((m) => m.forfeit)).toHaveLength(0);
  });

  it('undoes a replacement while the alternate hasn’t started', async () => {
    const { tournamentId, eventId } = await division(4);
    await buildSchedule(db, eventId);
    const alternate = await addPair(db, eventId, ['Alt', 'Late']);
    await start(eventId);
    const [m] = await liveMatches(db, tournamentId);
    await call('requeue_match', m.id, null, true);
    await call('replace_team', m.team1_id, alternate);
    expect((await match(m.id)).team1_id).toBe(alternate);
    await call('reinstate_team', m.team1_id);
    expect((await match(m.id)).team1_id).toBe(m.team1_id);
    expect(await one(db, 'select withdrawn_at, replaced_by_team_id from public.teams where id = $1', [m.team1_id])).toMatchObject({
      withdrawn_at: null,
      replaced_by_team_id: null,
    });
    expect((await one(db, 'select pool from public.teams where id = $1', [alternate])).pool).toBeNull();
  });

  it('won’t undo a replacement once the alternate has started', async () => {
    const { tournamentId, eventId } = await division(4);
    await buildSchedule(db, eventId);
    const alternate = await addPair(db, eventId, ['Alt', 'Late']);
    await checkIn(db, alternate);
    await start(eventId);
    const [m] = await liveMatches(db, tournamentId);
    await call('replace_team', m.team1_id, alternate);
    await expect(call('reinstate_team', m.team1_id)).rejects.toThrow(/already started/);
  });

  it('doesn’t forfeit an alternate, before or after it’s swapped in past the deadline', async () => {
    const { eventId, teams } = await division(4, { grace: 10 });
    await buildSchedule(db, eventId);
    const alternate = await addPair(db, eventId, ['Alt', 'Late']);
    await start(eventId);
    await setClock(db, addMinutes(START, 11));
    await tick(db);
    expect((await one(db, 'select no_show_at from public.teams where id = $1', [alternate])).no_show_at).toBeNull();
    await call('replace_team', teams[3], alternate);
    await tick(db);
    expect((await one(db, 'select no_show_at from public.teams where id = $1', [alternate])).no_show_at).toBeNull();
    expect((await teamMatches(eventId, alternate, 'completed')).filter((m) => m.forfeit)).toHaveLength(0);
  });

  it('subbing a player back brings back their own record', async () => {
    const { teams } = await division(2);
    const [{ player_id: original }] = await rows(db, 'select player_id from public.team_players where team_id = $1 limit 1', [teams[0]]);
    const p = await one(db, 'select * from public.players where id = $1', [original]);
    await db.query(`update public.players set dupr_id = 'ABC123' where id = $1`, [original]);
    await call('substitute_player', teams[0], original, 'New', 'Person');
    const { player_id: sub } = await one(db, `select tp.player_id from public.team_players tp join public.players p on p.id = tp.player_id where tp.team_id = $1 and p.last_name = 'Person'`, [teams[0]]);
    await call('substitute_player', teams[0], sub, p.first_name, p.last_name);
    expect(await rows(db, 'select 1 from public.team_players where team_id = $1 and player_id = $2', [teams[0], original])).toHaveLength(1);
    expect((await one(db, 'select name from public.teams where id = $1', [teams[0]])).name).toContain(p.last_name);
  });
});

describe('changing pool play', () => {
  it('adds a late team to a running round robin, against everyone in its pool', async () => {
    const { tournamentId, eventId } = await division(4);
    await generate(db, eventId);
    const [played] = await liveMatches(db, tournamentId);
    await reportScore(db, played.id, [[11, 5]]);
    const late = await addPair(db, eventId, ['Late', 'Comer'], 5);
    expect((await one(db, 'select public.place_team_in_pool($1, 1) as n', [late])).n).toBe(4);
    await checkIn(db, late);
    await playOut(tournamentId);
    expect(await teamMatches(eventId, late, 'completed')).toHaveLength(4);
    expect((await one(db, 'select played from public.standings where team_id = $1', [late])).played).toBe(4);
  });

  it('moves a team that hasn’t played to another pool, not one that has', async () => {
    const { tournamentId, eventId, teams } = await division(6, { pools: 2 });
    await db.query('update public.tournaments set auto_assign = false where id = $1', [tournamentId]);
    await generate(db, eventId);
    const t = await one(db, 'select * from public.teams where id = $1', [teams[0]]);
    const other = t.pool === 1 ? 2 : 1;
    await call('place_team_in_pool', teams[0], other);
    const after = await rows(db, `select * from public.matches where event_id = $1 and $2 in (team1_id, team2_id)`, [eventId, teams[0]]);
    expect(after).toHaveLength(3);
    expect(after.every((m) => m.pool === other)).toBe(true);

    await call('assign_courts', tournamentId);
    const [live] = await liveMatches(db, tournamentId);
    await reportScore(db, live.id, [[11, 5]]);
    const fromPool = (await one(db, 'select pool from public.teams where id = $1', [live.team1_id])).pool;
    await expect(call('place_team_in_pool', live.team1_id, fromPool === 1 ? 2 : 1)).rejects.toThrow(/already played/);
  });

  it('swaps two teams’ places, and refuses once one has played', async () => {
    const { tournamentId, eventId, teams } = await division(4, { pools: 2 });
    await db.query('update public.tournaments set auto_assign = false where id = $1', [tournamentId]);
    await generate(db, eventId);
    const pools = async () => rows(db, 'select id, pool from public.teams where id = any($1::uuid[]) order by id', [[teams[0], teams[1]]]);
    const before = await pools();
    await call('swap_pool_teams', eventId, teams[0], teams[1]);
    const after = await pools();
    expect(after[0].pool).toBe(before[1].pool);
    expect(after[1].pool).toBe(before[0].pool);
    const m = await rows(db, 'select pool from public.matches where $1 in (team1_id, team2_id)', [teams[0]]);
    expect(m.every((x) => x.pool === after.find((a) => a.id === teams[0])!.pool)).toBe(true);

    await call('assign_courts', tournamentId);
    const [live] = await liveMatches(db, tournamentId);
    await expect(call('swap_pool_teams', eventId, live.team1_id, teams.find((t) => t !== live.team1_id && t !== live.team2_id)!)).rejects.toThrow(/already played/);
  });

  it('cancels and restores one match', async () => {
    const { tournamentId, eventId } = await division(4);
    await db.query('update public.tournaments set auto_assign = false where id = $1', [tournamentId]);
    await generate(db, eventId);
    const [m] = await rows(db, `select * from public.matches where event_id = $1 limit 1`, [eventId]);
    await call('cancel_match', m.id);
    expect((await match(m.id)).status).toBe('cancelled');
    await call('reopen_match', m.id);
    expect((await match(m.id)).status).toBe('queued');
  });

  it('resumes after ending early', async () => {
    const { tournamentId, eventId } = await division(4);
    await db.query('update public.tournaments set auto_assign = false where id = $1', [tournamentId]);
    await generate(db, eventId);
    const n = (await one(db, 'select public.end_pool_play($1) as n', [eventId])).n;
    expect(n).toBeGreaterThan(0);
    expect((await one(db, 'select public.resume_pool_play($1) as n', [eventId])).n).toBe(n);
    expect(await rows(db, `select id from public.matches where event_id = $1 and status = 'cancelled'`, [eventId])).toHaveLength(0);
  });

  it('resumes Swiss with its planned rounds', async () => {
    const { tournamentId, eventId } = await division(6, { set: `pool_play = 'swiss', max_rounds = 3` });
    await generate(db, eventId);
    await db.query('select public.end_pool_play($1)', [eventId]);
    expect((await one(db, 'select max_rounds from public.events where id = $1', [eventId])).max_rounds).toBe(1);
    await call('resume_pool_play', eventId);
    expect((await one(db, 'select max_rounds, rounds_before_end from public.events where id = $1', [eventId]))).toMatchObject({
      max_rounds: 3,
      rounds_before_end: null,
    });
    for (const m of await liveMatches(db, tournamentId)) await reportScore(db, m.id, [[11, 5]]);
    expect((await rows(db, `select id from public.matches where event_id = $1 and round = 2`, [eventId])).length).toBeGreaterThan(0);
  });

  it('draws the next Swiss round again when a result changes before anyone plays it', async () => {
    const { tournamentId, eventId } = await division(4, { set: `pool_play = 'swiss', max_rounds = 2` });
    await generate(db, eventId);
    await db.query('update public.courts set out_of_service = true where tournament_id = $1 and id not in (select court_id from public.matches where event_id = $2 and court_id is not null)', [tournamentId, eventId]);
    const live = await liveMatches(db, tournamentId);
    await reportScore(db, live[0].id, [[11, 5]]);
    await db.query('update public.tournaments set auto_assign = false where id = $1', [tournamentId]);
    await reportScore(db, live[1].id, [[11, 5]]);
    const before = await rows(db, `select id from public.matches where event_id = $1 and round = 2 order by id`, [eventId]);
    expect(before).toHaveLength(2);
    await correct(live[0].id, [[5, 11]]);
    const after = await rows(db, `select id from public.matches where event_id = $1 and round = 2 order by id`, [eventId]);
    expect(after).toHaveLength(2);
    expect(after.map((m) => m.id)).not.toEqual(before.map((m) => m.id));
  });

  it('doesn’t hold up Swiss for a no-show', async () => {
    const { tournamentId, eventId, teams } = await division(4, { grace: 10, absent: [4], set: `pool_play = 'swiss', max_rounds = 3` });
    await start(eventId);
    await setClock(db, addMinutes(START, 11));
    await tick(db);
    await playOut(tournamentId);
    expect(await rows(db, `select id from public.matches where event_id = $1 and status = 'queued'`, [eventId])).toHaveLength(0);
    const inLater = await rows(db, `select id from public.matches where event_id = $1 and round > 1 and $2 in (team1_id, team2_id)`, [eventId, teams[3]]);
    expect(inLater).toHaveLength(0);
  });

  it('sets a seed: the others shift around it', async () => {
    const { eventId, teams } = await division(4);
    await call('set_team_seed', teams[3], 1);
    const order = await rows(db, 'select id from public.teams where event_id = $1 order by seed', [eventId]);
    expect(order.map((t) => t.id)).toEqual([teams[3], teams[0], teams[1], teams[2]]);
  });
});

describe('undoing a start', () => {
  it('calls off matches on court, clears the schedule and any no-show forfeits', async () => {
    const { tournamentId, eventId, teams } = await division(4, { grace: 10, absent: [4] });
    await start(eventId);
    await setClock(db, addMinutes(START, 11));
    await tick(db);
    expect((await liveMatches(db, tournamentId)).length).toBeGreaterThan(0);
    await call('clear_matches', eventId);
    expect(await liveMatches(db, tournamentId)).toEqual([]);
    expect(await rows(db, 'select id from public.matches where event_id = $1', [eventId])).toHaveLength(0);
    const e = await one(db, 'select started_at from public.events where id = $1', [eventId]);
    expect(e.started_at).toBeNull();
    expect((await one(db, 'select no_show_at from public.teams where id = $1', [teams[3]])).no_show_at).toBeNull();
    expect((await rows(db, `select id from public.notifications where kind = 'match_called_off'`)).length).toBeGreaterThan(0);
  });

  it('clears a bracket with byes that hasn’t been played', async () => {
    const { eventId } = await division(3, { format: 'single_elim' });
    await buildSchedule(db, eventId);
    await call('clear_matches', eventId);
  });

  it('won’t clear once a match has a result', async () => {
    const { tournamentId, eventId } = await division(4);
    await generate(db, eventId);
    const [m] = await liveMatches(db, tournamentId);
    await reportScore(db, m.id, [[11, 5]]);
    await expect(call('clear_matches', eventId)).rejects.toThrow(/already been played/);
  });
});

describe('who can do what', () => {
  it('a player’s link can’t withdraw from a division that has started, but the director can', async () => {
    const { tournamentId, director, eventId, teams } = await division(4);
    const reg = await one(
      db,
      `insert into public.registrations (tournament_id, player_id, status, amount_cents)
       select $1, tp.player_id, 'paid', 0 from public.team_players tp where tp.team_id = $2 limit 1 returning id`,
      [tournamentId, teams[0]],
    );
    await db.query('insert into public.registration_entries (registration_id, event_id, team_id) values ($1, $2, $3)', [reg.id, eventId, teams[0]]);
    await start(eventId);

    await actAs(db, null);
    await expect(call('withdraw_registration', reg.id, eventId)).rejects.toThrow(/see the desk/);
    await actAs(db, director);
    await call('withdraw_registration', reg.id, eventId);
    expect((await one(db, 'select withdrawn_at from public.teams where id = $1', [teams[0]])).withdrawn_at).not.toBeNull();
  });

  it('only staff can use the recovery tools', async () => {
    const { tournamentId, eventId, teams } = await division(4);
    await generate(db, eventId);
    const [m] = await liveMatches(db, tournamentId);
    await reportScore(db, m.id, [[11, 5]]);
    await actAs(db, null);
    for (const attempt of [
      call('reopen_match', m.id),
      call('forfeit_match', m.id, m.team2_id),
      call('reset_bracket', eventId),
      call('resume_pool_play', eventId),
      call('reinstate_team', teams[0]),
      call('place_team_in_pool', teams[0], 1),
      call('swap_pool_teams', eventId, teams[0], teams[1]),
      call('set_team_seed', teams[0], 1),
    ]) {
      await expect(attempt).rejects.toThrow(/staff|director|permission/i);
    }
  });
});
