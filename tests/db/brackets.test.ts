import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  type EventOptions,
  addEvent,
  addPair,
  checkIn,
  createDb,
  createLiveTournament,
  finishPoolPlay,
  generate,
  liveMatches,
  one,
  reportScore,
  rows,
} from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

interface BracketOptions extends EventOptions {
  maxRounds?: number;
  bracketType?: 'single' | 'double';
  thirdPlace?: boolean;
  reset?: boolean;
  confirmSeeds?: boolean;
  roundFormats?: object[];
}

/** A live tournament with one event of checked-in teams seeded 1..n. */
async function bracketEvent(teamCount: number, opts: BracketOptions = {}) {
  const { tournamentId } = await createLiveTournament(db, { courts: 8, start: START });
  const eventId = await addEvent(db, tournamentId, 'Open', opts);
  await db.query(
    `update public.events
     set max_rounds = $2, bracket_type = $3, third_place_match = $4, grand_final_reset = $5,
         confirm_seeds = $6, round_formats = $7::jsonb
     where id = $1`,
    [
      eventId,
      opts.maxRounds ?? null,
      opts.bracketType ?? 'single',
      opts.thirdPlace ?? false,
      opts.reset ?? false,
      opts.confirmSeeds ?? false,
      JSON.stringify(opts.roundFormats ?? []),
    ],
  );
  const teams: string[] = [];
  for (let i = 1; i <= teamCount; i++) {
    const team = await addPair(db, eventId, [`S${i}a`, `S${i}b`], i);
    await checkIn(db, team);
    teams.push(team);
  }
  const seedOf = (team: string) => teams.indexOf(team) + 1;
  return { tournamentId, eventId, teams, seedOf };
}

/**
 * Plays every match that reaches a court until the event is done. The better
 * seed wins unless `upset` says otherwise for that match.
 */
async function playOut(
  tournamentId: string,
  seedOf: (team: string) => number,
  upset: (m: Record<string, any>) => boolean = () => false,
) {
  for (let guard = 0; guard < 50; guard++) {
    const live = await liveMatches(db, tournamentId);
    if (live.length === 0) return;
    for (const m of live) {
      const team1Wins = (seedOf(m.team1_id) < seedOf(m.team2_id)) !== upset(m);
      await reportScore(db, m.id, [team1Wins ? [11, 6] : [6, 11]]);
    }
  }
  throw new Error('event never finished');
}

const bracketRows = (eventId: string) =>
  rows(
    db,
    `select * from public.match_details where event_id = $1 and stage = 'bracket'
     order by side, round, position`,
    [eventId],
  );

describe('round robin options', () => {
  it('stops after max_rounds', async () => {
    const { eventId } = await bracketEvent(8, { maxRounds: 6 });
    expect(await generate(db, eventId)).toBe(24);
    const perTeam = await rows(
      db,
      `select t.id, count(m.id)::int as n from public.teams t
       join public.matches m on t.id in (m.team1_id, m.team2_id)
       where t.event_id = $1 group by t.id`,
      [eventId],
    );
    expect(new Set(perTeam.map((r) => r.n))).toEqual(new Set([6]));
  });

  it('ends pool play early, cancelling unplayed matches, and seeds the bracket by win percentage', async () => {
    const { tournamentId, eventId, seedOf } = await bracketEvent(4, {
      format: 'pools_to_bracket',
      pools: 1,
      advancePerPool: 2,
    });
    expect(await generate(db, eventId)).toBe(6 + 1);

    // Round 1 only: seeds 1 and 2 win.
    for (const m of await liveMatches(db, tournamentId)) {
      if (m.round !== 1) continue;
      await reportScore(db, m.id, [seedOf(m.team1_id) < seedOf(m.team2_id) ? [11, 3] : [3, 11]]);
    }
    const cancelled = (await one(db, 'select public.end_pool_play($1) as n', [eventId])).n;
    const left = await rows(
      db,
      `select status, count(*)::int as n from public.matches where event_id = $1 and stage = 'pool' group by status`,
      [eventId],
    );
    const live = left.find((r) => r.status === 'assigned' || r.status === 'in_progress');
    expect(cancelled + (live?.n ?? 0) + 2).toBe(6);

    // Matches already on court finish normally; then the director finalizes pool play and the bracket fills.
    for (const m of await liveMatches(db, tournamentId)) {
      await reportScore(db, m.id, [seedOf(m.team1_id) < seedOf(m.team2_id) ? [11, 3] : [3, 11]]);
    }
    await finishPoolPlay(db, eventId);
    const [final] = await bracketRows(eventId);
    expect(final.status).not.toBe('waiting');
    expect([seedOf(final.team1_id), seedOf(final.team2_id)].sort()).toEqual([1, 2]);
  });
});

describe('reviewing pool play', () => {
  it('waits for the director, and re-seeds from corrected scores until the bracket starts', async () => {
    const { tournamentId, eventId, teams, seedOf } = await bracketEvent(4, { format: 'pools_to_bracket', pools: 1, advancePerPool: 2 });
    await generate(db, eventId);
    // The better seed wins every pool match: 1 and 2 reach the final.
    for (let guard = 0; guard < 10; guard++) {
      const live = (await liveMatches(db, tournamentId)).filter((m) => m.stage === 'pool');
      if (live.length === 0) break;
      for (const m of live) await reportScore(db, m.id, [seedOf(m.team1_id) < seedOf(m.team2_id) ? [11, 3] : [3, 11]]);
    }
    const finalSeeds = async () => {
      const [final] = await bracketRows(eventId);
      return [seedOf(final.team1_id), seedOf(final.team2_id)].sort();
    };

    // Pool play is over, but nothing moves on until the director finalizes it.
    expect((await bracketRows(eventId))[0].team1_id).toBeNull();
    await db.query('select public.finalize_pool_play($1)', [eventId]);
    expect(await finalSeeds()).toEqual([1, 2]);
    expect((await bracketRows(eventId))[0].on_hold).toBe(true);

    // Seed 3 actually beat seed 2. Fixed before the bracket starts, it re-seeds.
    const twoVsThree = await one(
      db,
      `select * from public.matches where event_id = $1 and stage = 'pool' and $2 in (team1_id, team2_id) and $3 in (team1_id, team2_id)`,
      [eventId, teams[1], teams[2]],
    );
    const flipped = (winner: number) => [[seedOf(twoVsThree.team1_id) === winner ? 11 : 6, seedOf(twoVsThree.team1_id) === winner ? 6 : 11]];
    await db.query('select public.correct_score($1, $2::jsonb)', [twoVsThree.id, JSON.stringify(flipped(3))]);
    expect(await finalSeeds()).toEqual([1, 3]);

    // Once the bracket starts it stands: a fix is saved for the record only.
    await db.query('select public.start_bracket($1)', [eventId]);
    await db.query('select public.correct_score($1, $2::jsonb)', [twoVsThree.id, JSON.stringify(flipped(2))]);
    expect(await finalSeeds()).toEqual([1, 3]);
    expect((await one(db, 'select winner_team_id from public.matches where id = $1', [twoVsThree.id])).winner_team_id).toBe(teams[1]);
  });
});

describe('single elimination', () => {
  it('sends the semifinal losers to a bronze match', async () => {
    const { tournamentId, eventId, seedOf } = await bracketEvent(4, { format: 'single_elim', thirdPlace: true });
    expect(await generate(db, eventId)).toBe(4);
    await playOut(tournamentId, seedOf);

    const byLabel = Object.fromEntries((await bracketRows(eventId)).map((m) => [m.label, m]));
    expect(seedOf(byLabel.Final.winner_team_id)).toBe(1);
    expect([seedOf(byLabel.Bronze.team1_id), seedOf(byLabel.Bronze.team2_id)].sort()).toEqual([3, 4]);
    expect(seedOf(byLabel.Bronze.winner_team_id)).toBe(3);
  });

  it('gives the bronze to the only semifinal loser when a semifinal is a bye', async () => {
    const { tournamentId, eventId, seedOf } = await bracketEvent(3, { format: 'single_elim', thirdPlace: true });
    await generate(db, eventId);
    await playOut(tournamentId, seedOf);
    const bronze = (await bracketRows(eventId)).find((m) => m.label === 'Bronze')!;
    expect(bronze).toMatchObject({ status: 'completed', is_bye: true });
    expect(seedOf(bronze.winner_team_id)).toBe(3);
  });
});

describe('double elimination', () => {
  it('plays a 4-team bracket, with a reset final when the losers-bracket team wins', async () => {
    const { tournamentId, eventId, seedOf } = await bracketEvent(4, {
      format: 'single_elim',
      bracketType: 'double',
      reset: true,
    });
    expect(await generate(db, eventId)).toBe(3 + 2 + 2);
    const labels = (await bracketRows(eventId)).map((m) => m.label);
    expect(labels).toEqual([
      'Grand Final',
      'Grand Final (if needed)',
      'Losers R1 #1',
      'Losers Final',
      'Winners Semifinal 1',
      'Winners Semifinal 2',
      'Winners Final',
    ]);

    // Seed 2 loses the winners final, comes back through the losers final,
    // and beats seed 1 in the first grand final.
    await playOut(tournamentId, seedOf, (m) => m.round_key === 'grand_final' && m.round === 1);
    const byLabel = Object.fromEntries((await bracketRows(eventId)).map((m) => [m.label, m]));
    expect(seedOf(byLabel['Winners Final'].winner_team_id)).toBe(1);
    expect(seedOf(byLabel['Losers Final'].winner_team_id)).toBe(2);
    expect(seedOf(byLabel['Grand Final'].winner_team_id)).toBe(2);
    expect(byLabel['Grand Final (if needed)'].status).toBe('completed');
    expect(seedOf(byLabel['Grand Final (if needed)'].winner_team_id)).toBe(1);
  });

  it('skips the reset final when the winners-bracket team wins', async () => {
    const { tournamentId, eventId, seedOf } = await bracketEvent(4, {
      format: 'single_elim',
      bracketType: 'double',
      reset: true,
    });
    await generate(db, eventId);
    await playOut(tournamentId, seedOf);
    const reset = (await bracketRows(eventId)).find((m) => m.label === 'Grand Final (if needed)')!;
    expect(reset.status).toBe('cancelled');
  });

  it('fills a 6-team bracket with byes and gives every team two losses but the champion', async () => {
    const { tournamentId, eventId, teams, seedOf } = await bracketEvent(6, {
      format: 'single_elim',
      bracketType: 'double',
    });
    await generate(db, eventId);
    // Seeds 1 and 2 have byes, so only two first-round matches go out.
    const first = await liveMatches(db, tournamentId);
    expect(first.map((m) => [seedOf(m.team1_id), seedOf(m.team2_id)]).sort()).toEqual([
      [3, 6],
      [4, 5],
    ]);

    await playOut(tournamentId, seedOf);
    const bracket = await bracketRows(eventId);
    const played = bracket.filter((m) => m.status === 'completed' && !m.is_bye);
    expect(played).toHaveLength(2 * 6 - 2);
    const losses = new Map<string, number>();
    for (const m of played) {
      const loser = m.winner_team_id === m.team1_id ? m.team2_id : m.team1_id;
      losses.set(loser, (losses.get(loser) ?? 0) + 1);
    }
    expect(seedOf(bracket.find((m) => m.label === 'Grand Final')!.winner_team_id)).toBe(1);
    for (const team of teams) {
      expect(losses.get(team) ?? 0).toBe(seedOf(team) === 1 ? 0 : 2);
    }
  });

  it('moves the loser too when a score correction changes the winner', async () => {
    const { tournamentId, eventId, seedOf } = await bracketEvent(4, { format: 'single_elim', bracketType: 'double' });
    await generate(db, eventId);
    const [semi] = (await liveMatches(db, tournamentId)).filter((m) => m.position === 1);
    await reportScore(db, semi.id, [[11, 4]]);
    await db.query(`select public.correct_score($1, '[[4, 11]]'::jsonb)`, [semi.id]);
    const byLabel = Object.fromEntries((await bracketRows(eventId)).map((m) => [m.label, m]));
    expect(seedOf(byLabel['Winners Final'].team1_id)).toBe(4);
    expect(seedOf(byLabel['Losers R1 #1'].team1_id)).toBe(1);
  });
});

describe('round formats', () => {
  it('uses the round’s own format for scoring and in the court text', async () => {
    const { tournamentId, eventId } = await bracketEvent(2, {
      format: 'single_elim',
      roundFormats: [{ key: 'final', games_to: 15, best_of: 3 }],
    });
    await generate(db, eventId);
    const [final] = await liveMatches(db, tournamentId);
    const texts = await rows(db, 'select body from public.notifications where match_id = $1', [final.id]);
    expect(texts[0].body).toContain('. Best of 3 games to 15, win by 2. Promptly report');

    await expect(reportScore(db, final.id, [[15, 10]])).rejects.toThrow();
    expect((await reportScore(db, final.id, [[15, 10], [15, 12]])).status).toBe('completed');
  });
});

describe('seeding', () => {
  it('holds the bracket for review, swaps seeds, then starts it', async () => {
    const { tournamentId, eventId, teams } = await bracketEvent(4, { format: 'single_elim', confirmSeeds: true });
    await generate(db, eventId);
    expect(await liveMatches(db, tournamentId)).toHaveLength(0);

    await db.query('select public.swap_bracket_teams($1, $2, $3)', [eventId, teams[0], teams[1]]);
    await db.query('select public.start_bracket($1)', [eventId]);
    const live = await liveMatches(db, tournamentId);
    const semi1 = live.find((m) => m.position === 1)!;
    expect([semi1.team1_id, semi1.team2_id]).toEqual([teams[1], teams[3]]);
  });

  it('won’t swap a team that has already played', async () => {
    const { tournamentId, eventId, teams } = await bracketEvent(4, { format: 'single_elim' });
    await generate(db, eventId);
    const [m] = await liveMatches(db, tournamentId);
    await reportScore(db, m.id, [[11, 4]]);
    await expect(
      db.query('select public.swap_bracket_teams($1, $2, $3)', [eventId, m.team1_id, teams.find((t) => t !== m.team1_id && t !== m.team2_id)]),
    ).rejects.toThrow(/already played/);
  });
});

describe('medal match defaults', () => {
  it('gives a new division a bronze match to 15 and a best-of-3 gold match to 11', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 4, start: START });
    // Only what a director must choose; everything else is the default.
    const { id: eventId } = await one(
      db,
      `insert into public.events (tournament_id, name, format) values ($1, 'Open', 'single_elim') returning id`,
      [tournamentId],
    );
    for (let i = 1; i <= 4; i++) await checkIn(db, await addPair(db, eventId, [`D${i}a`, `D${i}b`], i));
    await generate(db, eventId);

    const formats = Object.fromEntries(
      (await rows(db, `select round_key, format_text from public.match_details where event_id = $1`, [eventId])).map((m) => [
        m.round_key,
        m.format_text,
      ]),
    );
    expect(formats.final).toBe('best of 3 games to 11, win by 2');
    expect(formats.bronze).toBe('one game to 15, win by 2');
  });

  it('gives a double-elimination grand final the gold format', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 4, start: START });
    const { id: eventId } = await one(
      db,
      `insert into public.events (tournament_id, name, format, bracket_type) values ($1, 'Open', 'single_elim', 'double') returning id`,
      [tournamentId],
    );
    for (let i = 1; i <= 4; i++) await checkIn(db, await addPair(db, eventId, [`G${i}a`, `G${i}b`], i));
    await generate(db, eventId);
    const grandFinal = await one(db, `select format_text from public.match_details where event_id = $1 and round_key = 'grand_final' limit 1`, [eventId]);
    expect(grandFinal.format_text).toBe('best of 3 games to 11, win by 2');
  });
});
