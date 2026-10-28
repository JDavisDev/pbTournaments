import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, asRole, createDb, createOrganization, createUser, generate, one, reportScore, rows, setClock } from './harness';

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const asUser = <T>(fn: () => Promise<T>) => asRole(db, 'authenticated', fn);
const newTournament = (org: string | null) => asUser(() => one(db, 'select * from public.new_tournament($1)', [org]));

describe('new tournament', () => {
  it('on a demo site: "Demo #N" today, 4 courts, one Mixed Doubles 3.5 division', async () => {
    await db.query('update private.site set demo = true');
    await actAs(db, await createUser(db));
    const first = await newTournament(null);
    const second = await newTournament(null);
    expect([first.name, second.name]).toEqual(['Demo #1', 'Demo #2']);
    expect(first).toMatchObject({ status: 'draft', is_demo: true });
    const today = (await one(db, `select (now() at time zone 'America/New_York')::date::text as d`)).d;
    expect(first.starts_on.toISOString().slice(0, 10)).toBe(today);

    expect((await one(db, 'select count(*)::int as n from public.courts where tournament_id = $1', [first.id])).n).toBe(4);
    const events = await rows(db, 'select * from public.events where tournament_id = $1', [first.id]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'Mixed Doubles 3.5', kind: 'doubles', gender: 'mixed', skill_rule: 'only', dupr_rated: true });
  });

  it('elsewhere: a draft in the director’s organization for them to name and date', async () => {
    const { organizationId } = await createOrganization(db);
    const t = await newTournament(organizationId);
    expect(t).toMatchObject({ name: 'New tournament', is_demo: false, organization_id: organizationId });
    await expect(newTournament(null)).rejects.toThrow(/Choose an organization/);
    await actAs(db, await createUser(db));
    await expect(newTournament(organizationId)).rejects.toThrow(/Only members/);
  });
});

describe('divisions', () => {
  async function demoTournament() {
    await db.query('update private.site set demo = true');
    const director = await createUser(db);
    await actAs(db, director);
    const t = await newTournament(null);
    const event = (await one(db, 'select id from public.events where tournament_id = $1', [t.id])).id as string;
    return { director, tournamentId: t.id as string, event };
  }

  it('copies a division with all of its settings, not its teams', async () => {
    const { tournamentId, event } = await demoTournament();
    await db.query(
      `update public.events set min_age = 50, format = 'round_robin', max_rounds = 5, dupr_rated = false,
         not_before = '2026-11-07T15:00:00Z', court_ids = array[(select id from public.courts where tournament_id = $2 limit 1)]
       where id = $1`,
      [event, tournamentId],
    );
    await asUser(() => db.query('select public.add_mock_teams($1, 4)', [event]));
    const copy = await asUser(() => one(db, 'select * from public.copy_event($1)', [event]));
    const original = await one(db, 'select * from public.events where id = $1', [event]);

    const { id: _a, name: n1, sort_order: s1, created_at: _c1, ...settings } = original;
    const { id: _b, name: n2, sort_order: s2, created_at: _c2, ...copied } = copy;
    expect(copied).toEqual(settings);
    expect(n2).toBe(`${n1} (copy)`);
    expect(s2).toBeGreaterThan(s1);
    expect(await rows(db, 'select * from public.teams where event_id = $1', [copy.id])).toEqual([]);
  });

  it('fills a division with mock teams who can enter it', async () => {
    const { tournamentId, event } = await demoTournament();
    const womens = (
      await one(
        db,
        `insert into public.events (tournament_id, name, kind, gender, skill_rule, skill_level, min_age, max_age, age_basis)
         values ($1, 'Women''s 4.0+ 50-59', 'doubles', 'womens', 'and_above', 4.0, 50, 59, 'year_end') returning id`,
        [tournamentId],
      )
    ).id;
    const singles = (
      await one(db, `insert into public.events (tournament_id, name, kind) values ($1, 'Open Singles', 'singles') returning id`, [
        tournamentId,
      ])
    ).id;

    for (const e of [event, womens, singles]) {
      expect((await asUser(() => one(db, 'select public.add_mock_teams($1, 4) as n', [e]))).n).toBe(4);
    }
    await asUser(() => db.query('select public.add_mock_teams($1, 4)', [event]));
    const seeds = await rows(db, 'select seed from public.teams where event_id = $1 order by seed', [event]);
    expect(seeds.map((s) => s.seed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // Every mock player passes the division's own entry rules.
    const problems = await rows(
      db,
      `select e.name, p.gender, p.birth_date, p.dupr_doubles,
              private.entry_problem(e, t, p.gender, p.birth_date, p.dupr_doubles, p.dupr_singles, null, p.dupr_id) as problem
       from public.events e join public.tournaments t on t.id = e.tournament_id
       join public.teams tm on tm.event_id = e.id join public.team_players tp on tp.team_id = tm.id
       join public.players p on p.id = tp.player_id
       where e.tournament_id = $1`,
      [tournamentId],
    );
    expect(problems).toHaveLength(8 * 2 + 4 * 2 + 4);
    expect(problems.filter((p) => p.problem !== null)).toEqual([]);
    // Mixed teams are a man and a woman.
    const mixed = await rows(
      db,
      `select array_agg(p.gender order by p.gender) as g from public.teams tm join public.team_players tp on tp.team_id = tm.id
       join public.players p on p.id = tp.player_id where tm.event_id = $1 group by tm.id`,
      [event],
    );
    expect(mixed.every((m) => m.g.join() === 'female,male')).toBe(true);
    // Partners have different last names.
    const names = await rows(db, 'select name from public.teams where event_id = $1', [event]);
    expect(names.every((t) => t.name.split('/')[0] !== t.name.split('/')[1])).toBe(true);
  });

  it('keeps mock players out of real tournaments', async () => {
    const { organizationId } = await createOrganization(db);
    const t = await newTournament(organizationId);
    const event = (await one(db, 'select id from public.events where tournament_id = $1', [t.id])).id;
    await expect(asUser(() => db.query('select public.add_mock_teams($1)', [event]))).rejects.toThrow(/practice tournaments/);
  });

  it('leaves divisions that aren’t DUPR rated out of the DUPR results', async () => {
    const { director, tournamentId, event } = await demoTournament();
    const unrated = (await asUser(() => one(db, 'select * from public.copy_event($1)', [event]))).id;
    await db.query('update public.events set dupr_rated = false where id = $1', [unrated]);
    for (const e of [event, unrated]) {
      await asUser(() => db.query('select public.add_mock_teams($1, 4)', [e]));
      await generate(db, e);
    }
    await db.query(`update public.tournaments set status = 'live' where id = $1`, [tournamentId]);
    await setClock(db, new Date());
    for (const m of await rows(db, `select id from public.matches where tournament_id = $1 and team1_id is not null and team2_id is not null and stage = 'pool'`, [tournamentId])) {
      await db.query(`update public.matches set status = 'in_progress', court_id = (select id from public.courts where tournament_id = $2 limit 1) where id = $1`, [m.id, tournamentId]);
      await reportScore(db, m.id, [[11, 5]]);
    }
    // Only final divisions go to DUPR.
    await db.query(`update public.events set finalized_at = now() where tournament_id = $1`, [tournamentId]);
    await actAs(db, director);
    const results = await asUser(() => rows(db, 'select event_id from public.dupr_results($1)', [tournamentId]));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.event_id === event)).toBe(true);
  });
});
