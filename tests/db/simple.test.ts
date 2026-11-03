import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, asRole, createDb, createOrganization, one, rows } from './harness';

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
