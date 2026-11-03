import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, addEvent, createDb, createLiveTournament, createUser, one, rows } from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const emailed = async (email: string) => {
  const { id } = await one(db, 'insert into auth.users (email) values ($1) returning id', [email]);
  return id as string;
};
const staff = async (t: string) => (await one(db, 'select public.is_tournament_staff($1) as v', [t])).v;
const mine = () => rows(db, 'select * from public.my_tournaments()');

describe('18 and older', () => {
  const ago = (years: number, days = 0) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  it('refuses a younger birth date on a profile and at registration', async () => {
    await actAs(db, await emailed('kid@example.test'));
    const save = (birth: string) =>
      db.query('select public.save_my_profile($1::jsonb)', [JSON.stringify({ first_name: 'K', last_name: 'D', birth_date: birth })]);
    await expect(save(ago(18, 2))).rejects.toThrow(/18 or older/);
    await save(ago(18, -2));

    const { director, tournamentId } = await createLiveTournament(db, { courts: 1, start: new Date() });
    const eventId = await addEvent(db, tournamentId, 'Open');
    await actAs(db, director);
    await db.query(`update public.events set kind = 'singles' where id = $1`, [eventId]);
    const register = (birth: string | null) =>
      db.query('select public.start_registration($1, $2::jsonb, $3::jsonb)', [
        tournamentId,
        JSON.stringify({ first_name: 'K', last_name: 'D', email: `k${birth}@example.test`, birth_date: birth }),
        JSON.stringify([{ event_id: eventId }]),
      ]);
    await expect(register(ago(17))).rejects.toThrow(/18 or older/);
    await register(ago(18, -2));
    await register(null);
    expect(await rows(db, `select 1 from public.players where email = $1`, [`k${ago(17)}@example.test`])).toEqual([]);
  });
});

describe('one account', () => {
  it('owns what it creates, with no organization needed', async () => {
    const me = await emailed('pat@example.test');
    await actAs(db, me);
    await db.query(`select public.save_my_profile('{"first_name":"Pat","last_name":"Davis"}'::jsonb)`);
    const t = await one(db, 'select * from public.new_tournament(null)');
    expect(t.created_by).toBe(me);
    expect(await staff(t.id)).toBe(true);
    expect(await mine()).toMatchObject([{ id: t.id, role: 'owner' }]);
    const [owner] = await rows(db, 'select * from public.tournament_team($1)', [t.id]);
    expect(owner).toMatchObject({ email: 'pat@example.test', is_owner: true, is_me: true });
    const org = await one(db, 'select o.name from public.organizations o where o.id = $1', [t.organization_id]);
    expect(org.name).toBe('Pat Davis Tournaments');
  });

  it('runs a tournament it’s added to as manager, and isn’t staff of others', async () => {
    const { director, tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const eventId = await addEvent(db, tournamentId, 'Open');
    const manager = await emailed('sam@example.test');

    await actAs(db, manager);
    expect(await staff(tournamentId)).toBe(false);
    await expect(db.query('select public.set_auto_assign($1, false)', [tournamentId])).rejects.toThrow();
    expect(await mine()).toEqual([]);

    await actAs(db, director);
    expect((await one(db, `select public.add_tournament_staff($1, 'sam@example.test', 'admin') as r`, [tournamentId])).r).toBe('added');

    await actAs(db, manager);
    expect(await staff(tournamentId)).toBe(true);
    expect(await mine()).toMatchObject([{ id: tournamentId, role: 'admin' }]);
    await db.query('select public.set_auto_assign($1, false)', [tournamentId]);
    expect(eventId).toBeTruthy();

    await actAs(db, director);
    await db.query(`select public.remove_tournament_staff($1, 'sam@example.test')`, [tournamentId]);
    await actAs(db, manager);
    expect(await staff(tournamentId)).toBe(false);
  });

  it('gives an invite to an account that signs up later', async () => {
    const { director, tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    await actAs(db, director);
    expect((await one(db, `select public.add_tournament_staff($1, 'new@example.test', 'admin') as r`, [tournamentId])).r).toBe('invited');
    await actAs(db, await emailed('new@example.test'));
    await db.query('select public.claim_staff_invites()');
    expect(await staff(tournamentId)).toBe(true);
  });

  it('keeps a profile with the account, private to it', async () => {
    const a = await emailed('a@example.test');
    const b = await emailed('b@example.test');
    await actAs(db, a);
    expect((await one(db, 'select public.get_my_profile() as p')).p).toBeNull();
    await db.query(`select public.save_my_profile('{"first_name":"Al","last_name":"One","gender":"male","email":"spoof@example.test"}'::jsonb)`);
    await db.query(`select public.save_my_profile('{"first_name":"Al","last_name":"Two","birth_date":"1985-06-15"}'::jsonb)`);
    const p = (await one(db, 'select public.get_my_profile() as p')).p;
    expect(p).toMatchObject({ first_name: 'Al', last_name: 'Two', email: 'a@example.test', birth_date: '1985-06-15', gender: null });
    await actAs(db, b);
    expect((await one(db, 'select public.get_my_profile() as p')).p).toBeNull();
    await actAs(db, null);
    await expect(db.query(`select public.save_my_profile('{"first_name":"X","last_name":"Y"}'::jsonb)`)).rejects.toThrow(/Log in/);
    expect(await createUser(db)).toBeTruthy();
  });
});

describe('bot sign-ups', () => {
  const check = async (email: string) =>
    (await one(db, `select public.before_user_created(jsonb_build_object('user', jsonb_build_object('email', $1::text))) as r`, [email])).r;

  it('refuses Gmail addresses with three or more dots, and nothing else', async () => {
    for (const bad of ['a.r.d.a.dkf@gmail.com', 'x.y.z.w@googlemail.com', 'A.B.C.D+tag@GMAIL.com']) {
      expect((await check(bad)).error).toMatchObject({ http_code: 400 });
    }
    for (const good of ['pat.davis@gmail.com', 'mary.jo.smith@gmail.com', 'a.b.c.d@example.com', 'pat+x.y.z.w@gmail.com', 'ardadkf@gmail.com']) {
      expect(await check(good)).toEqual({});
    }
  });
});
