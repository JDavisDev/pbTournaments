import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, addEvent, addPair, addPlayer, addTeam, asRole, buildSchedule, createDb, createLiveTournament, createUser, one, rows } from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

async function divisions() {
  const { tournamentId } = await createLiveTournament(db, { courts: 4, start: START });
  const low = await addEvent(db, tournamentId, 'Low');
  const high = await addEvent(db, tournamentId, 'High');
  await db.query(`update public.events set skill_rule = 'only', skill_level = 3.5, rating_source = 'dupr' where id = $1`, [low]);
  await db.query(`update public.events set skill_rule = 'only', skill_level = 4.0, rating_source = 'dupr' where id = $1`, [high]);
  return { tournamentId, low, high };
}

const rate = async (teamId: string, doubles: number) =>
  db.query(
    `update public.players set dupr_doubles = $2, dupr_id = upper(substr(md5(id::text), 1, 6))
     where id in (select player_id from public.team_players where team_id = $1)`,
    [teamId, doubles],
  );
const options = (team: string) => rows(db, 'select * from public.team_move_options($1)', [team]);
const moveTeam = (team: string, to: string) => one(db, 'select public.move_team($1, $2) as r', [team, to]).then((x) => x.r);
const problems = (tournamentId: string, team: string) =>
  rows(db, 'select problems from public.division_eligibility($1) where team_id = $2', [tournamentId, team]).then((r) => r[0].problems);

describe('moving a team', () => {
  it('moves a team with no registration, and tells its players', async () => {
    const { low, high } = await divisions();
    const team = await addPair(db, low, ['A', 'B'], 3);
    await rate(team, 4.2);
    await db.query(`update public.players set email = 'x@x.test' where id in (select player_id from public.team_players where team_id = $1)`, [team]);

    const [high_option] = await options(team);
    expect(high_option).toMatchObject({ event_id: high, problems: [], blocked: null, clears_schedule: false });
    expect(await moveTeam(team, high)).toEqual({ problems: [], cleared: [] });

    expect(await one(db, 'select event_id, seed, pool from public.teams where id = $1', [team])).toEqual({ event_id: high, seed: null, pool: null });
    expect(await rows(db, `select kind from public.notifications where kind = 'division_moved'`)).toHaveLength(2);
  });

  it('warns but allows a team outside the rules', async () => {
    const { low, high } = await divisions();
    const team = await addPair(db, low, ['A', 'B']);
    await rate(team, 3.6);
    expect((await options(team))[0].problems).toHaveLength(2);
    expect((await moveTeam(team, high)).problems).toHaveLength(2);
  });

  it('clears a schedule built ahead of time, in both divisions', async () => {
    const { low, high } = await divisions();
    const team = await addPair(db, low, ['A', 'B']);
    await addPair(db, low, ['C', 'D']);
    await addPair(db, low, ['E', 'F']);
    await addPair(db, high, ['G', 'H']);
    await addPair(db, high, ['I', 'J']);
    await buildSchedule(db, low);
    await buildSchedule(db, high);

    expect((await options(team))[0].clears_schedule).toBe(true);
    expect((await moveTeam(team, high)).cleared).toEqual(['Low', 'High']);
    expect(await rows(db, 'select id from public.matches')).toEqual([]);
  });

  it('refuses once either division has started, or when it can’t fit the team', async () => {
    const { tournamentId, low, high } = await divisions();
    const team = await addPair(db, low, ['A', 'B']);
    await addPair(db, low, ['C', 'D']);
    const singles = await addEvent(db, tournamentId, 'Singles');
    await db.query(`update public.events set kind = 'singles' where id = $1`, [singles]);
    await expect(moveTeam(team, singles)).rejects.toThrow(/singles division/);

    await buildSchedule(db, low);
    await db.query('update public.events set started_at = now() where id = $1', [low]);
    await expect(moveTeam(team, high)).rejects.toThrow(/already started/);

    const other = await addPair(db, high, ['E', 'F']);
    await expect(moveTeam(other, low)).rejects.toThrow(/already started/);
  });

  it('refuses when a player is already in the new division', async () => {
    const { low, high } = await divisions();
    const shared = await addPlayer(db, 'Sam', 'Both');
    const team = await addTeam(db, low, [shared, await addPlayer(db, 'A', 'A')]);
    await addTeam(db, high, [shared, await addPlayer(db, 'B', 'B')]);
    expect((await options(team))[0].blocked).toMatch(/Sam Both already entered High/);
    await expect(moveTeam(team, high)).rejects.toThrow(/Sam Both/);
  });

  it('is for staff only', async () => {
    const { low, high } = await divisions();
    const team = await addPair(db, low, ['A', 'B']);
    await actAs(db, await createUser(db));
    await expect(asRole(db, 'authenticated', () => moveTeam(team, high))).rejects.toThrow(/Only tournament staff/);
  });
});

describe('refreshing ratings', () => {
  it('reports what changed and flags whoever no longer fits', async () => {
    const { tournamentId, low } = await divisions();
    const team = await addPair(db, low, ['A', 'B']);
    await rate(team, 3.6);
    expect(await problems(tournamentId, team)).toEqual([]);

    const list = await rows(db, 'select * from public.dupr_refresh_list($1)', [tournamentId]);
    expect(list).toHaveLength(2);
    const result = (
      await one(db, 'select public.import_dupr_ratings($1, $2::jsonb) as r', [
        tournamentId,
        JSON.stringify([{ dupr_id: list[0].dupr_id, doubles: 4.1 }, { player_id: list[1].player_id, doubles: 3.6 }, { dupr_id: 'ZZZZZZ', doubles: 3 }]),
      ])
    ).r;
    expect(result.updated).toBe(2);
    expect(result.unknown).toEqual(['ZZZZZZ']);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ player_id: list[0].player_id, doubles_from: 3.6, doubles_to: 4.1 });

    expect((await problems(tournamentId, team)).join()).toMatch(/rated under 4/);
    expect((await one(db, 'select ratings_refreshed_at from public.tournaments where id = $1', [tournamentId])).ratings_refreshed_at).not.toBeNull();
  });

  it('flags a waiting entry outside the rules', async () => {
    const { tournamentId, low } = await divisions();
    const player = await addPlayer(db, 'Solo', 'Player');
    await db.query(`update public.players set dupr_doubles = 4.5 where id = $1`, [player]);
    const reg = await one(db, `insert into public.registrations (tournament_id, player_id, status, amount_cents) values ($1, $2, 'paid', 0) returning id`, [tournamentId, player]);
    await db.query('insert into public.registration_entries (registration_id, event_id) values ($1, $2)', [reg.id, low]);
    const found = await rows(db, 'select * from public.entry_eligibility($1)', [tournamentId]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ player_name: 'Solo Player', event_id: low });
  });
});
