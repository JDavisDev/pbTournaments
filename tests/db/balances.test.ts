import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  actAs,
  addEvent,
  asRole,
  createDb,
  createLiveTournament,
  createUser,
  generate,
  one,
  rows,
  setClock,
} from './harness';

const START = new Date('2026-11-07T13:00:00Z');
const ENTRY = 4000;
const EXTRA = 1500;

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

async function openTournament() {
  const setup = await createLiveTournament(db, { courts: 2, start: START });
  await db.query(
    `update public.tournaments set status = 'registration', entry_fee_cents = $2, extra_event_fee_cents = $3 where id = $1`,
    [setup.tournamentId, ENTRY, EXTRA],
  );
  const mens = await addEvent(db, setup.tournamentId, "Men's 3.5");
  const mixed = await addEvent(db, setup.tournamentId, 'Mixed 3.5');
  const open = await addEvent(db, setup.tournamentId, "Men's 4.0");
  await db.query('update public.events set partner_required = false where tournament_id = $1', [setup.tournamentId]);
  return { ...setup, mens, mixed, open };
}

/** Registers as an anonymous visitor (the public form) and pays at checkout. */
async function registerAndPay(tournamentId: string, email: string, entries: { event_id: string; partner_email?: string }[], code?: string) {
  await actAs(db, null);
  const player = { first_name: email.split('@')[0], last_name: 'Player', email, phone: null, sms_opt_in: false, dupr_doubles: 3.5, dupr_id: Math.random().toString(36).slice(2, 8).toUpperCase(), discount_code: code };
  const reg = await asRole(db, 'anon', async () =>
    (
      await one(db, 'select public.start_registration($1, $2::jsonb, $3::jsonb) as r', [
        tournamentId,
        JSON.stringify(player),
        JSON.stringify(entries.map((e) => ({ ...e, partner_name: e.partner_email ? 'Partner' : null }))),
      ])
    ).r,
  );
  await db.query(`select public.confirm_registration_payment($1, 'stripe', $2, $3)`, [
    reg.registration_id,
    `cs_test_${reg.registration_id}`,
    reg.amount_cents,
  ]);
  const { player_id } = await one(db, 'select player_id from public.registrations where id = $1', [reg.registration_id]);
  return { id: reg.registration_id as string, playerId: player_id as string, amount: reg.amount_cents as number };
}

const balance = async (tournamentId: string, playerId: string) =>
  one(db, 'select * from public.player_balances where tournament_id = $1 and player_id = $2', [tournamentId, playerId]);

/** As the player: withdraw with their registration link. */
const withdrawAsPlayer = async (registrationId: string, eventId: string | null = null) => {
  await actAs(db, null);
  return asRole(db, 'anon', async () =>
    (await one(db, 'select public.withdraw_registration($1, $2) as r', [registrationId, eventId])).r,
  );
};

const record = (tournamentId: string, playerId: string, kind: string, cents: number, method: string | null = null) =>
  asRole(db, 'authenticated', () =>
    one(db, 'select * from public.record_ledger_entry($1, $2, $3, $4, $5, $6)', [tournamentId, playerId, kind, cents, method, null]),
  );

describe('balances', () => {
  it('puts fees, the discount and the Stripe payment on the ledger', async () => {
    const { tournamentId, director, mens, mixed } = await openTournament();
    await db.query(`insert into public.discount_codes (tournament_id, code, amount_off_cents) values ($1, 'CLUB10', 1000)`, [tournamentId]);
    const reg = await registerAndPay(tournamentId, 'alex@x.test', [{ event_id: mens }, { event_id: mixed }], 'CLUB10');
    expect(reg.amount).toBe(ENTRY + EXTRA - 1000);

    expect(await balance(tournamentId, reg.playerId)).toMatchObject({
      entry_fees_cents: ENTRY + EXTRA,
      discount_cents: 1000,
      paid_cents: ENTRY + EXTRA - 1000,
      balance_cents: 0,
    });
    const payment = await one(db, `select * from public.ledger_entries where kind = 'payment'`);
    expect(payment).toMatchObject({ method: 'stripe', payment_ref: `cs_test_${reg.id}` });

    // The player gets their registration link by email.
    const email = await one(db, `select * from public.notifications where kind = 'registration_confirmed'`);
    expect(email.body).toContain(`/register/done?r=${reg.id}`);

    // Admins read the ledger; the public can't.
    await actAs(db, director);
    expect(await asRole(db, 'authenticated', () => rows(db, 'select * from public.ledger_entries'))).toHaveLength(3);
    await actAs(db, await createUser(db));
    expect(await asRole(db, 'authenticated', () => rows(db, 'select * from public.player_balances'))).toEqual([]);
  });

  it('credits a withdrawn extra event its fee, and the last event the rest', async () => {
    const { tournamentId, mens, mixed } = await openTournament();
    const reg = await registerAndPay(tournamentId, 'alex@x.test', [{ event_id: mens }, { event_id: mixed }]);

    expect(await withdrawAsPlayer(reg.id, mixed)).toEqual({ credit_cents: EXTRA, withdrawn: ['Mixed 3.5'] });
    expect((await balance(tournamentId, reg.playerId)).balance_cents).toBe(-EXTRA);
    expect(await withdrawAsPlayer(reg.id)).toEqual({ credit_cents: ENTRY, withdrawn: ["Men's 3.5"] });
    // Owed everything they paid, never more.
    expect((await balance(tournamentId, reg.playerId)).balance_cents).toBe(-(ENTRY + EXTRA));

    const view = (await one(db, 'select public.get_registration($1) as r', [reg.id])).r;
    expect(view.status).toBe('cancelled');
    expect(view.entries).toEqual([]);
    expect(view.withdrawals.map((w: { event_name: string; withdrawn_by: string }) => [w.event_name, w.withdrawn_by])).toEqual([
      ['Mixed 3.5', 'player'],
      ["Men's 3.5", 'player'],
    ]);
    expect(view.balance.balance_cents).toBe(-(ENTRY + EXTRA));
  });

  it('never credits more than was paid after a discount', async () => {
    const { tournamentId, mens, mixed } = await openTournament();
    await db.query(`insert into public.discount_codes (tournament_id, code, percent_off) values ($1, 'HALF', 50)`, [tournamentId]);
    const reg = await registerAndPay(tournamentId, 'alex@x.test', [{ event_id: mens }, { event_id: mixed }], 'HALF');
    await withdrawAsPlayer(reg.id);
    expect((await balance(tournamentId, reg.playerId)).balance_cents).toBe(-reg.amount);
  });

  it('lets admins refund, keep money under the policy, and take desk payments', async () => {
    const { tournamentId, director, mens } = await openTournament();
    const reg = await registerAndPay(tournamentId, 'alex@x.test', [{ event_id: mens }]);
    await withdrawAsPlayer(reg.id);

    await actAs(db, director);
    await expect(record(tournamentId, reg.playerId, 'refund', ENTRY + 1, 'stripe')).rejects.toThrow(/more than the \$40.00 they’re owed/);
    await expect(record(tournamentId, reg.playerId, 'refund', 3500, null)).rejects.toThrow(/how the money was paid/);
    await record(tournamentId, reg.playerId, 'refund', 3500, 'stripe');
    await record(tournamentId, reg.playerId, 'fee', 500);
    expect(await balance(tournamentId, reg.playerId)).toMatchObject({ refunded_cents: 3500, fees_cents: 500, balance_cents: 0 });

    // A fee they haven't paid: they owe it until it's paid at the desk.
    await record(tournamentId, reg.playerId, 'fee', 1000);
    expect((await balance(tournamentId, reg.playerId)).balance_cents).toBe(1000);
    await expect(record(tournamentId, reg.playerId, 'payment', 1500, 'cash')).rejects.toThrow(/more than the \$10.00 they owe/);
    await record(tournamentId, reg.playerId, 'payment', 1000, 'cash');
    expect((await balance(tournamentId, reg.playerId)).balance_cents).toBe(0);

    // Only admins.
    await actAs(db, await createUser(db));
    await expect(record(tournamentId, reg.playerId, 'credit', 100)).rejects.toThrow(/Only tournament staff/);
  });

  it('frees the spot: the division counts one fewer and the player can register again', async () => {
    const { tournamentId, mens } = await openTournament();
    await db.query('update public.events set max_teams = 1 where id = $1', [mens]);
    const a = await registerAndPay(tournamentId, 'a@x.test', [{ event_id: mens, partner_email: 'b@x.test' }]);
    await registerAndPay(tournamentId, 'b@x.test', [{ event_id: mens, partner_email: 'a@x.test' }]);
    const full = await one(db, 'select * from public.registration_availability($1) where event_id = $2', [tournamentId, mens]);
    expect(full.full).toBe(true);

    await withdrawAsPlayer(a.id);
    const after = await one(db, 'select * from public.registration_availability($1) where event_id = $2', [tournamentId, mens]);
    expect(after).toMatchObject({ full: false, spots_left: 1 });
    // The team is gone (no schedule yet); the partner waits for a new partner.
    expect(await rows(db, 'select * from public.teams where event_id = $1', [mens])).toEqual([]);
    const partner = await one(db, `select re.* from public.registration_entries re
      join public.registrations r on r.id = re.registration_id join public.players p on p.id = r.player_id
      where p.email = 'b@x.test'`);
    expect(partner.team_id).toBeNull();

    const again = await registerAndPay(tournamentId, 'a@x.test', [{ event_id: mens, partner_email: 'b@x.test' }]);
    expect(again.amount).toBe(ENTRY);
  });

  it('drops a scheduled team and forfeits its matches', async () => {
    const { tournamentId, director, mens } = await openTournament();
    const a = await registerAndPay(tournamentId, 'a@x.test', [{ event_id: mens, partner_email: 'b@x.test' }]);
    await registerAndPay(tournamentId, 'b@x.test', [{ event_id: mens, partner_email: 'a@x.test' }]);
    for (const [x, y] of [['c', 'd'], ['e', 'f']]) {
      await registerAndPay(tournamentId, `${x}@x.test`, [{ event_id: mens, partner_email: `${y}@x.test` }]);
      await registerAndPay(tournamentId, `${y}@x.test`, [{ event_id: mens, partner_email: `${x}@x.test` }]);
    }
    await actAs(db, director);
    await generate(db, mens);
    await db.query(`update public.tournaments set status = 'live' where id = $1`, [tournamentId]);
    await setClock(db, START);

    await withdrawAsPlayer(a.id);
    const team = await one(db, `select * from public.teams where name like '%' and withdrawn_at is not null`);
    const left = await rows(db, `select * from public.matches where $1 in (team1_id, team2_id) and status <> 'completed'`, [team.id]);
    expect(left).toEqual([]);
  });

  it('records who withdrew: an admin, or the player', async () => {
    const { tournamentId, director, mens } = await openTournament();
    const reg = await registerAndPay(tournamentId, 'alex@x.test', [{ event_id: mens }]);
    await actAs(db, director);
    await asRole(db, 'authenticated', () => db.query('select public.withdraw_registration($1)', [reg.id]));
    expect(await one(db, 'select withdrawn_by from public.registration_withdrawals')).toEqual({ withdrawn_by: 'director' });
  });

  it('stops withdrawals once the tournament is over', async () => {
    const { tournamentId, mens } = await openTournament();
    const reg = await registerAndPay(tournamentId, 'alex@x.test', [{ event_id: mens }]);
    await db.query(`update public.tournaments set status = 'complete' where id = $1`, [tournamentId]);
    await expect(withdrawAsPlayer(reg.id)).rejects.toThrow(/is over/);
  });
});

describe('moving divisions', () => {
  it('moves a team with both partners, before the schedule', async () => {
    const { tournamentId, director, mens, open } = await openTournament();
    const a = await registerAndPay(tournamentId, 'a@x.test', [{ event_id: mens, partner_email: 'b@x.test' }]);
    const b = await registerAndPay(tournamentId, 'b@x.test', [{ event_id: mens, partner_email: 'a@x.test' }]);

    await actAs(db, director);
    await asRole(db, 'authenticated', () => db.query('select public.move_registration_entry($1, $2, $3)', [a.id, mens, open]));
    const entries = await rows(db, 'select registration_id, event_id from public.registration_entries order by registration_id');
    expect(entries.every((e) => e.event_id === open)).toBe(true);
    expect(entries.map((e) => e.registration_id).sort()).toEqual([a.id, b.id].sort());
    expect((await one(db, 'select event_id from public.teams')).event_id).toBe(open);
    // Same price: nothing on the ledger changes.
    expect((await balance(tournamentId, a.playerId)).balance_cents).toBe(0);
  });

  it('pairs a waiting player in the new division', async () => {
    const { tournamentId, director, mens, open } = await openTournament();
    const a = await registerAndPay(tournamentId, 'a@x.test', [{ event_id: mens, partner_email: 'b@x.test' }]);
    await registerAndPay(tournamentId, 'b@x.test', [{ event_id: open, partner_email: 'a@x.test' }]);
    expect(await rows(db, 'select * from public.teams')).toEqual([]);

    await actAs(db, director);
    await asRole(db, 'authenticated', () => db.query('select public.move_registration_entry($1, $2, $3)', [a.id, mens, open]));
    expect((await one(db, 'select event_id from public.teams')).event_id).toBe(open);
  });

  it('refuses once the team has matches, and for anyone but admins', async () => {
    const { tournamentId, director, mens, open } = await openTournament();
    const regs = [];
    for (const [x, y] of [['a', 'b'], ['c', 'd']]) {
      regs.push(await registerAndPay(tournamentId, `${x}@x.test`, [{ event_id: mens, partner_email: `${y}@x.test` }]));
      await registerAndPay(tournamentId, `${y}@x.test`, [{ event_id: mens, partner_email: `${x}@x.test` }]);
    }
    await actAs(db, await createUser(db));
    await expect(
      asRole(db, 'authenticated', () => db.query('select public.move_registration_entry($1, $2, $3)', [regs[0].id, mens, open])),
    ).rejects.toThrow(/Only tournament staff/);

    await actAs(db, director);
    await generate(db, mens);
    await expect(
      asRole(db, 'authenticated', () => db.query('select public.move_registration_entry($1, $2, $3)', [regs[0].id, mens, open])),
    ).rejects.toThrow(/already has matches/);
  });
});
