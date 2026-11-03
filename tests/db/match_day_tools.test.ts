import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, addEvent, addPair, buildSchedule, checkIn, createDb, createLiveTournament, createUser, generate, one, reportScore, rows } from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

async function setup() {
  const { director, tournamentId } = await createLiveTournament(db, { courts: 4, start: START });
  await db.query('update public.tournaments set auto_assign = false where id = $1', [tournamentId]);
  return { director, tournamentId };
}
const team = async (eventId: string, n: string, seed?: number) => addPair(db, eventId, [`${n}a`, `${n}b`], seed);
const teamsOf = (eventId: string) => rows(db, 'select id, seed, merged_from_event_id from public.teams where event_id = $1 order by seed', [eventId]);

describe('scores from paper', () => {
  it('lets staff score a queued match, but not its players', async () => {
    const created = await setup();
    const { tournamentId } = created;
    const eventId = await addEvent(db, tournamentId, 'Open');
    for (const n of ['A', 'B']) await checkIn(db, await team(eventId, n));
    await buildSchedule(db, eventId);
    await db.query('update public.events set started_at = now() where id = $1', [eventId]);
    const m = await one(db, 'select * from public.matches where event_id = $1', [eventId]);
    expect(m.status).toBe('queued');

    const playerUser = await createUser(db);
    await db.query('update public.players set user_id = $1 where id = (select player_id from public.team_players where team_id = $2 limit 1)', [playerUser, m.team1_id]);
    const { director } = created;
    await actAs(db, playerUser);
    await expect(db.query(`select public.report_score($1, '[[11,5]]'::jsonb)`, [m.id])).rejects.toThrow(/not on a court/);
    await actAs(db, director);
    const done = await one(db, `select * from public.report_score($1, '[[11,5]]'::jsonb)`, [m.id]);
    expect(done).toMatchObject({ status: 'completed', winner_team_id: m.team1_id, forfeit: false });
  });
});

describe('merging divisions', () => {
  it('moves teams and entries, seeds them after, and unmerges back with the same id', async () => {
    const { tournamentId } = await setup();
    const a = await addEvent(db, tournamentId, 'A');
    const b = await addEvent(db, tournamentId, 'B');
    const a1 = await team(a, 'A1', 1);
    const b1 = await team(b, 'B1', 1);
    const b2 = await team(b, 'B2', 2);
    const reg = await one(db, `insert into public.registrations (tournament_id, player_id, status, amount_cents)
      select $1, player_id, 'paid', 0 from public.team_players where team_id = $2 limit 1 returning id`, [tournamentId, b1]);
    await db.query('insert into public.registration_entries (registration_id, event_id, team_id) values ($1, $2, $3)', [reg.id, b, b1]);

    expect((await one(db, 'select public.merge_events($1, $2) as n', [b, a])).n).toBe(2);
    expect(await rows(db, 'select id from public.events where id = $1', [b])).toEqual([]);
    expect((await teamsOf(a)).map((t) => [t.id, t.seed])).toEqual([[a1, 1], [b1, 2], [b2, 3]]);
    expect((await one(db, 'select event_id from public.registration_entries where registration_id = $1', [reg.id])).event_id).toBe(a);
    expect(await rows(db, `select id from public.notifications where kind = 'division_merged'`)).toHaveLength(1);

    await db.query('select public.unmerge_event($1)', [b]);
    expect((await one(db, 'select name from public.events where id = $1', [b])).name).toBe('B');
    expect((await teamsOf(a)).map((t) => t.id)).toEqual([a1]);
    expect((await teamsOf(b)).map((t) => t.id).sort()).toEqual([b1, b2].sort());
    expect((await one(db, 'select event_id from public.registration_entries where registration_id = $1', [reg.id])).event_id).toBe(b);
    expect(await rows(db, 'select 1 from public.event_merges')).toEqual([]);
  });

  it('refuses singles into doubles, someone in both, a schedule, and non-staff', async () => {
    const { tournamentId } = await setup();
    const a = await addEvent(db, tournamentId, 'A');
    const b = await addEvent(db, tournamentId, 'B');
    const s = await addEvent(db, tournamentId, 'S');
    await db.query(`update public.events set kind = 'singles' where id = $1`, [s]);
    await expect(db.query('select public.merge_events($1, $2)', [s, a])).rejects.toThrow(/Singles and doubles/);

    const a1 = await team(a, 'A1');
    await team(a, 'A2');
    const b1 = await team(b, 'B1');
    const shared = await one(db, 'select player_id from public.team_players where team_id = $1 limit 1', [a1]);
    await db.query('update public.team_players set player_id = $1 where team_id = $2 and player_id = (select player_id from public.team_players where team_id = $2 limit 1)', [shared.player_id, b1]);
    await expect(db.query('select public.merge_events($1, $2)', [b, a])).rejects.toThrow(/entered in both/);

    await db.query('delete from public.teams where id = $1', [b1]);
    await buildSchedule(db, a);
    await expect(db.query('select public.merge_events($1, $2)', [b, a])).rejects.toThrow(/schedule/);
    await actAs(db, await createUser(db));
    await expect(db.query('select public.merge_events($1, $2)', [b, a])).rejects.toThrow();
  });
});

describe('self check-in', () => {
  it('finds a logged-in player by their account, in this tournament only', async () => {
    const { director, tournamentId } = await setup();
    const eventId = await addEvent(db, tournamentId, 'Open');
    const t = await addPair(db, eventId, ['Davis', 'Lee']);
    await db.query(`update public.players set email = 'Josh@Example.test' where id = (select player_id from public.team_players where team_id = $1 limit 1)`, [t]);
    await actAs(db, director);
    const code = (await one(db, 'select public.set_self_checkin($1, true) as c', [tournamentId])).c;

    await actAs(db, null);
    expect(await rows(db, 'select * from public.my_self_checkin($1)', [code])).toEqual([]);
    await actAs(db, (await one(db, `insert into auth.users (email) values ('someone@example.test') returning id`)).id);
    expect(await rows(db, 'select * from public.my_self_checkin($1)', [code])).toEqual([]);

    await actAs(db, (await one(db, `insert into auth.users (email) values ('josh@example.test') returning id`)).id);
    expect(await rows(db, `select * from public.my_self_checkin('wrong')`)).toEqual([]);
    const [me] = await rows(db, 'select * from public.my_self_checkin($1)', [code]);
    expect(me).toMatchObject({ checked_in: false });
    await db.query('select public.self_check_in($1, $2)', [code, me.player_id]);
    expect((await rows(db, 'select * from public.my_self_checkin($1)', [code]))[0].checked_in).toBe(true);
  });

  it('needs an account: players check only themselves in; staff find and check in anyone', async () => {
    const { director, tournamentId } = await setup();
    const eventId = await addEvent(db, tournamentId, 'Open');
    const t = await addPair(db, eventId, ['Davis', 'Lee']);
    await actAs(db, await createUser(db));
    await expect(db.query('select public.set_self_checkin($1, true)', [tournamentId])).rejects.toThrow(/staff/);
    await actAs(db, director);
    expect((await one(db, 'select public.get_self_checkin($1) as c', [tournamentId])).c).toBeNull();
    const code = (await one(db, 'select public.set_self_checkin($1, true) as c', [tournamentId])).c;
    const davis = (await one(db, `select tp.player_id from public.team_players tp join public.players p on p.id = tp.player_id
                                  where tp.team_id = $1 and p.last_name = 'Davis'`, [t])).player_id;

    // Signed out: the tournament's name only.
    await actAs(db, null);
    expect((await one(db, 'select public.self_checkin_info($1) as i', [code])).i).toEqual({ tournament_name: 'Test Open', staff: false });
    expect((await one(db, `select public.self_checkin_info('wrong') as i`)).i).toBeNull();
    expect(await rows(db, `select * from public.self_checkin_search($1, 'davis')`, [code])).toEqual([]);
    await expect(db.query('select public.self_check_in($1, $2)', [code, davis])).rejects.toThrow(/Log in/);

    // Someone else's account: not their player.
    await actAs(db, await createUser(db));
    expect(await rows(db, `select * from public.self_checkin_search($1, 'davis')`, [code])).toEqual([]);
    await expect(db.query('select public.self_check_in($1, $2)', [code, davis])).rejects.toThrow(/only check yourself/);

    // Their own account: yes.
    const josh = (await one(db, `insert into auth.users (email) values ('davis@example.test') returning id`)).id;
    await db.query(`update public.players set email = 'Davis@Example.test' where id = $1`, [davis]);
    await actAs(db, josh);
    await db.query('select public.self_check_in($1, $2)', [code, davis]);
    expect((await rows(db, 'select * from public.my_self_checkin($1)', [code]))[0].checked_in).toBe(true);

    // Staff: search by name, no contact details, check anyone in or out.
    await actAs(db, director);
    expect((await one(db, 'select public.self_checkin_info($1) as i', [code])).i.staff).toBe(true);
    expect(await rows(db, `select * from public.self_checkin_search($1, 'd')`, [code])).toEqual([]);
    expect(await rows(db, `select * from public.self_checkin_search('wrong', 'davis')`)).toEqual([]);
    const [found] = await rows(db, `select * from public.self_checkin_search($1, 'DAVIS')`, [code]);
    expect(Object.keys(found).sort()).toEqual(['checked_in', 'first_name', 'last_name', 'player_id', 'teams']);
    expect(found.checked_in).toBe(true);
    await db.query('select public.self_check_in($1, $2, false)', [code, found.player_id]);
    expect((await rows(db, `select * from public.self_checkin_search($1, 'davis')`, [code]))[0].checked_in).toBe(false);
    await expect(db.query(`select public.self_check_in('wrong', $1)`, [found.player_id])).rejects.toThrow(/isn’t on/);

    await db.query('select public.set_self_checkin($1, false)', [tournamentId]);
    await actAs(db, null);
    expect((await one(db, 'select public.self_checkin_info($1) as i', [code])).i).toBeNull();
  });
});

describe('player score entry', () => {
  it('a logged-in player in the match scores it, found by account or email; nobody else', async () => {
    const { director, tournamentId } = await setup();
    const eventId = await addEvent(db, tournamentId, 'Open');
    const mine = await team(eventId, 'A');
    await checkIn(db, mine);
    await checkIn(db, await team(eventId, 'B'));
    await generate(db, eventId);
    const match = (await one(db, 'select id from public.matches where event_id = $1 limit 1', [eventId])).id;
    const court = (await one(db, 'select id from public.courts where tournament_id = $1 order by sort_order limit 1', [tournamentId])).id;
    await actAs(db, director);
    await db.query('select public.assign_match_to_court($1, $2)', [match, court]);
    await db.query(`update public.players set email = 'pat@example.test' where id = (select player_id from public.team_players where team_id = $1 limit 1)`, [mine]);

    await actAs(db, await createUser(db));
    expect(await rows(db, 'select * from public.my_teams($1)', [tournamentId])).toEqual([]);
    await expect(reportScore(db, match, [[11, 4]])).rejects.toThrow(/Only players in this match/);

    await actAs(db, (await one(db, `insert into auth.users (email) values ('PAT@example.test') returning id`)).id);
    expect((await rows(db, 'select public.my_teams($1) as id', [tournamentId])).map((r) => r.id)).toEqual([mine]);
    expect((await reportScore(db, match, [[11, 4]])).status).toBe('completed');
  });
});
