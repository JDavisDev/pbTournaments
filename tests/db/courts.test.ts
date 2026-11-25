import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, addEvent, addPair, asRole, checkIn, createDb, createLiveTournament, createOrganization, generate, liveMatches, reportScore, rows } from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const courtNames = async (tournamentId: string) =>
  (await rows(db, 'select court_name from public.court_board where tournament_id = $1 order by sort_order', [tournamentId])).map(
    (c) => c.court_name,
  );
const courtIds = async (tournamentId: string) =>
  (await rows(db, 'select court_id from public.court_board where tournament_id = $1 order by sort_order', [tournamentId])).map(
    (c) => c.court_id as string,
  );
const setCourts = (tournamentId: string, courts: { id: string | null; name: string }[]) =>
  db.query('select public.set_courts($1, $2::jsonb)', [tournamentId, JSON.stringify(courts)]);

describe('court names', () => {
  it('renames, adds and removes courts in one go, and names can swap', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 3, start: START });
    const [a, b, c] = await courtIds(tournamentId);

    await setCourts(tournamentId, [
      { id: b, name: 'Court 1' },
      { id: a, name: 'Court 2' },
      { id: null, name: 'Stadium' },
    ]);
    expect(await courtNames(tournamentId)).toEqual(['Court 1', 'Court 2', 'Stadium']);
    const after = await courtIds(tournamentId);
    expect(after.slice(0, 2)).toEqual([b, a]);
    expect(after).not.toContain(c);
  });

  it('numbers a new court after the highest-numbered one', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 5, start: START });
    const ids = await courtIds(tournamentId);
    await setCourts(tournamentId, ids.map((id, i) => ({ id, name: `Court ${7 + i}` })));
    await db.query('select public.set_court_count($1, 6)', [tournamentId]);
    expect(await courtNames(tournamentId)).toEqual(['Court 7', 'Court 8', 'Court 9', 'Court 10', 'Court 11', 'Court 12']);
  });

  it('refuses blank and repeated names, and sends a removed court’s match back to the queue', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
    const [a, b] = await courtIds(tournamentId);
    await expect(setCourts(tournamentId, [{ id: a, name: ' ' }])).rejects.toThrow(/needs a name/);
    await expect(setCourts(tournamentId, [{ id: a, name: 'Center' }, { id: b, name: 'center' }])).rejects.toThrow(/both called/);

    const eventId = await addEvent(db, tournamentId, 'Open');
    for (let i = 1; i <= 4; i++) await checkIn(db, await addPair(db, eventId, [`P${i}a`, `P${i}b`], i));
    await generate(db, eventId);
    expect(await liveMatches(db, tournamentId)).toHaveLength(2);
    const [first] = await liveMatches(db, tournamentId);
    await reportScore(db, first.id, [[11, 3]]);

    // Court 1 has history: removed, it's kept for it, and adding it back by name brings it back.
    const played = first.court_id as string;
    const other = played === a ? b : a;
    await setCourts(tournamentId, [{ id: other, name: 'Main' }]);
    expect(await courtNames(tournamentId)).toEqual(['Main']);
    await expect(setCourts(tournamentId, [{ id: other, name: first.court_name }])).rejects.toThrow(/removed during play/);
    await setCourts(tournamentId, [{ id: other, name: 'Main' }, { id: null, name: first.court_name }]);
    expect(await courtIds(tournamentId)).toEqual([other, played]);
  });

  it('is for staff only', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    await createOrganization(db); // signs in as another club's owner
    await asRole(db, 'authenticated', async () => {
      await expect(setCourts(tournamentId, [])).rejects.toThrow(/Only tournament staff/);
    });
  });
});
