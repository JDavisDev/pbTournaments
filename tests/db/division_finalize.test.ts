import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  addEvent,
  addPair,
  checkIn,
  createDb,
  createLiveTournament,
  generate,
  liveMatches,
  one,
  reportScore,
} from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

/** A started two-team division with its one match on court. */
async function division() {
  const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
  const eventId = await addEvent(db, tournamentId, 'Open');
  for (let i = 1; i <= 2; i++) await checkIn(db, await addPair(db, eventId, [`F${i}a`, `F${i}b`], i));
  await generate(db, eventId);
  const [match] = await liveMatches(db, tournamentId);
  return { tournamentId, eventId, match };
}

const finalize = (eventId: string) => db.query('select public.finalize_event($1)', [eventId]);
const correct = (matchId: string, games: number[][]) =>
  db.query('select public.correct_score($1, $2::jsonb)', [matchId, JSON.stringify(games)]);

describe('finalizing a division', () => {
  it('waits until every match is played', async () => {
    const { eventId, match } = await division();
    await expect(finalize(eventId)).rejects.toThrow(/Finish every match first: 1 left/);
    await reportScore(db, match.id, [[11, 5]]);
    await finalize(eventId);
    expect((await one(db, 'select finalized_at from public.events where id = $1', [eventId])).finalized_at).not.toBeNull();
    await expect(finalize(eventId)).rejects.toThrow(/already final/);
  });

  it('locks the scores until a director reopens it', async () => {
    const { tournamentId, eventId, match } = await division();
    await reportScore(db, match.id, [[11, 5]]);
    await finalize(eventId);
    await expect(correct(match.id, [[5, 11]])).rejects.toThrow(/results are final/);
    // Marking results as sent to DUPR still works.
    expect((await one(db, 'select public.mark_dupr_exported($1, array[$2::uuid]) as n', [tournamentId, match.id])).n).toBe(1);

    await db.query('select public.reopen_event($1)', [eventId]);
    await correct(match.id, [[5, 11]]);
    expect((await one(db, 'select games from public.matches where id = $1', [match.id])).games).toEqual([[5, 11]]);
  });

  it('isn’t carried over to a copy', async () => {
    const { eventId, match } = await division();
    await reportScore(db, match.id, [[11, 5]]);
    await finalize(eventId);
    const copy = await one(db, 'select * from public.copy_event($1)', [eventId]);
    expect(copy.finalized_at).toBeNull();
  });
});
