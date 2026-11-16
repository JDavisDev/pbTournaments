import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, asRole, createDb, createLiveTournament, createUser, one, rows } from './harness';

const START = new Date('2026-11-07T13:00:00Z');
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

describe('images', () => {
  it('keeps the tournament’s image out of its row, served by id', async () => {
    const { tournamentId, director } = await createLiveTournament(db, { courts: 1, start: START });
    await actAs(db, director);
    const id = await asRole(db, 'authenticated', async () =>
      (await one(db, 'select public.set_tournament_image($1, $2) as id', [tournamentId, JPEG])).id,
    );
    const t = await one(db, 'select * from public.tournaments where id = $1', [tournamentId]);
    expect(t.image_id).toBe(id);
    expect('image_data' in t).toBe(false);

    // Anyone can fetch it by id.
    await actAs(db, null);
    const file = await asRole(db, 'anon', async () => (await one(db, 'select public.image_file($1) as f', [id])).f);
    expect(file).toEqual({ content_type: 'image/jpeg', data: JPEG.split(',')[1] });

    // Replacing it removes the old one.
    await actAs(db, director);
    const next = await asRole(db, 'authenticated', async () =>
      (await one(db, 'select public.set_tournament_image($1, $2) as id', [tournamentId, JPEG])).id,
    );
    expect(next).not.toBe(id);
    expect(await rows(db, 'select id from private.images where id = $1', [id])).toHaveLength(0);
  });

  it('lets only staff change it, and only to a photo', async () => {
    const { tournamentId, director } = await createLiveTournament(db, { courts: 1, start: START });
    const stranger = await createUser(db);
    await actAs(db, stranger);
    await asRole(db, 'authenticated', async () => {
      await expect(db.query('select public.set_tournament_image($1, $2)', [tournamentId, JPEG])).rejects.toThrow(/staff/);
    });
    await actAs(db, director);
    await asRole(db, 'authenticated', async () => {
      await expect(
        db.query('select public.set_tournament_image($1, $2)', [tournamentId, 'data:image/svg+xml;base64,PHN2Zy8+']),
      ).rejects.toThrow(/JPEG, PNG/);
    });
  });

  it('removes the image with the tournament', async () => {
    const { tournamentId, director } = await createLiveTournament(db, { courts: 1, start: START });
    await actAs(db, director);
    const id = await asRole(db, 'authenticated', async () =>
      (await one(db, 'select public.set_tournament_image($1, $2) as id', [tournamentId, JPEG])).id,
    );
    await db.query('delete from public.tournaments where id = $1', [tournamentId]);
    expect(await rows(db, 'select id from private.images where id = $1', [id])).toHaveLength(0);
  });
});
