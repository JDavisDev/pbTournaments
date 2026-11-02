import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, addPlayer, asRole, createDb, createUser, one } from './harness';

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const save = (endpoint: string) =>
  asRole(db, 'authenticated', () => db.query(`select public.save_push_subscription($1, 'key', 'auth')`, [endpoint]));
const targets = async (player: string) => (await one(db, 'select public.push_targets($1) as r', [player])).r;

describe('match alerts', () => {
  it('reaches a player through their account, and forgets phones that are gone', async () => {
    const user = await createUser(db);
    const player = await addPlayer(db, 'Jo', 'Alert', user);
    const stranger = await addPlayer(db, 'No', 'Phone');
    await actAs(db, user);
    await save('https://push.example/1');
    await save('https://push.example/2');

    expect((await targets(player)).map((t: { endpoint: string }) => t.endpoint).sort()).toEqual([
      'https://push.example/1',
      'https://push.example/2',
    ]);
    expect(await targets(stranger)).toEqual([]);
    expect(await asRole(db, 'authenticated', () => one(db, 'select public.my_push_subscriptions() as r'))).toMatchObject({
      r: [{ auth: 'auth' }, { auth: 'auth' }],
    });

    await db.query(`select public.push_sent('["https://push.example/1"]', '["https://push.example/2"]')`);
    expect(await targets(player)).toHaveLength(1);
  });

  it('needs a signed-in account, and only removes your own phones', async () => {
    await actAs(db, null);
    await expect(save('https://push.example/1')).rejects.toThrow(/Log in/);
    const a = await createUser(db);
    const b = await createUser(db);
    await actAs(db, a);
    await save('https://push.example/1');
    await actAs(db, b);
    await asRole(db, 'authenticated', () => db.query(`select public.delete_push_subscription('https://push.example/1')`));
    expect((await one(db, 'select count(*)::int as n from public.push_subscriptions')).n).toBe(1);
    await expect(asRole(db, 'authenticated', () => db.query(`select public.push_targets(gen_random_uuid())`))).rejects.toThrow(/permission denied/);
  });
});
