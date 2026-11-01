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
