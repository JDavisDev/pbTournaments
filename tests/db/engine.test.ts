import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  actAs,
  addEvent,
  addMinutes,
  addPair,
  addPlayer,
  addTeam,
  asRole,
  checkIn,
  createDb,
  createLiveTournament,
  createOrganization,
  createUser,
  generate,
  liveMatches,
  one,
  reportScore,
  rows,
  setClock,
  tick,
  upNext,
} from './harness';

const START = new Date('2026-11-07T13:00:00Z'); // 8:00 am Eastern

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

/** An event with checked-in doubles teams named T1a/T1b, T2a/T2b, ... (seeded in order). */
async function eventWithTeams(tournamentId: string, name: string, teamCount: number, opts = {}) {
  const eventId = await addEvent(db, tournamentId, name, opts);
  const teams: string[] = [];
  for (let i = 1; i <= teamCount; i++) {
    const team = await addPair(db, eventId, [`${name[0]}${i}a`, `${name[0]}${i}b`], i);
    await checkIn(db, team);
    teams.push(team);
  }
  return { eventId, teams };
}

describe('score validation', () => {
  const winnerSlot = async (games: number[][], bestOf = 1) =>
    (await one(db, 'select private.match_winner_slot($1::jsonb, $2) as slot', [JSON.stringify(games), bestOf])).slot;

  // Formats differ (win by 2, hard caps, timed games), so unusual scores are
  // accepted; the screens ask the director to confirm them.
  it.each([
    [[[11, 9]], 1],
    [[[7, 11]], 2],
    [[[12, 14]], 2],
    [[[11, 0]], 1],
    [[[11, 10]], 1],
    [[[14, 15]], 2],
    [[[14, 11]], 1],
  ])('accepts %j', async (games, slot) => {
    expect(await winnerSlot(games)).toBe(slot);
  });

  it.each([
    [[[11, 11]], /tied/],
    [[[-1, 11]], /possible score/],
    [[[150, 3]], /possible score/],
    [[], /at least one game/],
  ])('rejects %j', async (games, message) => {
    await expect(winnerSlot(games)).rejects.toThrow(message);
  });

  it('plays best of 3 to two game wins', async () => {
    expect(await winnerSlot([[11, 9], [9, 11], [11, 7]], 3)).toBe(1);
    expect(await winnerSlot([[5, 11], [9, 11]], 3)).toBe(2);
    await expect(winnerSlot([[11, 9]], 3)).rejects.toThrow(/needs 2 game wins/);
    await expect(winnerSlot([[11, 9], [11, 7], [11, 3]], 3)).rejects.toThrow(/already won/);
  });
});

describe('court assignment', () => {
  it('fills every open court and texts all four players', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
    const { eventId } = await eventWithTeams(tournamentId, "Men's 3.5", 4);
    expect(await generate(db, eventId)).toBe(6);

    const live = await liveMatches(db, tournamentId);
    expect(live.map((m) => m.court_name)).toEqual(['Court 1', 'Court 2']);
    expect(live.every((m) => m.round === 1)).toBe(true);

    const texts = await rows(db, 'select * from public.notifications order by id');
    expect(texts).toHaveLength(8);
    for (const text of texts) {
      expect(text.body).toMatch(
        /^Your match is ready on COURT [12] versus \S+\/\S+\. One game to \d+, win by 2\. Promptly report your scores here: \{url\} when finished\.$/,
      );
    }
  });

  it('waits for check-in', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const eventId = await addEvent(db, tournamentId, "Women's 3.0");
    const a = await addPair(db, eventId, ['Adams', 'Bell']);
    const b = await addPair(db, eventId, ['Cruz', 'Diaz']);
    await generate(db, eventId);
    await checkIn(db, a);

    expect(await liveMatches(db, tournamentId)).toHaveLength(0);
    expect((await upNext(db, tournamentId))[0].blocked_reason).toBe('not_checked_in');

    await checkIn(db, b);
    expect(await liveMatches(db, tournamentId)).toHaveLength(1);
  });

  it('holds an event until its start time', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const { eventId } = await eventWithTeams(tournamentId, 'Mixed 3.5', 2, { notBefore: addMinutes(START, 120) });
    await generate(db, eventId);
    expect((await upNext(db, tournamentId))[0].blocked_reason).toBe('event_not_started');

    await setClock(db, addMinutes(START, 120));
    await tick(db);
    expect(await liveMatches(db, tournamentId)).toHaveLength(1);
  });

  it('calls a team that just played as soon as its score is in (no rest period)', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const { eventId } = await eventWithTeams(tournamentId, "Men's 3.0", 3);
    await generate(db, eventId);

    // With 3 teams every match after the first includes a team that just played.
    const [first] = await liveMatches(db, tournamentId);
    await setClock(db, addMinutes(START, 15));
    await reportScore(db, first.id, [[11, 6]]);

    expect(await liveMatches(db, tournamentId)).toHaveLength(1);
    expect((await upNext(db, tournamentId)).map((m) => m.blocked_reason)).toEqual(['player_on_court']);
  });

  it('never puts a player in two events on court at once', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
    const mens = await addEvent(db, tournamentId, "Men's 4.0");
    const mixed = await addEvent(db, tournamentId, 'Mixed 4.0');
    const davis = await addPlayer(db, 'Alex', 'Davis');
    const teams = [
      await addTeam(db, mens, [davis, await addPlayer(db, 'Ben', 'Lee')]),
      await addPair(db, mens, ['Park', 'Cho']),
      await addTeam(db, mixed, [davis, await addPlayer(db, 'Cara', 'Moss')]),
      await addPair(db, mixed, ['Ng', 'Ruiz']),
    ];
    for (const team of teams) await checkIn(db, team);
    await generate(db, mens);
    await generate(db, mixed);

    const live = await liveMatches(db, tournamentId);
    expect(live).toHaveLength(1);
    expect((await upNext(db, tournamentId))[0].blocked_reason).toBe('player_on_court');

    await setClock(db, addMinutes(START, 20));
    await reportScore(db, live[0].id, [[11, 8]]);
    expect(await upNext(db, tournamentId)).toHaveLength(0);
    expect(await liveMatches(db, tournamentId)).toHaveLength(1);
  });

  describe('overdue holds', () => {
    // Men's match M needs Adams and Cruz. Adams is on court in mixed; Cruz's
    // mixed match X becomes playable at checkInX. Once M is overdue (ready 30+
    // minutes), Cruz is held for M instead of being sent to X.
    async function scenario(checkInX: number) {
      const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
      await db.query('update public.tournaments set overdue_after_minutes = 30 where id = $1', [tournamentId]);
      const adams = await addPlayer(db, 'Al', 'Adams');
      const cruz = await addPlayer(db, 'Cy', 'Cruz');

      const mixed1 = await addEvent(db, tournamentId, 'Mixed A');
      await checkIn(db, await addTeam(db, mixed1, [adams, await addPlayer(db, 'Eve', 'Eng')]));
      await checkIn(db, await addPair(db, mixed1, ['Fox', 'Gil']));
      await generate(db, mixed1);

      const mens = await addEvent(db, tournamentId, "Men's");
      await checkIn(db, await addTeam(db, mens, [adams, await addPlayer(db, 'Bo', 'Bell')]));
      await checkIn(db, await addTeam(db, mens, [cruz, await addPlayer(db, 'Dan', 'Diaz')]));
      await generate(db, mens);

      const mixed2 = await addEvent(db, tournamentId, 'Mixed B');
      await checkIn(db, await addTeam(db, mixed2, [cruz, await addPlayer(db, 'Hal', 'Hu')]));
      const lateTeam = await addPair(db, mixed2, ['King', 'Lowe']);
      await generate(db, mixed2);

      await setClock(db, addMinutes(START, checkInX));
      await checkIn(db, lateTeam);
      return { tournamentId, mens };
    }

    it('lets other events use a player while the match is not overdue', async () => {
      const { tournamentId } = await scenario(20);
      expect(await liveMatches(db, tournamentId)).toHaveLength(2); // Mixed A and Mixed B both on court
    });

    it('holds players for an overdue match until it is played', async () => {
      const { tournamentId, mens } = await scenario(40);
      expect(await liveMatches(db, tournamentId)).toHaveLength(1); // a court stays free

      const queue = await upNext(db, tournamentId);
      const mensMatch = queue.find((q) => q.event_name === "Men's")!;
      const mixedB = queue.find((q) => q.event_name === 'Mixed B')!;
      expect([mensMatch.blocked_reason, mensMatch.overdue]).toEqual(['player_on_court', true]);
      expect(mixedB.blocked_reason).toBe('player_needed_elsewhere');

      const [mixedA] = await liveMatches(db, tournamentId);
      await setClock(db, addMinutes(START, 45));
      await reportScore(db, mixedA.id, [[11, 4]]);
      await setClock(db, addMinutes(START, 55));
      await tick(db);

      const live = await liveMatches(db, tournamentId);
      expect(live.map((m) => m.event_id)).toEqual([mens]);
    });
  });
});

describe('the queue', () => {
  async function oneCourtRoundRobin(teamCount = 4) {
    const setup = await createLiveTournament(db, { courts: 1, start: START });
    const { eventId, teams } = await eventWithTeams(setup.tournamentId, 'Open', teamCount);
    await generate(db, eventId);
    return { ...setup, eventId, teams };
  }

  const queueLabels = async (tournamentId: string) =>
    (await upNext(db, tournamentId)).map((q) => `${q.team1_name} v ${q.team2_name}`);

  it('sends the top match out and pulls the next one when a score comes in', async () => {
    const { tournamentId } = await oneCourtRoundRobin();
    const queue = await upNext(db, tournamentId);
    expect(queue.map((q) => q.queue_rank)).toEqual([1, 2, 3, 4, 5]);

    const [onCourt] = await liveMatches(db, tournamentId);
    await reportScore(db, onCourt.id, [[11, 5]]);
    const [next] = await liveMatches(db, tournamentId);
    expect(next.id).toBe(queue[0].match_id);
  });

  it('lets the director move a match to the top, hold it, and rebuild the order', async () => {
    const { tournamentId } = await oneCourtRoundRobin();
    const before = await upNext(db, tournamentId);
    const last = before.at(-1)!;

    await db.query('select public.move_in_queue($1, $2)', [last.match_id, before[0].match_id]);
    let queue = await upNext(db, tournamentId);
    expect(queue[0].match_id).toBe(last.match_id);

    await db.query('select public.hold_match($1, true)', [last.match_id]);
    queue = await upNext(db, tournamentId);
    expect(queue[0].blocked_reason).toBe('on_hold');

    const [onCourt] = await liveMatches(db, tournamentId);
    await reportScore(db, onCourt.id, [[11, 5]]);
    const [next] = await liveMatches(db, tournamentId);
    expect(next.id).toBe(before[0].match_id); // held match skipped, keeps its spot

    await db.query('select public.hold_match($1, false)', [last.match_id]);
    await db.query('select public.rebuild_queue($1)', [tournamentId]);
    queue = await upNext(db, tournamentId);
    expect(queue.at(-1)!.match_id).toBe(last.match_id);
  });

  it('moves a match to the bottom', async () => {
    const { tournamentId } = await oneCourtRoundRobin();
    const before = await upNext(db, tournamentId);
    await db.query('select public.move_in_queue($1, null)', [before[0].match_id]);
    expect((await upNext(db, tournamentId)).at(-1)!.match_id).toBe(before[0].match_id);
  });

  it('pauses and resumes the whole tournament', async () => {
    const { tournamentId } = await oneCourtRoundRobin();
    await db.query('select public.set_auto_assign($1, false)', [tournamentId]);
    const [onCourt] = await liveMatches(db, tournamentId);
    await reportScore(db, onCourt.id, [[11, 5]]);
    expect(await liveMatches(db, tournamentId)).toHaveLength(0);

    await db.query('select public.set_auto_assign($1, true)', [tournamentId]);
    expect(await liveMatches(db, tournamentId)).toHaveLength(1);
  });

  it('sends a chosen match to a chosen court, even out of order', async () => {
    const setup = await createLiveTournament(db, { courts: 2, start: START });
    const { eventId } = await eventWithTeams(setup.tournamentId, 'Open', 6);
    await db.query('select public.set_auto_assign($1, false)', [setup.tournamentId]);
    await generate(db, eventId);
    const queue = await upNext(db, setup.tournamentId);
    const court2 = await one(db, `select id from public.courts where name = 'Court 2'`);

    await db.query('select public.assign_match_to_court($1, $2)', [queue.at(-1)!.match_id, court2.id]);
    const live = await liveMatches(db, setup.tournamentId);
    expect([live[0].id, live[0].court_name]).toEqual([queue.at(-1)!.match_id, 'Court 2']);

    // Same players can't go out twice.
    const clash = queue.find(
      (q) => q.match_id !== live[0].match_id && [q.team1_id, q.team2_id].some((t) => [live[0].team1_id, live[0].team2_id].includes(t)),
    )!;
    const court1 = await one(db, `select id from public.courts where name = 'Court 1'`);
    await expect(db.query('select public.assign_match_to_court($1, $2)', [clash.match_id, court1.id])).rejects.toThrow(
      /another court/,
    );
  });

  it('moves a live match to another court, swapping when that court is busy', async () => {
    const setup = await createLiveTournament(db, { courts: 3, start: START });
    const { eventId } = await eventWithTeams(setup.tournamentId, 'Open', 4);
    await generate(db, eventId); // two matches: Courts 1 and 2
    const [onOne, onTwo] = await liveMatches(db, setup.tournamentId);
    const court = async (name: string) => (await one(db, 'select id from public.courts where name = $1', [name])).id;

    await db.query('select public.move_match_to_court($1, $2)', [onOne.id, await court('Court 2')]);
    let live = await liveMatches(db, setup.tournamentId);
    expect(live.map((m) => [m.id, m.court_name])).toEqual([
      [onTwo.id, 'Court 1'],
      [onOne.id, 'Court 2'],
    ]);

    await db.query('select public.move_match_to_court($1, $2)', [onOne.id, await court('Court 3')]);
    live = await liveMatches(db, setup.tournamentId);
    expect(live.find((m) => m.id === onOne.id)!.court_name).toBe('Court 3');
    expect((await rows(db, `select * from public.notifications where kind = 'court_changed'`)).length).toBeGreaterThan(0);
  });
});

describe('courts', () => {
  it('can be added and removed during play', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
    const { eventId } = await eventWithTeams(tournamentId, 'Open', 8);
    await generate(db, eventId);
    expect(await liveMatches(db, tournamentId)).toHaveLength(2);

    await db.query('select public.set_court_count($1, 4)', [tournamentId]);
    expect((await liveMatches(db, tournamentId)).map((m) => m.court_name)).toEqual([
      'Court 1',
      'Court 2',
      'Court 3',
      'Court 4',
    ]);

    // Removing courts 2-4: their matches go back to the queue; courts with history are kept, retired.
    const [first] = await liveMatches(db, tournamentId);
    await reportScore(db, first.id, [[11, 3]]);
    await db.query('select public.set_court_count($1, 1)', [tournamentId]);
    const board = await rows(db, 'select * from public.court_board where tournament_id = $1', [tournamentId]);
    expect(board.map((c) => c.court_name)).toEqual(['Court 1']);
    expect((await upNext(db, tournamentId)).length).toBeGreaterThan(3);

    await db.query('select public.set_court_count($1, 3)', [tournamentId]);
    const names = (await rows(db, 'select name from public.court_board join public.courts on courts.id = court_id where court_board.tournament_id = $1 order by court_board.sort_order', [tournamentId])).map((c) => c.name);
    expect(names).toEqual(['Court 1', 'Court 2', 'Court 3']);
  });
});

describe('formats', () => {
  it('snake-seeds teams into pools', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 4, start: START });
    const { eventId, teams } = await eventWithTeams(tournamentId, 'Open', 8, { pools: 2 });
    expect(await generate(db, eventId)).toBe(12); // two pools of 4: 6 matches each

    const pools = await rows(db, 'select id, pool from public.teams where event_id = $1', [eventId]);
    const poolOf = (team: string) => pools.find((p) => p.id === team)!.pool;
    expect(teams.map(poolOf)).toEqual([1, 2, 2, 1, 1, 2, 2, 1]);
  });

  it('plays pools, ranks them, then seeds a bracket that avoids same-pool semis', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 4, start: START });
    const { eventId, teams } = await eventWithTeams(tournamentId, 'Open', 8, {
      format: 'pools_to_bracket',
      pools: 2,
      advancePerPool: 2,
    });
    expect(await generate(db, eventId)).toBe(12 + 3);

    const semis = await rows(db, `select * from public.match_details where event_id = $1 and stage = 'bracket' order by round, position`, [eventId]);
    expect(semis.map((m) => `${m.label}: ${m.team1_name} v ${m.team2_name}`)).toEqual([
      'Semifinal 1: Seed 1 v Seed 4',
      'Semifinal 2: Seed 2 v Seed 3',
      'Final: Winner of Semifinal 1 v Winner of Semifinal 2',
    ]);

    // Better seed always wins. Pool A games are close (11-9), pool B blowouts
    // (11-0), so B's runner-up outranks A's and would meet A's winner in a semi.
    const seedOf = (team: string) => teams.indexOf(team) + 1;
    for (let guard = 0; guard < 20; guard++) {
      const live = (await liveMatches(db, tournamentId)).filter((m) => m.stage === 'pool');
      if (live.length === 0) break;
      for (const m of live) {
        const loserScore = m.pool === 1 ? 9 : 0;
        await reportScore(db, m.id, [seedOf(m.team1_id) < seedOf(m.team2_id) ? [11, loserScore] : [loserScore, 11]]);
      }
    }

    const standings = await rows(db, 'select * from public.standings where event_id = $1 order by pool, pool_rank', [eventId]);
    expect(standings.filter((s) => s.pool === 1).map((s) => seedOf(s.team_id))).toEqual([1, 4, 5, 8]);
    expect(standings.filter((s) => s.pool === 2).map((s) => seedOf(s.team_id))).toEqual([2, 3, 6, 7]);
    expect(standings[0]).toMatchObject({ played: 3, wins: 3, losses: 0, pool_rank: 1 });

    const bracket = await rows(db, `select * from public.match_details where event_id = $1 and stage = 'bracket' order by round, position`, [eventId]);
    const poolOfTeam = new Map(standings.map((s) => [s.team_id, s.pool]));
    for (const semi of bracket.slice(0, 2)) {
      expect(semi.status).not.toBe('waiting');
      expect(poolOfTeam.get(semi.team1_id)).not.toBe(poolOfTeam.get(semi.team2_id));
    }
    expect([seedOf(bracket[0].team1_id), seedOf(bracket[1].team1_id)].sort()).toEqual([1, 2]);
  });

  it('gives top seeds byes in a straight bracket and moves winners through to the final', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 3, start: START });
    const { eventId, teams: seeds } = await eventWithTeams(tournamentId, 'Open', 6, { format: 'single_elim' });
    expect(await generate(db, eventId)).toBe(5);

    const bracket = await rows(db, 'select * from public.matches where event_id = $1 order by round, position', [eventId]);
    const byLabel = Object.fromEntries(bracket.map((m) => [m.label, m]));
    expect(Object.keys(byLabel).sort()).toEqual(
      ['Final', 'Quarterfinal 2', 'Quarterfinal 4', 'Semifinal 1', 'Semifinal 2'].sort(),
    );
    expect(byLabel['Semifinal 1'].team1_id).toBe(seeds[0]);
    expect(byLabel['Semifinal 2'].team1_id).toBe(seeds[1]);
    expect([byLabel['Quarterfinal 2'].team1_id, byLabel['Quarterfinal 2'].team2_id]).toEqual([seeds[3], seeds[4]]);
    expect([byLabel['Quarterfinal 4'].team1_id, byLabel['Quarterfinal 4'].team2_id]).toEqual([seeds[2], seeds[5]]);

    let live = await liveMatches(db, tournamentId);
    expect(live.map((m) => m.label).sort()).toEqual(['Quarterfinal 2', 'Quarterfinal 4']);
    await setClock(db, addMinutes(START, 20));
    for (const m of live) await reportScore(db, m.id, [[8, 11]]);

    await setClock(db, addMinutes(START, 30));
    await tick(db);
    live = await liveMatches(db, tournamentId);
    expect(live.map((m) => [m.label, m.team1_id, m.team2_id])).toEqual(
      expect.arrayContaining([
        ['Semifinal 1', seeds[0], seeds[4]],
        ['Semifinal 2', seeds[1], seeds[5]],
      ]),
    );

    await setClock(db, addMinutes(START, 50));
    for (const m of live) await reportScore(db, m.id, [[11, 5]]);
    await setClock(db, addMinutes(START, 60));
    await tick(db);
    const [final] = await liveMatches(db, tournamentId);
    expect([final.label, final.team1_id, final.team2_id]).toEqual(['Final', seeds[0], seeds[1]]);
    expect((await reportScore(db, final.id, [[9, 11]])).winner_team_id).toBe(seeds[1]);
  });

  it('can clear and regenerate an event before play starts', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    await db.query('select public.set_auto_assign($1, false)', [tournamentId]);
    const { eventId } = await eventWithTeams(tournamentId, 'Open', 4);
    await generate(db, eventId);
    await db.query('select public.clear_matches($1)', [eventId]);
    await db.query(`update public.events set format = 'single_elim' where id = $1`, [eventId]);
    expect(await generate(db, eventId)).toBe(3);
  });
});

describe('director tools', () => {
  async function oneMatchOnOneCourt(courts = 1) {
    const setup = await createLiveTournament(db, { courts, start: START });
    const { eventId, teams } = await eventWithTeams(setup.tournamentId, 'Open', 2);
    await generate(db, eventId);
    const [match] = await liveMatches(db, setup.tournamentId);
    return { ...setup, a: teams[0], b: teams[1], match };
  }

  it('shows the no-show deadline on the court board', async () => {
    const { tournamentId, match } = await oneMatchOnOneCourt();
    const board = await one(db, 'select * from public.court_board where tournament_id = $1', [tournamentId]);
    expect(board.match_id).toBe(match.id);
    expect(board.no_show_deadline.getTime()).toBe(addMinutes(START, 10).getTime());

    await db.query('select public.confirm_on_court($1)', [match.id]);
    expect((await liveMatches(db, tournamentId))[0].status).toBe('in_progress');
  });

  it('requeues a no-show and waits for the absent team to check in again', async () => {
    const { tournamentId, b, match } = await oneMatchOnOneCourt();
    await setClock(db, addMinutes(START, 11));
    await db.query('select public.requeue_match($1, $2)', [match.id, b]);

    expect(await liveMatches(db, tournamentId)).toHaveLength(0);
    expect((await upNext(db, tournamentId))[0].blocked_reason).toBe('not_checked_in');

    await checkIn(db, b);
    expect(await liveMatches(db, tournamentId)).toHaveLength(1);
  });

  it('moves a match off a paused court', async () => {
    const { tournamentId, match } = await oneMatchOnOneCourt(2);
    expect(match.court_name).toBe('Court 1');
    await db.query('select public.set_court_out_of_service($1, true)', [match.court_id]);

    const [moved] = await liveMatches(db, tournamentId);
    expect([moved.id, moved.court_name]).toEqual([match.id, 'Court 2']);
  });

  it('awards a forfeit', async () => {
    const { a, match } = await oneMatchOnOneCourt();
    const done = await one(db, 'select * from public.forfeit_match($1, $2)', [match.id, a]);
    expect([done.status, done.forfeit, done.winner_team_id]).toEqual(['completed', true, a]);
  });

  it('corrects a score, moving the right team on if the next match has not started', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const { eventId, teams } = await eventWithTeams(tournamentId, 'Open', 4, { format: 'single_elim' });
    await generate(db, eventId);
    const [semi1] = await liveMatches(db, tournamentId);
    await reportScore(db, semi1.id, [[11, 4]]);
    const final = await one(db, `select * from public.matches where event_id = $1 and label = 'Final'`, [eventId]);
    expect(final.team1_id).toBe(semi1.team1_id);

    const fixed = await one(db, 'select * from public.correct_score($1, $2::jsonb)', [semi1.id, '[[4, 11]]']);
    expect(fixed.winner_team_id).toBe(semi1.team2_id);
    expect((await one(db, 'select team1_id from public.matches where id = $1', [final.id])).team1_id).toBe(semi1.team2_id);
    expect(teams).toContain(semi1.team2_id);
  });

  it('bumps the live revision that screens subscribe to', async () => {
    const { tournamentId, match } = await oneMatchOnOneCourt();
    const before = (await one(db, 'select revision from public.tournament_live where tournament_id = $1', [tournamentId])).revision;
    await reportScore(db, match.id, [[11, 4]]);
    const after = (await one(db, 'select revision from public.tournament_live where tournament_id = $1', [tournamentId])).revision;
    expect(Number(after)).toBeGreaterThan(Number(before));
  });
});

describe('access rules', () => {
  it('lets anyone read the court board but not player contact details', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
    await actAs(db, null);
    await asRole(db, 'anon', async () => {
      expect(await rows(db, 'select * from public.court_board where tournament_id = $1', [tournamentId])).toHaveLength(2);
      await expect(rows(db, 'select * from public.players')).rejects.toThrow(/permission denied/);
      await expect(rows(db, `update public.matches set status = 'completed'`)).rejects.toThrow(/permission denied/);
    });
  });

  it('hides draft tournaments from the public', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    await db.query(`update public.tournaments set status = 'draft' where id = $1`, [tournamentId]);
    await actAs(db, null);
    await asRole(db, 'anon', async () => {
      expect(await rows(db, 'select * from public.tournaments')).toHaveLength(0);
    });
  });

  it('keeps each organization’s tournaments to its own directors', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const { eventId } = await eventWithTeams(tournamentId, 'Open', 2);
    const other = await createOrganization(db); // signs in as the other club's owner
    await asRole(db, 'authenticated', async () => {
      await expect(db.query('select public.generate_matches($1)', [eventId])).rejects.toThrow(/Only tournament staff/);
      await expect(db.query('select public.set_court_count($1, 5)', [tournamentId])).rejects.toThrow(/Only tournament staff/);
      await expect(rows(db, 'update public.events set name = $2 where id = $1 returning id', [eventId, 'Hijacked'])).resolves.toHaveLength(0);
      const created = await one(db, 'select * from public.create_tournament($1, $2, $3, $4)', [other.organizationId, 'Their Open', '2026-12-01', 4]);
      expect(created.organization_id).toBe(other.organizationId);
    });
  });

  it('lets directors edit their tournament, events, teams and courts directly', async () => {
    const { tournamentId, director } = await createLiveTournament(db, { courts: 2, start: START });
    await actAs(db, director);
    await asRole(db, 'authenticated', async () => {
      await db.query('update public.tournaments set name = $2, entry_fee_cents = 4250 where id = $1', [tournamentId, 'Renamed']);
      const e = await one(db, `insert into public.events (tournament_id, name) values ($1, 'Open') returning id`, [tournamentId]);
      await db.query(`update public.events set pool_count = 2 where id = $1`, [e.id]);
      const t = await one(db, `insert into public.teams (event_id, name) values ($1, 'Davis/Lee') returning id`, [e.id]);
      await db.query(`update public.teams set seed = 1 where id = $1`, [t.id]);
      await db.query(`update public.courts set name = 'Center Court' where tournament_id = $1 and name = 'Court 1'`, [tournamentId]);
      await db.query('delete from public.events where id = $1', [e.id]);
    });
    const live = await one(db, 'select revision from public.tournament_live where tournament_id = $1', [tournamentId]);
    expect(Number(live.revision)).toBeGreaterThan(5);
  });

  it('lets players in the match report its score, and nobody else', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const eventId = await addEvent(db, tournamentId, 'Open');
    const playerUser = await createUser(db);
    const a = await addTeam(db, eventId, [await addPlayer(db, 'Alex', 'Davis', playerUser), await addPlayer(db, 'Ben', 'Lee')]);
    const b = await addPair(db, eventId, ['Park', 'Cho']);
    await checkIn(db, a);
    await checkIn(db, b);
    await generate(db, eventId);
    const [match] = await liveMatches(db, tournamentId);

    await actAs(db, await createUser(db));
    await asRole(db, 'authenticated', async () => {
      await expect(reportScore(db, match.id, [[11, 2]])).rejects.toThrow(/Only players in this match/);
    });

    await actAs(db, playerUser);
    await asRole(db, 'authenticated', async () => {
      expect((await reportScore(db, match.id, [[11, 2]])).winner_team_id).toBe(a);
    });
  });
});
