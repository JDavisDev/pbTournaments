import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, addEvent, addPlayer, addTeam, asRole, createDb, createLiveTournament, createUser, one, rows } from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

/** Jo paid $40 by card on acct_1 (checkout cs_1, payment pi_1). */
async function setup() {
  const { tournamentId, director } = await createLiveTournament(db, { courts: 2, start: START });
  const eventId = await addEvent(db, tournamentId, 'Open');
  const jo = await addPlayer(db, 'Jo', 'Smith');
  const pat = await addPlayer(db, 'Pat', 'Lee');
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
  return { tournamentId, director, jo, reg };
}

const notices = (tournamentId: string) => rows(db, 'select * from public.stripe_notices where tournament_id = $1 order by id', [tournamentId]);
const refunds = (player: string) =>
  rows(db, `select amount_cents, note, stripe_refund_id from public.ledger_entries where player_id = $1 and kind = 'refund' order by id`, [player]);
const refundInStripe = (reg: string, refund: string, cents: number, ours = false, account = 'acct_1') =>
  one(db, `select public.record_stripe_refund($1, $2, 'pi_1', $3, $4, $5) as r`, [reg, account, refund, cents, ours]).then((x) => x.r);

describe('Stripe notices', () => {
  it('notes a payment that couldn’t be applied, once, and closes it when it’s refunded', async () => {
    const { tournamentId, reg } = await setup();
    const unmatched = () =>
      db.query(`select public.record_unmatched_payment($1, 'cs_2', 'acct_1', 'pi_2', 4000, 'Paid again: this registration was already paid.')`, [reg]);
    await unmatched();
    await unmatched(); // Stripe sent it again
    expect(await notices(tournamentId)).toMatchObject([{ kind: 'unmatched_payment', status: 'open', amount_cents: 4000 }]);

    const r = await one(db, `select public.record_stripe_refund($1, 'acct_1', 'pi_2', 're_9', 4000, false) as r`, [reg]);
    expect(r.r).toMatchObject({ recorded: false, why: 'unmatched' });
    expect(await notices(tournamentId)).toMatchObject([{ status: 'resolved' }]);
  });

  it('puts a refund made in the Stripe dashboard on the ledger, with a notice', async () => {
    const { tournamentId, jo, reg } = await setup();
    await refundInStripe(reg, 're_1', 1000);
    await refundInStripe(reg, 're_1', 1000); // again: nothing new
    expect(await refunds(jo)).toEqual([{ amount_cents: 1000, note: 'Refunded in Stripe', stripe_refund_id: 're_1' }]);
    expect(await notices(tournamentId)).toMatchObject([{ kind: 'outside_refund', amount_cents: 1000 }]);
    // On another account: not this registration's payment.
    expect(await refundInStripe(reg, 're_x', 500, false, 'acct_other')).toMatchObject({ recorded: false });
  });

  it('records a refund made here only once, whichever side records it first', async () => {
    const { tournamentId, jo, reg } = await setup();
    await db.query(`select public.record_ledger_entry($1, $2, 'credit', 4000, null, 'Rained out')`, [tournamentId, jo]);
    // The webhook gets there first.
    await refundInStripe(reg, 're_1', 3000, true);
    const made = JSON.stringify([{ registration_id: reg, amount_cents: 3000, refund_id: 're_1', method: 'stripe' }]);
    await db.query(`select public.record_card_refunds($1, $2, $3::jsonb, 500, null)`, [tournamentId, jo, made]);
    expect(await refunds(jo)).toEqual([{ amount_cents: 3000, note: 'Refunded to card', stripe_refund_id: 're_1' }]);
    expect(await notices(tournamentId)).toEqual([]);
  });

  it('follows a dispute; a lost one goes back to the player', async () => {
    const { tournamentId, jo, reg } = await setup();
    const dispute = (status: string) =>
      db.query(`select public.record_stripe_dispute($1, 'acct_1', 'pi_1', 'dp_1', 4000, $2, 'fraudulent')`, [reg, status]);
    await dispute('needs_response');
    expect(await notices(tournamentId)).toMatchObject([{ kind: 'dispute', status: 'open' }]);
    expect(await refunds(jo)).toEqual([]);
    await dispute('lost');
    await dispute('lost');
    expect(await notices(tournamentId)).toMatchObject([{ kind: 'dispute', status: 'lost' }]);
    expect(await refunds(jo)).toEqual([{ amount_cents: 4000, note: 'Dispute lost: returned to their card', stripe_refund_id: 'dp_1' }]);
  });

  it('lets staff dismiss a notice, and nobody else see it', async () => {
    const { tournamentId, director, reg } = await setup();
    await refundInStripe(reg, 're_1', 1000);
    const [n] = await notices(tournamentId);
    const stranger = await createUser(db);
    await actAs(db, stranger);
    await asRole(db, 'authenticated', async () => {
      expect(await rows(db, 'select id from public.stripe_notices')).toEqual([]);
      await expect(db.query('select public.resolve_stripe_notice($1)', [n.id])).rejects.toThrow(/staff/);
    });
    await actAs(db, director);
    await asRole(db, 'authenticated', () => db.query('select public.resolve_stripe_notice($1)', [n.id]));
    expect(await notices(tournamentId)).toMatchObject([{ status: 'resolved' }]);
  });

  it('shows players their own registrations and what they paid', async () => {
    const { jo } = await setup();
    const user = await createUser(db);
    await db.query('update public.players set user_id = $2 where id = $1', [jo, user]);
    await actAs(db, user);
    const mine = await asRole(db, 'authenticated', () => rows(db, 'select * from public.my_registrations()'));
    expect(mine).toMatchObject([{ status: 'paid', amount_cents: 4000, balance_cents: 0, events: ['Open'], disputed: false }]);
  });
});

describe('Courtside’s fees', () => {
  it('flags a second setup payment as a duplicate, but not the same one sent again', async () => {
    const { tournamentId } = await setup();
    await db.query('update public.tournaments set setup_paid_at = null where id = $1', [tournamentId]);
    const fee = (await one(db, 'select public.setup_fee_for_checkout($1) as f', [tournamentId])).f.amount_cents;
    const pay = (ref: string) =>
      one(db, `select public.confirm_setup_payment($1, 'stripe', $2, $3) as r`, [tournamentId, ref, fee]).then((x) => x.r);
    expect(await pay('cs_a')).toMatchObject({ already: false, duplicate: false });
    expect(await pay('cs_a')).toMatchObject({ already: true, duplicate: false });
    expect(await pay('cs_b')).toMatchObject({ already: true, duplicate: true });
  });

  it('keeps only what’s owed in player fees and gives back the rest', async () => {
    const { tournamentId } = await setup();
    const pay = (ref: string, cents: number) =>
      one(db, `select public.confirm_player_fees_payment($1, 'stripe', $2, $3) as r`, [tournamentId, ref, cents]).then((x) => x.r);
    const owed = (await one(db, 'select public.player_fees_for_checkout($1) as f', [tournamentId])).f.amount_cents;
    expect(owed).toBeGreaterThan(0);
    expect(await pay('cs_f1', owed + 100)).toMatchObject({ excess_cents: 100 });
    expect(await pay('cs_f1', owed + 100)).toMatchObject({ already: true, excess_cents: 0 });
    // A second checkout for fees already paid: all of it goes back.
    expect(await pay('cs_f2', owed)).toMatchObject({ excess_cents: owed });
  });
});
