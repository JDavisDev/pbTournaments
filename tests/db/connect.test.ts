import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, addEvent, addPlayer, asRole, createDb, createLiveTournament, createUser, one } from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

async function setup() {
  const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
  const eventId = await addEvent(db, tournamentId, 'Open');
  const t = await one(db, 'select organization_id from public.tournaments where id = $1', [tournamentId]);
  const owner = await createUser(db);
  await db.query(`insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'owner')`, [t.organization_id, owner]);
  const player = await addPlayer(db, 'Jo', 'Smith');
  const reg = (
    await one(db, `insert into public.registrations (tournament_id, player_id, status, amount_cents) values ($1, $2, 'pending', 4000) returning id`, [
      tournamentId,
      player,
    ])
  ).id;
  await db.query('insert into public.registration_entries (registration_id, event_id) values ($1, $2)', [reg, eventId]);
  return { tournamentId, org: t.organization_id, owner, reg };
}

describe('Stripe Connect', () => {
  it('takes Courtside’s fee from each payment and pays into the organization’s account', async () => {
    const { tournamentId, org, owner, reg } = await setup();
    let checkout = (await one(db, 'select public.registration_for_checkout($1) as r', [reg])).r;
    expect(checkout).toMatchObject({ stripe_account_id: null, payments_ready: false, platform_fee_cents: 225 });

    await db.query(`select public.save_payment_account($1, 'acct_123', true, true)`, [org]);
    checkout = (await one(db, 'select public.registration_for_checkout($1) as r', [reg])).r;
    expect(checkout).toMatchObject({ stripe_account_id: 'acct_123', payments_ready: true });

    await actAs(db, owner);
    expect((await asRole(db, 'authenticated', () => one(db, 'select public.payments_status($1) as r', [tournamentId]))).r).toMatchObject({
      connected: true,
      ready: true,
      account_hint: '_123',
      can_manage: true,
    });

    await db.query(`select public.attach_checkout_session($1, 'cs_1', 'acct_123', 225)`, [reg]);
    await db.query(`select public.confirm_registration_payment($1, 'stripe', 'cs_1', 4000)`, [reg]);
    expect(await one(db, 'select status, platform_fee_cents, stripe_account_id from public.registrations where id = $1', [reg])).toEqual({
      status: 'paid',
      platform_fee_cents: 225,
      stripe_account_id: 'acct_123',
    });
    const fees = (await asRole(db, 'authenticated', () => one(db, 'select public.tournament_fees($1) as r', [tournamentId]))).r;
    expect(fees).toMatchObject({ fees_collected_cents: 225 });
  });

  it('lets only the organization’s owners and admins set up payouts', async () => {
    const { tournamentId } = await setup();
    const manager = await createUser(db);
    await db.query(`insert into public.tournament_staff (tournament_id, user_id, role) values ($1, $2, 'admin')`, [tournamentId, manager]);
    await actAs(db, manager);
    await expect(asRole(db, 'authenticated', () => db.query('select public.payment_account_for_setup($1)', [tournamentId]))).rejects.toThrow(
      /Only the tournament’s owner/,
    );
    expect((await asRole(db, 'authenticated', () => one(db, 'select public.payments_status($1) as r', [tournamentId]))).r).toMatchObject({
      connected: false,
      can_manage: false,
    });
    await expect(asRole(db, 'authenticated', () => db.query(`select public.save_payment_account(gen_random_uuid(), 'acct_x', true, true)`))).rejects.toThrow(
      /permission denied/,
    );
  });
});
