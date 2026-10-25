import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, asRole, createDb, createLiveTournament, createUser, one, rows } from './harness';

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

async function demo(arrived = true) {
  const user = await createUser(db);
  await actAs(db, user);
  const id = (await one(db, 'select public.create_demo_tournament($1) as id', [arrived])).id as string;
  return { user, id };
}

const statusCounts = async (tournamentId: string) =>
  Object.fromEntries(
    (
      await rows(db, `select status, count(*)::int as n from public.matches where tournament_id = $1 group by status`, [
        tournamentId,
      ])
    ).map((r) => [r.status, r.n]),
  );

describe('demo tournaments', () => {
  it('builds a live demo with four divisions and fills the courts', async () => {
    const { id } = await demo();
    const t = await one(db, 'select status, is_demo from public.tournaments where id = $1', [id]);
    expect(t).toEqual({ status: 'live', is_demo: true });
    const events = await rows(db, 'select name, not_before from public.events where tournament_id = $1 order by sort_order', [id]);
    expect(events).toHaveLength(4);
    // Staggered start times through the day.
    expect(new Set(events.map((e) => new Date(e.not_before).getTime())).size).toBe(3);
    expect((await statusCounts(id)).in_progress).toBeGreaterThan(0);
  });

  it('plays forward: players arrive, matches finish, courts refill', async () => {
    const { id } = await demo(false);
    expect((await statusCounts(id)).in_progress ?? 0).toBe(0);
    await db.query('select public.advance_demo($1, 60)', [id]);
    await db.query('select public.advance_demo($1, 60)', [id]);
    const counts = await statusCounts(id);
    expect(counts.completed).toBeGreaterThan(5);
    expect(counts.in_progress ?? 0).toBeGreaterThan(0);
    const here = await one(db, 'select count(*)::int as n from public.player_checkins where tournament_id = $1', [id]);
    expect(here.n).toBeGreaterThan(30);
  });

  it('keeps the past in order when the clock moves', async () => {
    const { id } = await demo();
    const before = await one(db, `select min(assigned_at) as at from public.matches where tournament_id = $1`, [id]);
    await db.query('select public.advance_demo($1, 10)', [id]);
    const after = await one(
      db,
      `select assigned_at as at from public.matches where tournament_id = $1 and assigned_at is not null order by assigned_at limit 1`,
      [id],
    );
    expect(new Date(after.at).getTime()).toBeLessThanOrEqual(new Date(before.at).getTime() - 9 * 60_000);
  });

  it('only fast-forwards demo tournaments, and only for their staff', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: new Date() });
    await expect(db.query('select public.advance_demo($1, 5)', [tournamentId])).rejects.toThrow(/Only demo/);
    const { id } = await demo();
    await actAs(db, await createUser(db));
    await expect(db.query('select public.advance_demo($1, 5)', [id])).rejects.toThrow();
  });

  it('shows a demo team the texts its players got, with the score link', async () => {
    const { id } = await demo();
    const [m] = await rows(db, `select team1_id from public.matches where tournament_id = $1 and status = 'in_progress' limit 1`, [id]);
    await actAs(db, null);
    const inbox = await asRole(db, 'anon', () => rows(db, 'select * from public.demo_inbox($1)', [m.team1_id]));
    expect(inbox.length).toBeGreaterThan(0);
    expect(inbox[0].body).toMatch(/Your match is ready on COURT \d+ .* here: \/s\/\w+ when finished\./);

    await db.query('select private.log_demo_texts()');
    const logged = await one(db, `select count(*)::int as n from public.notifications where tournament_id = $1 and channel is null`, [id]);
    expect(logged.n).toBe(0);
  });
});

describe('demo clean-up', () => {
  it('deletes practice tournaments after two weeks, and their made-up players', async () => {
    const { id } = await demo();
    expect(await one(db, 'select private.clean_up_demo_tournaments() as n')).toEqual({ n: 0 });
    await db.query(`update public.tournaments set created_at = now() - interval '15 days' where id = $1`, [id]);
    expect(await one(db, 'select private.clean_up_demo_tournaments() as n')).toEqual({ n: 1 });
    expect(await one(db, `select count(*)::int as n from public.players where email like '%@players.test'`)).toEqual({ n: 0 });
  });
});
