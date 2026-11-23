import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, addEvent, addPlayer, addTeam, asRole, createDb, createLiveTournament, createOrganization, createUser, one, rows } from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const asUser = <T>(fn: () => Promise<T>) => asRole(db, 'authenticated', fn);

/** Jo paid $40 by card; Pat was added at the desk; Lee is on the waitlist. */
async function withPayment() {
  const { director, tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
  const eventId = await addEvent(db, tournamentId, 'Open');
  const jo = await addPlayer(db, 'Jo', 'Smith');
  const pat = await addPlayer(db, 'Pat', 'Lee');
  const lee = await addPlayer(db, 'Lee', 'Park');
  const team = await addTeam(db, eventId, [jo, pat]);
  const reg = (
    await one(db, `insert into public.registrations (tournament_id, player_id, status, amount_cents) values ($1, $2, 'pending', 4000) returning id`, [
      tournamentId,
      jo,
    ])
  ).id;
  await db.query('insert into public.registration_entries (registration_id, event_id, team_id) values ($1, $2, $3)', [reg, eventId, team]);
  await db.query(`select public.attach_checkout_session($1, 'cs_1', 'acct_1', 275)`, [reg]);
  await db.query(`select public.confirm_registration_payment($1, 'stripe', 'cs_1', 4000)`, [reg]);
  const waiting = (
    await one(db, `insert into public.registrations (tournament_id, player_id, status, amount_cents) values ($1, $2, 'waitlisted', 4000) returning id`, [
      tournamentId,
      lee,
    ])
  ).id;
  return { director, tournamentId, jo, reg, waiting };
}

const status = (id: string) => one(db, 'select status from public.tournaments where id = $1', [id]).then((r) => r.status);
const exists = (id: string) => one(db, 'select count(*)::int as n from public.tournaments where id = $1', [id]).then((r) => r.n === 1);

describe('deleting a tournament', () => {
  it('the owner deletes one with nothing on record; a manager can’t', async () => {
    const { owner, organizationId } = await createOrganization(db);
    const t = await asUser(() => one(db, 'select * from public.new_tournament($1)', [organizationId]));
    expect(await asUser(() => one(db, 'select public.tournament_removal($1) as r', [t.id]))).toEqual({
      r: { can_delete: true, deletable: true },
    });

    const manager = await createUser(db);
    await db.query(`insert into public.tournament_staff (tournament_id, user_id, role) values ($1, $2, 'admin')`, [t.id, manager]);
    await actAs(db, manager);
    await expect(asUser(() => db.query('select public.delete_tournament($1)', [t.id]))).rejects.toThrow(/Only the tournament’s owner|owner can delete/);

    await actAs(db, owner);
    await asUser(() => db.query('select public.delete_tournament($1)', [t.id]));
    expect(await exists(t.id)).toBe(false);
  });

  it('keeps one with registrations or payments, even through the table', async () => {
    const { director, tournamentId } = await withPayment();
    await actAs(db, director);
    expect((await asUser(() => one(db, 'select public.tournament_removal($1) as r', [tournamentId]))).r).toEqual({
      can_delete: true,
      deletable: false,
    });
    await expect(asUser(() => db.query('select public.delete_tournament($1)', [tournamentId]))).rejects.toThrow(/Cancel it instead/);
    await asUser(() => db.query('delete from public.tournaments where id = $1', [tournamentId]));
    expect(await exists(tournamentId)).toBe(true);
  });
});

describe('cancelling a tournament', () => {
  it('archives it, tells its players and leaves refunds for the managers', async () => {
    const { director, tournamentId, jo, reg, waiting } = await withPayment();
    await actAs(db, director);
    await asUser(() => db.query(`select public.cancel_tournament($1, 'Rained out. Refunds are on the way.')`, [tournamentId]));

    expect(await status(tournamentId)).toBe('cancelled');
    expect(await one(db, 'select announcement, cancelled_at is not null as stamped from public.tournaments where id = $1', [tournamentId])).toEqual({
      announcement: 'Rained out. Refunds are on the way.',
      stamped: true,
    });
    // The waitlist is let go; the paid registration stays, its fees credited.
    expect((await one(db, 'select status from public.registrations where id = $1', [waiting])).status).toBe('cancelled');
    expect((await one(db, 'select status from public.registrations where id = $1', [reg])).status).toBe('paid');
    expect((await one(db, 'select balance_cents from public.player_balances where player_id = $1', [jo])).balance_cents).toBe(-4000);

    // Jo, Pat (on the team) and Lee (waitlisted) are emailed.
    const emails = await rows(db, `select count(*)::int as n from public.notifications where tournament_id = $1 and kind = 'tournament_cancelled'`, [
      tournamentId,
    ]);
    expect(emails[0].n).toBe(3);

    // Nothing is refunded by itself: the managers see who's owed.
    const due = await asUser(() => rows(db, 'select * from public.refunds_due($1)', [tournamentId]));
    expect(due).toEqual([{ player_id: jo, name: 'Jo Smith', email: null, owed_cents: 4000, card_cents: 4000 }]);
    expect(await asUser(() => rows(db, 'select status, refunds_due from public.my_tournaments()'))).toEqual([
      { status: 'cancelled', refunds_due: 1 },
    ]);

    // Hidden from the public; its link shows the announcement.
    await actAs(db, null);
    expect(await asRole(db, 'anon', () => rows(db, 'select id from public.tournaments where id = $1', [tournamentId]))).toEqual([]);
    await expect(asRole(db, 'anon', () => db.query('select * from public.up_next($1)', [tournamentId]))).rejects.toThrow(/not found/);
    expect((await asRole(db, 'anon', () => one(db, 'select public.cancelled_tournament($1) as r', [tournamentId]))).r).toMatchObject({
      announcement: 'Rained out. Refunds are on the way.',
    });

    // Archived: nothing moves it, no one registers or withdraws for a second credit.
    await actAs(db, director);
    await expect(asUser(() => db.query(`select public.set_tournament_status($1, 'live')`, [tournamentId]))).rejects.toThrow(/is cancelled/);
    await expect(asUser(() => db.query('select public.withdraw_registration($1)', [reg]))).rejects.toThrow(/cancelled/);
    await expect(
      db.query(`insert into public.registrations (tournament_id, player_id, status, amount_cents) values ($1, $2, 'pending', 4000)`, [tournamentId, jo]),
    ).rejects.toThrow(/cancelled/);
    await expect(asUser(() => db.query('select public.cancel_tournament($1)', [tournamentId]))).rejects.toThrow(/already cancelled/);
    // Managers still edit it.
    await asUser(() => db.query(`update public.tournaments set name = 'Fall Open (cancelled)' where id = $1`, [tournamentId]));
    expect((await one(db, 'select name from public.tournaments where id = $1', [tournamentId])).name).toBe('Fall Open (cancelled)');

    // Refunding Jo clears what's owed.
    const refunds = JSON.stringify([{ registration_id: reg, amount_cents: 4000, refund_id: 're_1', method: 'stripe' }]);
    await db.query(`select public.record_card_refunds($1, $2, $3::jsonb, 0, null)`, [tournamentId, jo, refunds]);
    expect(await asUser(() => rows(db, 'select * from public.refunds_due($1)', [tournamentId]))).toEqual([]);
  });

  it('isn’t for a finished tournament or someone off the staff', async () => {
    const { director, tournamentId } = await withPayment();
    await actAs(db, await createUser(db));
    await expect(asUser(() => db.query('select public.cancel_tournament($1)', [tournamentId]))).rejects.toThrow(/staff/);
    await actAs(db, director);
    await db.query(`update public.tournaments set status = 'complete' where id = $1`, [tournamentId]);
    await expect(asUser(() => db.query('select public.cancel_tournament($1)', [tournamentId]))).rejects.toThrow(/is over/);
  });
});
