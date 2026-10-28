import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, addEvent, addPair, checkIn, createDb, createLiveTournament, generate, liveMatches, one, reportScore, rows } from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

interface Options {
  format?: 'round_robin' | 'pools_to_bracket' | 'single_elim';
  pools?: number;
  advancePerPool?: number;
  bracketSize?: number | null;
  bracketType?: 'single' | 'double' | 'medal';
  poolPlay?: 'round_robin' | 'swiss';
  maxRounds?: number | null;
}

/** A live tournament with one division of checked-in teams seeded 1..n. */
async function division(teamCount: number, opts: Options = {}) {
  const { tournamentId } = await createLiveTournament(db, { courts: 12, start: START });
  const eventId = await addEvent(db, tournamentId, 'Open', {
    format: opts.format ?? 'pools_to_bracket',
    pools: opts.pools ?? 1,
    advancePerPool: opts.advancePerPool ?? 2,
  });
  await db.query(
    `update public.events set bracket_size = $2, bracket_type = $3, pool_play = $4, max_rounds = $5 where id = $1`,
    [eventId, opts.bracketSize ?? null, opts.bracketType ?? 'single', opts.poolPlay ?? 'round_robin', opts.maxRounds ?? null],
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

/** Plays every match that reaches a court (the better seed wins) while `stage` lasts. */
async function play(tournamentId: string, seedOf: (team: string) => number, stage?: 'pool' | 'bracket') {
  for (let guard = 0; guard < 60; guard++) {
    const live = (await liveMatches(db, tournamentId)).filter((m) => !stage || m.stage === stage);
    if (live.length === 0) return;
    for (const m of live) {
      await reportScore(db, m.id, [seedOf(m.team1_id) < seedOf(m.team2_id) ? [11, 6] : [6, 11]]);
    }
  }
  throw new Error('never finished');
}

const poolMatches = (eventId: string) =>
  rows(db, `select * from public.matches where event_id = $1 and stage = 'pool' order by round, position`, [eventId]);
const bracketTeams = async (eventId: string) =>
  (
    await rows(
      db,
      `select unnest(array[team1_id, team2_id]) as team from public.matches
       where event_id = $1 and stage = 'bracket' and team1_seed is not null`,
      [eventId],
    )
  )
    .map((r) => r.team)
    .filter(Boolean);

describe('standings tiebreaks', () => {
  it('ranks by win percentage, then head-to-head, then point differential', async () => {
    const { tournamentId, eventId, teams } = await division(5, { format: 'round_robin' });
    const [a, b, c, d, e] = teams;
    await db.query('update public.teams set pool = 1 where event_id = $1', [eventId]);
    // Pool play ended early, so A has played more than B.
    const results: [string, string, number, number][] = [
      [b, a, 11, 9], // B beats A
      [a, c, 11, 0],
      [a, d, 11, 5],
      [e, a, 11, 9],
      [e, b, 11, 0],
    ];
    for (const [i, [winner, loser, w, l]] of results.entries()) {
      await db.query(
        `insert into public.matches (tournament_id, event_id, stage, pool, round, position, label, team1_id, team2_id,
                                     status, winner_team_id, games, wave, queue_seq)
         values ($1, $2, 'pool', 1, $3::int, 1, 'Round', $4, $5, 'completed', $4, $6::jsonb, $3::int, $3::int)`,
        [tournamentId, eventId, i + 1, winner, loser, JSON.stringify([[w, l]])],
      );
    }
    const order = (await rows(db, 'select team_id from public.standings where event_id = $1 order by pool_rank', [eventId])).map(
      (r) => r.team_id,
    );
    // A (2-2, +13) and B (1-1, -9) are both .500: B won their match, so B is ahead.
    // C and D are both 0-1 and didn't play each other: D lost by less.
    expect(order).toEqual([e, b, a, d, c]);
  });
});

describe('teams in the bracket', () => {
  it('3 pools of 5 with 8 in the bracket: the top 2 of each pool and the 2 best third-place teams', async () => {
    const { tournamentId, eventId, seedOf } = await division(15, { pools: 3, bracketSize: 8 });
    expect(await generate(db, eventId)).toBe(3 * 10 + 7);
    await play(tournamentId, seedOf, 'pool');

    const standings = await rows(db, 'select team_id, pool_rank from public.standings where event_id = $1', [eventId]);
    const rank = new Map(standings.map((s) => [s.team_id, s.pool_rank]));
    const seeded = await bracketTeams(eventId);
    expect(seeded).toHaveLength(8);
    expect(seeded.map((t) => rank.get(t)).sort()).toEqual([1, 1, 1, 2, 2, 2, 3, 3]);
  });

  it('can change before the bracket is seeded, and rebuilds it', async () => {
    const { eventId } = await division(12, { pools: 3, advancePerPool: 2 });
    expect(await generate(db, eventId)).toBe(3 * 6 + 5);
    expect((await one(db, 'select public.set_bracket_size($1, 8) as n', [eventId])).n).toBe(7);
    expect(await one(db, 'select bracket_size, advance_per_pool from public.events where id = $1', [eventId])).toEqual({
      bracket_size: 8,
      advance_per_pool: 2,
    });
    await expect(db.query('select public.set_bracket_size($1, 13)', [eventId])).rejects.toThrow(/only 12 teams/);
  });

  it('one pool of 15 can stop after a set number of rounds', async () => {
    const { eventId } = await division(15, { format: 'round_robin', maxRounds: 5 });
    // 15 teams: 7 matches a round, one team sits out.
    expect(await generate(db, eventId)).toBe(5 * 7);
  });
});

describe('straight to the medal matches', () => {
  it('2 pools: the pool winners play for gold and the runners-up for bronze', async () => {
    const { tournamentId, eventId, seedOf } = await division(8, { pools: 2, advancePerPool: 2, bracketType: 'medal' });
    expect(await generate(db, eventId)).toBe(2 * 6 + 2);
    await play(tournamentId, seedOf, 'pool');

    const standings = await rows(db, 'select team_id, pool, pool_rank from public.standings where event_id = $1', [eventId]);
    const of = new Map(standings.map((s) => [s.team_id, s]));
    const medal = await rows(db, `select * from public.matches where event_id = $1 and stage = 'bracket'`, [eventId]);
    const final = medal.find((m) => m.round_key === 'final')!;
    const bronze = medal.find((m) => m.round_key === 'bronze')!;
    expect(medal).toHaveLength(2);
    for (const [m, place] of [[final, 1], [bronze, 2]] as const) {
      const [a, b] = [of.get(m.team1_id)!, of.get(m.team2_id)!];
      expect([a.pool_rank, b.pool_rank]).toEqual([place, place]);
      expect(a.pool).not.toBe(b.pool);
    }

    await play(tournamentId, seedOf);
    const done = await rows(db, `select status from public.matches where event_id = $1`, [eventId]);
    expect(done.every((m) => m.status === 'completed')).toBe(true);
  });

  it('needs 4 teams in the bracket, or 2 for gold only', async () => {
    const { eventId } = await division(9, { pools: 3, advancePerPool: 1, bracketType: 'medal' });
    await expect(generate(db, eventId)).rejects.toThrow(/Medal matches need 4/);
    await db.query('update public.events set bracket_size = 2 where id = $1', [eventId]);
    expect(await generate(db, eventId)).toBe(3 * 3 + 1);
  });
});

describe('Swiss rounds', () => {
  it('draws each round from the standings, with no rematches, then seeds the bracket', async () => {
    const { tournamentId, eventId, seedOf } = await division(8, { poolPlay: 'swiss', maxRounds: 3, advancePerPool: 4 });
    // Round 1 now (top half against bottom half), the bracket waiting for seeds.
    expect(await generate(db, eventId)).toBe(4 + 3);
    const round1 = await poolMatches(eventId);
    expect(round1.map((m) => [seedOf(m.team1_id), seedOf(m.team2_id)])).toEqual([
      [1, 5],
      [2, 6],
      [3, 7],
      [4, 8],
    ]);

    await play(tournamentId, seedOf, 'pool');
    const all = await poolMatches(eventId);
    expect(all).toHaveLength(3 * 4);
    expect(all.every((m) => m.status === 'completed')).toBe(true);
    // Round 2 paired winners with winners.
    const round2 = all.filter((m) => m.round === 2).map((m) => [seedOf(m.team1_id), seedOf(m.team2_id)]);
    expect(round2).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ]);
    const pairs = all.map((m) => [m.team1_id, m.team2_id].sort().join());
    expect(new Set(pairs).size).toBe(pairs.length);

    // The bracket takes the top 4 of the final standings.
    const top4 = (await rows(db, 'select team_id from public.standings where event_id = $1 and pool_rank <= 4', [eventId])).map((r) => r.team_id);
    expect((await bracketTeams(eventId)).sort()).toEqual(top4.sort());
  });

  it('sits a different team out each round with an odd number of teams', async () => {
    const { tournamentId, eventId, seedOf, teams } = await division(7, { format: 'round_robin', poolPlay: 'swiss', maxRounds: 4 });
    expect(await generate(db, eventId)).toBe(3);
    await play(tournamentId, seedOf);
    const all = await poolMatches(eventId);
    expect(all).toHaveLength(4 * 3);
    const sitOuts = new Map<string, number>();
    for (let round = 1; round <= 4; round++) {
      const playing = all.filter((m) => m.round === round).flatMap((m) => [m.team1_id, m.team2_id]);
      const out = teams.filter((t) => !playing.includes(t));
      expect(out).toHaveLength(1);
      sitOuts.set(out[0], (sitOuts.get(out[0]) ?? 0) + 1);
    }
    expect([...sitOuts.values()].every((n) => n === 1)).toBe(true);
    // The lowest seed sits out first.
    expect(seedOf(teams.find((t) => !all.filter((m) => m.round === 1).some((m) => [m.team1_id, m.team2_id].includes(t)))!)).toBe(7);
  });

  it('ends after the round being played when the director ends pool play', async () => {
    const { tournamentId, eventId, seedOf } = await division(8, { poolPlay: 'swiss', maxRounds: 5, advancePerPool: 4 });
    await generate(db, eventId);
    const report = async () => {
      for (const m of await liveMatches(db, tournamentId)) {
        await reportScore(db, m.id, [seedOf(m.team1_id) < seedOf(m.team2_id) ? [11, 6] : [6, 11]]);
      }
    };
    await report(); // round 1; round 2 is drawn and goes on court
    expect((await liveMatches(db, tournamentId)).map((m) => m.round)).toEqual([2, 2, 2, 2]);

    // Nothing to cancel: round 2 is on court. It finishes, and no round 3 is drawn.
    expect((await one(db, 'select public.end_pool_play($1) as n', [eventId])).n).toBe(0);
    await report();
    expect(Math.max(...(await poolMatches(eventId)).map((m) => m.round))).toBe(2);
    expect(await bracketTeams(eventId)).toHaveLength(4);
    expect((await liveMatches(db, tournamentId)).every((m) => m.stage === 'bracket')).toBe(true);
  });

  it('needs a number of rounds that fits the teams', async () => {
    const { eventId } = await division(6, { poolPlay: 'swiss', maxRounds: null });
    await expect(generate(db, eventId)).rejects.toThrow(/how many Swiss rounds/);
    await db.query('update public.events set max_rounds = 6 where id = $1', [eventId]);
    await expect(generate(db, eventId)).rejects.toThrow(/at most 5 Swiss rounds/);
  });
});
