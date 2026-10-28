import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, createDb, createLiveTournament, one } from './harness';

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const tournament = (id: string) => one(db, 'select details, announcement, announcement_at from public.tournaments where id = $1', [id]);

describe('details and announcement', () => {
  it('stamps when the announcement changes, and clears it when taken down', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: new Date('2026-11-07T13:00:00Z') });
    await db.query(`update public.tournaments set details = 'Parking in the north lot.' where id = $1`, [tournamentId]);
    expect(await tournament(tournamentId)).toMatchObject({ details: 'Parking in the north lot.', announcement: null, announcement_at: null });

    await db.query(`update public.tournaments set announcement = '  Courts 5-8 move to the north gym.  ' where id = $1`, [tournamentId]);
    const posted = await tournament(tournamentId);
    expect(posted.announcement).toBe('Courts 5-8 move to the north gym.');
    expect(posted.announcement_at).not.toBeNull();

    // Saving the same text keeps its time; a blank one takes it down.
    await db.query(`update public.tournaments set announcement = 'Courts 5-8 move to the north gym.' where id = $1`, [tournamentId]);
    expect((await tournament(tournamentId)).announcement_at).toEqual(posted.announcement_at);
    await db.query(`update public.tournaments set announcement = '   ' where id = $1`, [tournamentId]);
    expect(await tournament(tournamentId)).toMatchObject({ announcement: null, announcement_at: null });

    await expect(db.query(`update public.tournaments set announcement = repeat('x', 501) where id = $1`, [tournamentId])).rejects.toThrow();
  });
});
