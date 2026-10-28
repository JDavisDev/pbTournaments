import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, asRole, createDb, createUser, rows } from './harness';

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const listing = {
  name: 'Lone Star Fall Classic',
  starts_on: '2026-11-14',
  ends_on: '2026-11-15',
  venue: 'Austin Pickleball Center',
  city: 'Austin',
  state: 'TX',
  signup_url: 'https://pickleballtournaments.com/tournaments/lone-star-fall-classic',
};

/** Posts a listing as this user, through the API role. */
async function post(userId: string, fields: Record<string, unknown> = listing) {
  await actAs(db, userId);
  const columns = Object.keys(fields);
  return asRole(db, 'authenticated', async () =>
    (
      await rows(
        db,
        `insert into public.tournament_listings (${columns.join(', ')})
         values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
        Object.values(fields),
      )
    )[0],
  );
}

describe('tournament listings', () => {
  it('anyone signed in can post one, and everyone can read it', async () => {
    const poster = await createUser(db);
    const row = await post(poster);
    expect(row.created_by).toBe(poster);
    expect(row.last_day).toEqual(new Date('2026-11-15T00:00:00Z'));

    await actAs(db, null);
    const seen = await asRole(db, 'anon', () => rows(db, 'select name, state from public.tournament_listings'));
    expect(seen).toEqual([{ name: 'Lone Star Fall Classic', state: 'TX' }]);
  });

  it('a one-day listing lasts through its start day', async () => {
    const row = await post(await createUser(db), { ...listing, ends_on: null });
    expect(row.last_day).toEqual(new Date('2026-11-14T00:00:00Z'));
  });

  it('the public cannot post', async () => {
    await actAs(db, null);
    await expect(
      asRole(db, 'anon', () =>
        db.query(
          `insert into public.tournament_listings (name, starts_on, city, state, signup_url)
           values ('Spam Open', '2026-11-14', 'Austin', 'TX', 'https://example.com')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('a poster cannot claim someone else’s name on a listing', async () => {
    const poster = await createUser(db);
    const other = await createUser(db);
    await expect(post(poster, { ...listing, created_by: other })).rejects.toThrow(/permission denied/);
  });

  it('only the poster edits or deletes it', async () => {
    const poster = await createUser(db);
    const other = await createUser(db);
    const row = await post(poster);

    await actAs(db, other);
    const changed = await asRole(db, 'authenticated', () =>
      rows(db, `update public.tournament_listings set name = 'Hijacked' where id = $1 returning id`, [row.id]),
    );
    const deleted = await asRole(db, 'authenticated', () =>
      rows(db, 'delete from public.tournament_listings where id = $1 returning id', [row.id]),
    );
    expect(changed).toEqual([]);
    expect(deleted).toEqual([]);

    await actAs(db, poster);
    await asRole(db, 'authenticated', () =>
      db.query(`update public.tournament_listings set city = 'Round Rock' where id = $1`, [row.id]),
    );
    expect((await rows(db, 'select name, city from public.tournament_listings'))[0]).toEqual({
      name: 'Lone Star Fall Classic',
      city: 'Round Rock',
    });
    await asRole(db, 'authenticated', () => db.query('delete from public.tournament_listings where id = $1', [row.id]));
    expect(await rows(db, 'select id from public.tournament_listings')).toEqual([]);
  });

  it('checks the link, state and dates', async () => {
    const poster = await createUser(db);
    await expect(post(poster, { ...listing, signup_url: 'javascript:alert(1)' })).rejects.toThrow(/check constraint/);
    await expect(post(poster, { ...listing, signup_url: 'pickleballtournaments.com/x' })).rejects.toThrow(/check constraint/);
    await expect(post(poster, { ...listing, state: 'Texas' })).rejects.toThrow(/check constraint/);
    await expect(post(poster, { ...listing, ends_on: '2026-11-13' })).rejects.toThrow(/check constraint/);
  });
});
