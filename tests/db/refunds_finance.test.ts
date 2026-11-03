import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, addEvent, addPlayer, addTeam, createDb, createLiveTournament, one } from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

/** A team: Jo paid $40 by card (fee taken), Pat was added at the desk. */
async function setup() {
  const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
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
  return { tournamentId, jo, reg };
}

const finance = (id: string) => one(db, 'select public.tournament_finance($1) as r', [id]).then((x) => x.r);
const plan = (id: string, player: string) => one(db, 'select public.card_refund_plan($1, $2) as r', [id, player]).then((x) => x.r);

describe('refunds to card', () => {
  it('refunds up to what they’re owed, keeping the refund fee', async () => {
    const { tournamentId, jo, reg } = await setup();
    expect((await plan(tournamentId, jo)).owed_cents).toBe(0);
    await db.query(`select public.record_ledger_entry($1, $2, 'credit', 4000, null, 'Rained out')`, [tournamentId, jo]);

    const p = await plan(tournamentId, jo);
    expect(p).toMatchObject({ owed_cents: 4000, refund_fee_cents: 500, payments: [{ registration_id: reg, refundable_cents: 4000 }] });

    const refunds = JSON.stringify([{ registration_id: reg, amount_cents: 3500, refund_id: 're_1', method: 'stripe' }]);
    await expect(db.query(`select public.record_card_refunds($1, $2, $3::jsonb, 600, null)`, [tournamentId, jo, refunds])).rejects.toThrow(
      /more than the \$40.00/,
    );
    await db.query(`select public.record_card_refunds($1, $2, $3::jsonb, 500, null)`, [tournamentId, jo, refunds]);
    expect((await plan(tournamentId, jo)).payments[0].refundable_cents).toBe(500);
    expect((await one(db, 'select balance_cents from public.player_balances where player_id = $1', [jo])).balance_cents).toBe(0);
    expect((await finance(tournamentId)).money).toMatchObject({ card_payments_cents: 4000, card_refunds_cents: 3500, kept_fees_cents: 500 });
  });
});

describe('Courtside’s fee for every player', () => {
  it('bills the director for players no card payment covered', async () => {
    const { tournamentId } = await setup();
    const f = await finance(tournamentId);
    expect(f.courtside).toMatchObject({ from_cards_cents: 275, uncovered_players: 1, owed_cents: 275, rate_cents: 275 });
    expect(f.divisions[0]).toMatchObject({ name: 'Open', teams: 1, players: 2 });

    await db.query(`select public.confirm_player_fees_payment($1, 'stripe', 'cs_fees', 275)`, [tournamentId]);
    await db.query(`select public.confirm_player_fees_payment($1, 'stripe', 'cs_fees', 275)`, [tournamentId]);
    expect((await finance(tournamentId)).courtside).toMatchObject({ owed_cents: 0, paid_separately_cents: 275 });
  });
});
