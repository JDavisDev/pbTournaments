import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, addEvent, asRole, createDb, createLiveTournament, createUser, one, rows } from './harness';

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
    `update public.tournaments set status = 'registration', entry_fee_cents = $2, extra_event_fee_cents = $3,
       waiver_text = 'I accept the risks.' where id = $1`,
    [setup.tournamentId, ENTRY, EXTRA],
  );
  const mens = await addEvent(db, setup.tournamentId, "Men's 3.5");
  const mixed = await addEvent(db, setup.tournamentId, 'Mixed 3.5');
  await db.query('update public.events set partner_required = false where tournament_id = $1', [setup.tournamentId]);
  return { ...setup, mens, mixed };
}

interface Entry {
  event_id: string;
  partner_email?: string;
  pay_for_partner?: boolean;
}

/** The public form: registers as an anonymous visitor. */
async function register(tournamentId: string, email: string, entries: Entry[], extra: Record<string, unknown> = {}) {
  await actAs(db, null);
  const player = {
    first_name: email.split('@')[0],
    last_name: 'Player',
    email,
    gender: 'male',
    dupr_doubles: 3.5,
    dupr_id: Math.random().toString(36).slice(2, 8).toUpperCase(),
    waiver_accepted: true,
    ...extra,
  };
  return asRole(db, 'anon', async () =>
    (
      await one(db, 'select public.start_registration($1, $2::jsonb, $3::jsonb) as r', [
        tournamentId,
        JSON.stringify(player),
        JSON.stringify(entries.map((e) => ({ ...e, partner_name: e.partner_email ? e.partner_email.split('@')[0] : null }))),
      ])
    ).r,
  );
}

const pay = (reg: { registration_id: string; amount_cents: number }) =>
  db.query(`select public.confirm_registration_payment($1, 'stripe', $2, $3)`, [
    reg.registration_id,
    `cs_${reg.registration_id}`,
    reg.amount_cents,
  ]);

const balanceOf = async (email: string) =>
  (
    await one(
      db,
      `select coalesce(sum(l.amount_cents), 0)::int as b from public.ledger_entries l
       join public.players p on p.id = l.player_id where p.email = $1`,
      [email],
    )
  ).b;

const withdraw = async (registrationId: string, eventId: string | null = null) => {
  await actAs(db, null);
  return asRole(db, 'anon', async () => (await one(db, 'select public.withdraw_registration($1, $2) as r', [registrationId, eventId])).r);
};

describe('paying for a partner', () => {
  it('charges the payer for both; the partner registers, signs the waiver, and pays nothing', async () => {
    const { tournamentId, mens } = await openTournament();
    const alex = await register(tournamentId, 'alex@x.test', [{ event_id: mens, partner_email: 'ben@x.test', pay_for_partner: true }]);
    expect(alex.amount_cents).toBe(2 * ENTRY);
    await pay(alex);

    // The ledger shows the partner's fee on its own line; the email has Ben's sign-up link.
    const fees = await rows(db, `select amount_cents, note from public.ledger_entries where kind = 'entry_fees' order by id`);
    expect(fees).toEqual([
      { amount_cents: ENTRY, note: null },
      { amount_cents: ENTRY, note: "Partner’s entry: ben, Men's 3.5" },
    ]);
    const email = await one(db, `select body from public.notifications where kind = 'registration_confirmed'`);
    expect(email.body).toContain(`ben still needs to register for Men's 3.5 (no charge)`);
    expect(email.body).toContain(`/register?event=${mens}`);

    const paidFor = await asRole(db, 'anon', () => rows(db, 'select * from public.partner_paid_events($1, $2)', [tournamentId, 'BEN@x.test']));
    expect(paidFor).toEqual([{ event_id: mens }]);

    // Ben still has to agree to the waiver.
    await expect(
      register(tournamentId, 'ben@x.test', [{ event_id: mens, partner_email: 'alex@x.test' }], { waiver_accepted: false }),
    ).rejects.toThrow(/waiver/);
    const ben = await register(tournamentId, 'ben@x.test', [{ event_id: mens, partner_email: 'alex@x.test' }]);
    expect(ben).toMatchObject({ amount_cents: 0, status: 'paid' });
    expect((await rows(db, 'select name from public.teams')).map((t) => t.name)).toEqual(['Player/Player']);
    expect(await balanceOf('alex@x.test')).toBe(0);
    expect(await balanceOf('ben@x.test')).toBe(0);

    const view = (await one(db, 'select public.get_registration($1) as r', [ben.registration_id])).r;
    expect(view.entries[0].paid_by_name).toBe('alex Player');
  });

  it('charges the partner only extra-event fees for their other events', async () => {
    const { tournamentId, mens, mixed } = await openTournament();
    await pay(await register(tournamentId, 'alex@x.test', [{ event_id: mens, partner_email: 'ben@x.test', pay_for_partner: true }]));
    const ben = await register(tournamentId, 'ben@x.test', [{ event_id: mens, partner_email: 'alex@x.test' }, { event_id: mixed }]);
    expect(ben.amount_cents).toBe(EXTRA);
  });

  it('holds the partner’s spot when the division fills', async () => {
    const { tournamentId, mens } = await openTournament();
    await db.query('update public.events set max_teams = 1 where id = $1', [mens]);
    await pay(await register(tournamentId, 'alex@x.test', [{ event_id: mens, partner_email: 'ben@x.test', pay_for_partner: true }]));
    // Someone else is waitlisted; Ben still gets in.
    const other = await register(tournamentId, 'cal@x.test', [{ event_id: mens }]);
    expect(other.status).toBe('waitlisted');
    const ben = await register(tournamentId, 'ben@x.test', [{ event_id: mens, partner_email: 'alex@x.test' }]);
    expect(ben.status).toBe('paid');
  });

  it('refuses to pay twice for the same partner, or for someone already registered', async () => {
    const { tournamentId, mens, mixed } = await openTournament();
    await pay(await register(tournamentId, 'alex@x.test', [{ event_id: mens, partner_email: 'ben@x.test', pay_for_partner: true }]));
    await expect(
      register(tournamentId, 'dan@x.test', [{ event_id: mens, partner_email: 'ben@x.test', pay_for_partner: true }]),
    ).rejects.toThrow(/Someone already paid for ben/);

    await pay(await register(tournamentId, 'eve@x.test', [{ event_id: mixed }]));
    await expect(
      register(tournamentId, 'fay@x.test', [{ event_id: mixed, partner_email: 'eve@x.test', pay_for_partner: true }]),
    ).rejects.toThrow(/eve is already registered/);
    await expect(
      register(tournamentId, 'gus@x.test', [{ event_id: mixed, partner_email: 'gus@x.test', pay_for_partner: true }]),
    ).rejects.toThrow(/not yours/);
  });

  it('credits the payer when the partner withdraws', async () => {
    const { tournamentId, mens } = await openTournament();
    await pay(await register(tournamentId, 'alex@x.test', [{ event_id: mens, partner_email: 'ben@x.test', pay_for_partner: true }]));
    const ben = await register(tournamentId, 'ben@x.test', [{ event_id: mens, partner_email: 'alex@x.test' }]);

    expect(await withdraw(ben.registration_id)).toMatchObject({ credit_cents: 0 });
    expect(await balanceOf('alex@x.test')).toBe(-ENTRY);
    expect(await balanceOf('ben@x.test')).toBe(0);
  });

  it('gives the payer the partner’s fee back, and frees the spot, if they withdraw first', async () => {
    const { tournamentId, mens } = await openTournament();
    await db.query('update public.events set max_teams = 1 where id = $1', [mens]);
    const alex = await register(tournamentId, 'alex@x.test', [{ event_id: mens, partner_email: 'ben@x.test', pay_for_partner: true }]);
    await pay(alex);

    expect(await withdraw(alex.registration_id)).toMatchObject({ credit_cents: 2 * ENTRY });
    expect(await balanceOf('alex@x.test')).toBe(-2 * ENTRY);
    // Ben now pays for himself, and there's room.
    const ben = await register(tournamentId, 'ben@x.test', [{ event_id: mens }]);
    expect(ben).toMatchObject({ amount_cents: ENTRY, status: 'pending' });
  });

  it('keeps a team paid for together in one division unless it moves as a team', async () => {
    const { tournamentId, director, mens, mixed } = await openTournament();
    const alex = await register(tournamentId, 'alex@x.test', [{ event_id: mens, partner_email: 'ben@x.test', pay_for_partner: true }]);
    await pay(alex);
    // Ben registers without naming Alex, so no team forms.
    await register(tournamentId, 'ben@x.test', [{ event_id: mens }]);
    await actAs(db, director);
    await expect(
      asRole(db, 'authenticated', () => db.query('select public.move_registration_entry($1, $2, $3)', [alex.registration_id, mens, mixed])),
    ).rejects.toThrow(/paid together/);
  });
});

describe('registration questions', () => {
  async function withQuestions() {
    const t = await openTournament();
    const ask = async (label: string, kind: string, options: string[], required: boolean, order: number) =>
      (
        await one(
          db,
          `insert into public.registration_questions (tournament_id, label, kind, options, required, sort_order)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [t.tournamentId, label, kind, options, required, order],
        )
      ).id as string;
    return {
      ...t,
      shirt: await ask('T-shirt size', 'choice', ['S', 'M', 'L', 'XL'], true, 0),
      food: await ask('Lunch', 'choices', ['Vegetarian', 'Gluten-free', 'Nut allergy'], false, 1),
      club: await ask('Home club', 'text', [], false, 2),
    };
  }

  it('saves answers, and admins read them', async () => {
    const { tournamentId, director, mens, shirt, food, club } = await withQuestions();
    const reg = await register(tournamentId, 'alex@x.test', [{ event_id: mens }], {
      answers: [
        { question_id: shirt, answer: 'L' },
        { question_id: food, answer: ['Vegetarian', 'Nut allergy'] },
        { question_id: club, answer: '  Austin Dinkers ' },
      ],
    });
    const view = (await one(db, 'select public.get_registration($1) as r', [reg.registration_id])).r;
    expect(view.answers).toEqual([
      { label: 'T-shirt size', answer: ['L'] },
      { label: 'Lunch', answer: ['Vegetarian', 'Nut allergy'] },
      { label: 'Home club', answer: ['Austin Dinkers'] },
    ]);

    await actAs(db, director);
    expect(await asRole(db, 'authenticated', () => rows(db, 'select * from public.registration_answers'))).toHaveLength(3);
    await actAs(db, await createUser(db));
    expect(await asRole(db, 'authenticated', () => rows(db, 'select * from public.registration_answers'))).toEqual([]);
    // Anyone can read the questions, for the form.
    await actAs(db, null);
    expect(await asRole(db, 'anon', () => rows(db, 'select label from public.registration_questions'))).toHaveLength(3);
  });

  it('checks required questions and the choices', async () => {
    const { tournamentId, mens, shirt, food } = await withQuestions();
    await expect(register(tournamentId, 'a@x.test', [{ event_id: mens }])).rejects.toThrow(/Please answer “T-shirt size”/);
    await expect(
      register(tournamentId, 'a@x.test', [{ event_id: mens }], { answers: [{ question_id: shirt, answer: 'XXXL' }] }),
    ).rejects.toThrow(/Choose one of the answers/);
    await expect(
      register(tournamentId, 'a@x.test', [{ event_id: mens }], {
        answers: [{ question_id: shirt, answer: 'M' }, { question_id: food, answer: ['Pizza'] }],
      }),
    ).rejects.toThrow(/Choose from the answers for “Lunch”/);
    // Nothing was saved by the failed attempts.
    expect(await rows(db, 'select * from public.registrations')).toEqual([]);
  });

  it('lets only admins change the questions', async () => {
    const { tournamentId } = await withQuestions();
    await actAs(db, await createUser(db));
    const changed = await asRole(db, 'authenticated', () =>
      rows(db, `update public.registration_questions set label = 'Hacked' where tournament_id = $1 returning id`, [tournamentId]),
    );
    expect(changed).toEqual([]);
  });
});
