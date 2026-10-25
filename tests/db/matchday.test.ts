import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  actAs,
  addEvent,
  addPair,
  addPlayer,
  addTeam,
  checkIn,
  createDb,
  createLiveTournament,
  createUser,
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

describe('called means playing', () => {
  it('starts a match the moment it is called to a court', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const eventId = await addEvent(db, tournamentId, 'Open');
    for (const names of [['Able', 'Baker'], ['Cole', 'Dunn']] as [string, string][]) await checkIn(db, await addPair(db, eventId, names));
    await generate(db, eventId);
    const [m] = await liveMatches(db, tournamentId);
    expect(m.status).toBe('in_progress');
    expect(new Date(m.started_at).getTime()).toBe(new Date(m.assigned_at).getTime());
    const board = await one(db, 'select match_status, no_show_deadline from public.court_board where match_id = $1', [m.id]);
    expect(board.match_status).toBe('in_progress');
    // The score frees the court.
    expect((await reportScore(db, m.id, [[11, 6]])).status).toBe('completed');
    expect((await one(db, 'select count(*)::int as n from public.court_board where match_id is not null')).n).toBe(0);
  });

  it('swaps an alternate into a called match and texts the new players', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const eventId = await addEvent(db, tournamentId, 'Open');
    const a = await addPair(db, eventId, ['Able', 'Baker'], 1);
    const b = await addPair(db, eventId, ['Cole', 'Dunn'], 2);
    await checkIn(db, a);
    await checkIn(db, b);
    await generate(db, eventId);
    const alternate = await addPair(db, eventId, ['Ezra', 'Ford'], 3);
    await db.query('select public.replace_team($1, $2)', [a, alternate]);
    const [m] = await liveMatches(db, tournamentId);
    expect([m.team1_id, m.team2_id]).toContain(alternate);
    const texts = await rows(db, `select body from public.notifications where match_id = $1 and body like '%Cole/Dunn%'`, [m.id]);
    expect(texts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('players', () => {
  it('can report their score but not check in or edit their details', async () => {
    const { tournamentId, director } = await createLiveTournament(db, { courts: 1, start: START });
    const eventId = await addEvent(db, tournamentId, 'Open');
    const user = await createUser(db);
    const me = await addPlayer(db, 'Pat', 'Able', user);
    const team = await addTeam(db, eventId, [me, await addPlayer(db, 'Sam', 'Baker')]);
    const other = await addPair(db, eventId, ['Cole', 'Dunn']);

    await actAs(db, user);
    await expect(db.query('select public.check_in_team($1)', [team])).rejects.toThrow(/staff/i);
    await actAs(db, director);
    await checkIn(db, team);
    await checkIn(db, other);
    await generate(db, eventId);
    const [m] = await liveMatches(db, tournamentId);

    await actAs(db, user);
    await db.exec('set role authenticated');
    try {
      const updated = await rows(db, `update public.players set first_name = 'Hacker' where id = $1 returning id`, [me]);
      expect(updated).toHaveLength(0);
      expect((await one(db, 'select * from public.report_score($1, $2::jsonb)', [m.id, '[[11, 9]]'])).status).toBe('completed');
    } finally {
      await db.exec('reset role');
    }
  });
});

describe('advancing from pools', () => {
  async function poolsEvent() {
    const { tournamentId } = await createLiveTournament(db, { courts: 4, start: START, minRestMinutes: 0 });
    const eventId = await addEvent(db, tournamentId, 'Open', { format: 'pools_to_bracket', pools: 2, advancePerPool: 2 });
    for (let i = 1; i <= 8; i++) await checkIn(db, await addPair(db, eventId, [`T${i}a`, `T${i}b`], i));
    await generate(db, eventId);
    const bracket = () => rows(db, `select label from public.matches where event_id = $1 and stage = 'bracket' order by round, position`, [eventId]);
    return { tournamentId, eventId, bracket };
  }

  it('rebuilds the bracket when the director changes how many advance', async () => {
    const { eventId, bracket } = await poolsEvent();
    expect((await bracket()).map((m) => m.label)).toEqual(['Semifinal 1', 'Semifinal 2', 'Final']);
    await db.query('select public.set_advance_per_pool($1, 3)', [eventId]);
    expect((await bracket()).map((m) => m.label)).toEqual(['Quarterfinal 2', 'Quarterfinal 4', 'Semifinal 1', 'Semifinal 2', 'Final']);
    expect((await one(db, 'select advance_per_pool from public.events where id = $1', [eventId])).advance_per_pool).toBe(3);
    await expect(db.query('select public.set_advance_per_pool($1, 5)', [eventId])).rejects.toThrow(/smallest pool has 4/);
  });

  it('refuses once the bracket is seeded', async () => {
    const { tournamentId, eventId } = await poolsEvent();
    for (let guard = 0; guard < 20; guard++) {
      const live = (await liveMatches(db, tournamentId)).filter((m) => m.stage === 'pool');
      if (live.length === 0) break;
      for (const m of live) await reportScore(db, m.id, [[11, 5]]);
    }
    await expect(db.query('select public.set_advance_per_pool($1, 1)', [eventId])).rejects.toThrow(/already seeded/);
  });

  it('is for directors only', async () => {
    const { eventId } = await poolsEvent();
    await actAs(db, await createUser(db));
    await expect(db.query('select public.set_advance_per_pool($1, 1)', [eventId])).rejects.toThrow();
  });
});
