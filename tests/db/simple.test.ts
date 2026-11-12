import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, asRole, createDb, createOrganization, createUser, generate, one, rows } from './harness';

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const asUser = <T>(fn: () => Promise<T>) => asRole(db, 'authenticated', fn);
const team = (a: string, b: string) => ({
  name: `${a}/${b}`,
  players: [
    { first_name: 'Pat', last_name: a },
    { first_name: 'Sam', last_name: b },
  ],
});

async function simpleTournament() {
  const { owner, organizationId } = await createOrganization(db);
  const t = await asUser(() => one(db, 'select * from public.new_simple_tournament($1)', [organizationId]));
  const event = (await one(db, 'select id from public.events where tournament_id = $1', [t.id])).id as string;
  return { owner, t, event };
}

const addTeams = (event: string, teams: unknown[], firstSeed = 1) =>
  asUser(() => one<{ n: number }>(db, 'select public.add_teams($1, $2::jsonb, $3) as n', [event, JSON.stringify(teams), firstSeed]));

describe('pasted teams', () => {
  it('adds every team or none', async () => {
    const { event } = await simpleTournament();
    expect((await addTeams(event, [team('Davis', 'Lee'), team('Park', 'Cho')])).n).toBe(2);
    await expect(addTeams(event, [team('Ruiz', 'Shah'), { name: 'Nobody', players: [] }], 3)).rejects.toThrow(/one to four names/);
    const teams = await rows(db, 'select name, seed from public.teams where event_id = $1 order by seed', [event]);
    expect(teams).toEqual([
      { name: 'Davis/Lee', seed: 1 },
      { name: 'Park/Cho', seed: 2 },
    ]);
  });
});

describe('simple tournaments', () => {
  it('are free, check everyone in, and take no registrations or notifications', async () => {
    const { t, event } = await simpleTournament();
    expect(t).toMatchObject({ simple: true, texts_enabled: false, checkin_grace_minutes: null, entry_fee_cents: 0 });
    await addTeams(event, [team('Davis', 'Lee'), team('Park', 'Cho')]);
    expect((await one(db, 'select count(*)::int as n from public.teams where event_id = $1 and checked_in_at is null', [event])).n).toBe(0);

    const fees = await asUser(() => one<{ f: Record<string, number> }>(db, 'select public.tournament_fees($1) as f', [t.id]));
    expect(fees.f).toMatchObject({ setup_due_cents: 0, player_fees_cents: 0, fees_owed_cents: 0, uncovered_players: 0 });
    // Published without paying a setup fee.
    await asUser(() => db.query(`select public.set_tournament_status($1, 'registration')`, [t.id]));

    const player = (await one(db, 'select player_id from public.team_players tp join public.teams tm on tm.id = tp.team_id where tm.event_id = $1 limit 1', [event])).player_id;
    await expect(
      db.query('insert into public.registrations (tournament_id, player_id, amount_cents) values ($1, $2, 0)', [t.id, player]),
    ).rejects.toThrow(/doesn’t take registrations/);
    await db.query(`insert into public.notifications (tournament_id, player_id, kind, via, body) values ($1, $2, 'message', 'email', 'Hi')`, [t.id, player]);
    expect((await one(db, 'select count(*)::int as n from public.notifications where tournament_id = $1', [t.id])).n).toBe(0);
  });

  it('let anyone with the link score a match on court once the director allows it', async () => {
    const { owner, t, event } = await simpleTournament();
    await addTeams(event, [team('Davis', 'Lee'), team('Park', 'Cho'), team('Ruiz', 'Shah'), team('Kim', 'Bell')]);
    await asUser(() => db.query('select public.start_event($1)', [event]));
    const match = (await one(db, `select id from public.matches where event_id = $1 and status = 'in_progress' limit 1`, [event])).id;

    await actAs(db, null);
    const score = () => asRole(db, 'anon', () => db.query(`select public.report_score($1, '[[11, 7]]'::jsonb)`, [match]));
    await expect(score()).rejects.toThrow(/Only players in this match or tournament staff/);
    await actAs(db, owner);
    await asUser(() => db.query('update public.tournaments set anyone_scores = true where id = $1', [t.id]));
    await actAs(db, null);
    await score();
    expect((await one(db, 'select status from public.matches where id = $1', [match])).status).toBe('completed');
  });
});

describe('Basic tournament check-in', () => {
  const notHere = (event: string) =>
    one<{ n: number }>(db, 'select count(*)::int as n from public.teams where event_id = $1 and checked_in_at is null', [event]);

  it('is optional: on clears check-ins and new teams wait for the desk, off checks everyone in', async () => {
    const { t, event } = await simpleTournament();
    await addTeams(event, [team('Davis', 'Lee')]);
    expect((await notHere(event)).n).toBe(0);

    await asUser(() => db.query('select public.set_basic_checkin($1, true)', [t.id]));
    expect((await notHere(event)).n).toBe(1);
    await addTeams(event, [team('Park', 'Cho')], 2);
    expect((await notHere(event)).n).toBe(2);

    const player = (await one(db, `select player_id from public.team_players tp join public.teams tm on tm.id = tp.team_id
                                   where tm.event_id = $1 and tm.name = 'Davis/Lee' limit 1`, [event])).player_id;
    await asUser(() => db.query('select public.check_in_player($1, $2, true)', [t.id, player]));
    expect((await one(db, 'select count(*)::int as n from public.player_checkins where tournament_id = $1', [t.id])).n).toBe(1);

    await asUser(() => db.query('select public.set_basic_checkin($1, false)', [t.id]));
    expect((await notHere(event)).n).toBe(0);
  });

  it('only exists at Basic tournaments', async () => {
    const { organizationId } = await createOrganization(db);
    const t = await asUser(() => one(db, 'select * from public.new_tournament($1)', [organizationId]));
    await expect(asUser(() => db.query('select public.set_basic_checkin($1, true)', [t.id]))).rejects.toThrow(/Only Basic/);
  });
});

describe('platform admins', () => {
  it('run every tournament in an organization they own for free', async () => {
    const { owner, organizationId } = await createOrganization(db);
    const t = await asUser(() => one(db, 'select * from public.new_tournament($1)', [organizationId]));
    const fees = () => asUser(() => one<{ f: Record<string, unknown> }>(db, 'select public.tournament_fees($1) as f', [t.id]));
    expect((await fees()).f).toMatchObject({ fees_waived: false });
    expect(((await fees()).f.setup_due_cents as number) > 0).toBe(true);

    await db.query('insert into private.platform_admins (user_id) values ($1)', [owner]);
    expect((await fees()).f).toMatchObject({ fees_waived: true, setup_due_cents: 0, player_fees_cents: 0 });
  });
});

describe('standalone Basic tournaments', () => {
  it('need no organization: the creator runs, shares and deletes it', async () => {
    const me = (await one(db, `insert into auth.users (email) values ('td@example.test') returning id`)).id;
    await actAs(db, me);
    const t = await asUser(() => one(db, 'select * from public.new_simple_tournament(null)'));
    expect(t).toMatchObject({ organization_id: null, simple: true, entry_fee_cents: 0 });
    expect((await one(db, 'select count(*)::int as n from public.organization_members where user_id = $1', [me])).n).toBe(0);

    const event = (await one(db, 'select id from public.events where tournament_id = $1', [t.id])).id as string;
    expect((await addTeams(event, [team('Davis', 'Lee')])).n).toBe(1);
    const mine = await asUser(() => rows(db, 'select id, role from public.my_tournaments()'));
    expect(mine).toEqual([{ id: t.id, role: 'owner' }]);

    // Someone else can't touch it.
    await actAs(db, await createUser(db));
    await expect(addTeams(event, [team('Park', 'Cho')], 2)).rejects.toThrow(/staff/);

    // The only one running it can't delete their account until it's over.
    await actAs(db, me);
    await expect(asUser(() => db.query('select public.delete_my_account()'))).rejects.toThrow(/only one running/);

    await asUser(() => db.query('delete from public.tournaments where id = $1', [t.id]));
    expect((await one(db, 'select count(*)::int as n from public.tournaments where id = $1', [t.id])).n).toBe(0);
  });

  it('only Basic tournaments can stand alone', async () => {
    const me = await createUser(db);
    await actAs(db, me);
    await expect(
      db.query(`insert into public.tournaments (name, starts_on, created_by) values ('Open', current_date, $1)`, [me]),
    ).rejects.toThrow(/tournaments_organization_or_basic/);
  });
});

describe('cleaning up Basic tournaments', () => {
  it('deletes only ones started over 14 days ago and never finished', async () => {
    // Each made by its own owner, who stays signed in while it's filled in.
    const started = async () => {
      const { event, t } = await simpleTournament();
      await db.query(`update public.events set format = 'round_robin' where id = $1`, [event]);
      await addTeams(event, [team('Davis', 'Lee'), team('Park', 'Cho'), team('Ruiz', 'Shah')]);
      await generate(db, event);
      return { event, t };
    };
    const { event: abandoned, t: a } = await started();
    const { event: played, t: b } = await started();
    const { event: marked, t: c } = await started();
    const { event: recent, t: d } = await started();
    const { t: draft } = await simpleTournament();
    await db.query(`update public.events set started_at = now() - interval '20 days' where id = any($1)`, [[abandoned, played, marked]]);
    await db.query(`update public.events set started_at = now() - interval '3 days' where id = $1`, [recent]);
    await db.query(`update public.matches set status = 'completed' where event_id = $1`, [played]);
    await db.query(`update public.tournaments set status = 'complete' where id = $1`, [c.id]);

    await db.query('select private.clean_up_demo_tournaments()');
    const left = (await rows(db, 'select id from public.tournaments')).map((r) => r.id);
    expect(left).not.toContain(a.id);
    expect(left).toEqual(expect.arrayContaining([b.id, c.id, d.id, draft.id]));
  });
});
