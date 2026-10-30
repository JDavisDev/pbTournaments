import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  actAs,
  addEvent,
  addMinutes,
  addPair,
  asRole,
  checkIn,
  createDb,
  createLiveTournament,
  generate,
  liveMatches,
  one,
  rows,
  setClock,
} from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

async function openTournament(prices = { entry: 4250, extra: 1550 }) {
  const setup = await createLiveTournament(db, { courts: 2, start: START });
  await db.query(
    `update public.tournaments set status = 'registration', entry_fee_cents = $2, extra_event_fee_cents = $3 where id = $1`,
    [setup.tournamentId, prices.entry, prices.extra],
  );
  const mens = await addEvent(db, setup.tournamentId, "Men's 3.5");
  const mixed = await addEvent(db, setup.tournamentId, 'Mixed 3.5');
  return { ...setup, mens, mixed };
}

interface Who {
  first: string;
  last: string;
  email: string;
  gender?: 'male' | 'female';
  birth_date?: string;
  dupr_doubles?: number;
  self_rating?: number;
}

/** Registers as an anonymous visitor, like the public form. */
async function register(
  tournamentId: string,
  who: Who,
  entries: { event_id: string; partner_name?: string; partner_email?: string; pay_for_partner?: boolean }[],
) {
  await actAs(db, null);
  const player = {
    first_name: who.first,
    terms_accepted: true,
    last_name: who.last,
    email: who.email,
    phone: '+15550001111',
    sms_opt_in: true,
    gender: who.gender ?? null,
    birth_date: who.birth_date ?? null,
    dupr_doubles: 'dupr_doubles' in who ? who.dupr_doubles : 3.5,
    self_rating: who.self_rating ?? null,
    dupr_id: Math.random().toString(36).slice(2, 8).toUpperCase(),
  };
  return asRole(db, 'anon', async () =>
    (
      await one(db, 'select public.start_registration($1, $2::jsonb, $3::jsonb) as r', [
        tournamentId,
        JSON.stringify(player),
        JSON.stringify(entries),
      ])
    ).r,
  );
}

const pay = (registrationId: string, amount: number) =>
  db.query(`select public.confirm_registration_payment($1, 'test', $2, $3)`, [registrationId, `test_${registrationId}`, amount]);

describe('registration', () => {
  it('prices the first event and each extra event', async () => {
    const { tournamentId, mens, mixed } = await openTournament();
    const reg = await register(tournamentId, { first: 'Alex', last: 'Davis', email: 'alex@x.test' }, [
      { event_id: mens, partner_name: 'Ben Lee', partner_email: 'ben@x.test' },
      { event_id: mixed, partner_name: 'Cara Moss', partner_email: 'cara@x.test' },
    ]);
    expect(reg).toMatchObject({ amount_cents: 4250 + 1550, status: 'pending' });
  });

  it('follows the price schedule, through each step’s last day in the tournament’s time zone', async () => {
    const { tournamentId, mens } = await openTournament();
    await db.query(`update public.tournaments set price_schedule = $2::jsonb where id = $1`, [
      tournamentId,
      JSON.stringify([
        // Out of order on purpose: the earliest step that hasn't passed applies.
        { through: '2026-11-09', registration_cents: 3500, event_cents: 1200 },
        { through: '2026-11-07', registration_cents: 3000, event_cents: 1000 },
      ]),
    ]);
    const price = async (at: string, events = 1) => {
      await setClock(db, new Date(at));
      return (await one<{ p: number }>(db, 'select public.registration_price($1, $2) as p', [tournamentId, events])).p;
    };
    // New York: Nov 7, 8:00 and 23:30 (Nov 8 in UTC) are still the first step.
    expect(await price('2026-11-07T13:00:00Z')).toBe(3000);
    expect(await price('2026-11-08T04:30:00Z', 2)).toBe(3000 + 1000);
    // Nov 8, 00:30 New York: the second step.
    expect(await price('2026-11-08T05:30:00Z', 2)).toBe(3500 + 1200);
    // After the last step: the regular price.
    expect(await price('2026-11-10T06:00:00Z', 2)).toBe(4250 + 1550);

    // What a registration is charged follows the same schedule.
    await setClock(db, START);
    const early = await register(tournamentId, { first: 'A', last: 'B', email: 'a@x.test' }, [
      { event_id: mens, partner_name: 'C D', partner_email: 'c@x.test' },
    ]);
    expect(early.amount_cents).toBe(3000);

    await expect(
      db.query(`update public.tournaments set price_schedule = $2::jsonb where id = $1`, [
        tournamentId,
        JSON.stringify([{ through: 'soon', registration_cents: -5, event_cents: 1 }]),
      ]),
    ).rejects.toThrow();
  });

  it('charges the registration fee and every event when the first event isn’t included', async () => {
    const { tournamentId, mens, mixed } = await openTournament({ entry: 2000, extra: 1500 });
    await db.query('update public.tournaments set first_event_included = false where id = $1', [tournamentId]);
    const one_ = await register(tournamentId, { first: 'A', last: 'B', email: 'a@x.test' }, [
      { event_id: mens, partner_name: 'C D', partner_email: 'c@x.test' },
    ]);
    expect(one_.amount_cents).toBe(2000 + 1500);
    const two = await register(tournamentId, { first: 'E', last: 'F', email: 'e@x.test' }, [
      { event_id: mens, partner_name: 'G H', partner_email: 'g@x.test' },
      { event_id: mixed, partner_name: 'I J', partner_email: 'i@x.test' },
    ]);
    expect(two.amount_cents).toBe(2000 + 2 * 1500);
  });

  it('includes only an event whose division allows it', async () => {
    const { tournamentId, mens, mixed } = await openTournament({ entry: 4000, extra: 1500 });
    await db.query('update public.events set included_in_registration = false where id = $1', [mixed]);
    // Only the excluded division: registration plus its event fee.
    const excluded = await register(tournamentId, { first: 'A', last: 'B', email: 'a@x.test' }, [
      { event_id: mixed, partner_name: 'C D', partner_email: 'c@x.test' },
    ]);
    expect(excluded.amount_cents).toBe(4000 + 1500);
    // With an allowed one too: that one is included, the excluded one is extra.
    const both = await register(tournamentId, { first: 'E', last: 'F', email: 'e@x.test' }, [
      { event_id: mens, partner_name: 'G H', partner_email: 'g@x.test' },
      { event_id: mixed, partner_name: 'I J', partner_email: 'i@x.test' },
    ]);
    expect(both.amount_cents).toBe(4000 + 1500);
    // Paying a partner's way in the excluded division: their registration and the event.
    const generous = await register(tournamentId, { first: 'K', last: 'L', email: 'k@x.test' }, [
      { event_id: mixed, partner_name: 'M N', partner_email: 'm@x.test', pay_for_partner: true },
    ]);
    expect(generous.amount_cents).toBe(2 * (4000 + 1500));
  });

  it('lets a director register players when registration is closed, and reopen it once live', async () => {
    const { tournamentId, director, mens, mixed } = await openTournament();
    const asDirector = async (email: string, eventId: string) => {
      await actAs(db, director);
      return asRole(db, 'authenticated', async () =>
        (
          await one(db, 'select public.start_registration($1, $2::jsonb, $3::jsonb) as r', [
            tournamentId,
            JSON.stringify({ first_name: 'Late', last_name: 'Entry', email, dupr_doubles: 3.5, dupr_id: 'LATE01' }),
            JSON.stringify([{ event_id: eventId, partner_name: 'P Q', partner_email: `p-${email}` }]),
          ])
        ).r,
      );
    };
    const player = (email: string, eventId: string) =>
      register(tournamentId, { first: 'A', last: 'B', email }, [{ event_id: eventId, partner_name: 'C D', partner_email: `c-${email}` }]);

    // Closing date passed: players can't, the director can.
    await db.query('update public.tournaments set registration_closes_at = $2 where id = $1', [tournamentId, addMinutes(START, -60)]);
    await expect(player('a@x.test', mens)).rejects.toThrow(/closed on/);
    expect((await asDirector('late@x.test', mens)).status).toBe('pending');

    // Live: closed to players until a director reopens it, and never for a started division.
    await db.query(`update public.tournaments set status = 'live', registration_closes_at = null where id = $1`, [tournamentId]);
    await db.query('update public.events set started_at = $2 where id = $1', [mens, START]);
    await expect(player('b@x.test', mixed)).rejects.toThrow(/not open/);
    await db.query('update public.tournaments set registration_reopened = true where id = $1', [tournamentId]);
    expect((await player('c@x.test', mixed)).status).toBe('pending');
    await expect(player('d@x.test', mens)).rejects.toThrow(/already started/);
    expect((await asDirector('late2@x.test', mens)).status).toBe('pending');
  });

  it('forms a team when both partners have paid and named each other', async () => {
    const { tournamentId, mens } = await openTournament();
    const alex = await register(tournamentId, { first: 'Alex', last: 'Davis', email: 'alex@x.test' }, [
      { event_id: mens, partner_name: 'Ben Lee', partner_email: 'BEN@x.test' },
    ]);
    const ben = await register(tournamentId, { first: 'Ben', last: 'Lee', email: 'ben@x.test' }, [
      { event_id: mens, partner_name: 'Alex Davis', partner_email: 'alex@x.test' },
    ]);
    await pay(alex.registration_id, 4250);
    expect((await one(db, 'select public.get_registration($1) as r', [alex.registration_id])).r.entries[0].team_id).toBeNull();

    await pay(ben.registration_id, 4250);
    const teams = await rows(db, 'select * from public.teams where event_id = $1', [mens]);
    expect(teams.map((t) => t.name)).toEqual(['Lee/Davis']);
    const view = (await one(db, 'select public.get_registration($1) as r', [alex.registration_id])).r;
    expect(view).toMatchObject({ status: 'paid', entries: [{ team_name: 'Lee/Davis' }] });
  });

  it('lets the director pair players whose details did not match', async () => {
    const { tournamentId, mens, director } = await openTournament();
    const a = await register(tournamentId, { first: 'Alex', last: 'Davis', email: 'alex@x.test' }, [
      { event_id: mens, partner_name: 'Benny', partner_email: 'typo@x.test' },
    ]);
    const b = await register(tournamentId, { first: 'Ben', last: 'Lee', email: 'ben@x.test' }, [
      { event_id: mens, partner_name: 'Alex', partner_email: 'alex@x.test' },
    ]);
    await pay(a.registration_id, 4250);
    await pay(b.registration_id, 4250);
    expect(await rows(db, 'select * from public.teams where event_id = $1', [mens])).toHaveLength(0);

    await actAs(db, director);
    const team = await one(db, 'select * from public.pair_registrations($1, $2, $3)', [mens, a.registration_id, b.registration_id]);
    expect(team.name).toBe('Davis/Lee');
  });

  it('rejects wrong amounts, closed registration and double entry', async () => {
    const { tournamentId, mens } = await openTournament();
    const reg = await register(tournamentId, { first: 'Alex', last: 'Davis', email: 'alex@x.test' }, [
      { event_id: mens, partner_name: 'Ben Lee', partner_email: 'ben@x.test' },
    ]);
    await expect(pay(reg.registration_id, 100)).rejects.toThrow(/costs 4250/);
    await pay(reg.registration_id, 4250);
    await pay(reg.registration_id, 4250); // a repeated webhook is fine

    await expect(
      register(tournamentId, { first: 'Alex', last: 'Davis', email: 'ALEX@x.test' }, [
        { event_id: mens, partner_name: 'Ben Lee', partner_email: 'ben@x.test' },
      ]),
    ).rejects.toThrow(/already registered/);

    await db.query(`update public.tournaments set status = 'live' where id = $1`, [tournamentId]);
    await expect(
      register(tournamentId, { first: 'Zed', last: 'Q', email: 'z@x.test' }, [
        { event_id: mens, partner_name: 'Y', partner_email: 'y@x.test' },
      ]),
    ).rejects.toThrow(/not open/);
  });

  it('keeps payment functions away from the public', async () => {
    const { tournamentId, mens } = await openTournament();
    const reg = await register(tournamentId, { first: 'Alex', last: 'Davis', email: 'alex@x.test' }, [
      { event_id: mens, partner_name: 'Ben Lee', partner_email: 'ben@x.test' },
    ]);
    await asRole(db, 'anon', async () => {
      await expect(pay(reg.registration_id, 4250)).rejects.toThrow(/permission denied/);
      await expect(rows(db, 'select * from public.registrations')).rejects.toThrow(/permission denied/);
    });
  });
});

describe('division rules', () => {
  async function division(rules: Record<string, unknown>, kind = 'doubles') {
    const setup = await openTournament();
    const columns = ['tournament_id', 'name', 'kind', ...Object.keys(rules)];
    const e = await one(
      db,
      `insert into public.events (${columns.join(', ')})
       values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      [setup.tournamentId, 'Division', kind, ...Object.values(rules)],
    );
    return { ...setup, eventId: e.id as string };
  }
  const partner = (eventId: string) => [{ event_id: eventId, partner_name: 'P Q', partner_email: 'pq@x.test' }];

  it('checks age on tournament day or at year end', async () => {
    // Tournament day is 2026-11-07. Born 1976-12-15: 49 on tournament day, 50 by Dec 31.
    const tday = await division({ min_age: 50 });
    await expect(
      register(tday.tournamentId, { first: 'A', last: 'B', email: 'a@x.test', birth_date: '1976-12-15' }, partner(tday.eventId)),
    ).rejects.toThrow(/Division is for ages 50 and up/);

    const yearEnd = await division({ min_age: 50, age_basis: 'year_end' });
    await expect(
      register(yearEnd.tournamentId, { first: 'A', last: 'B', email: 'a@x.test', birth_date: '1976-12-15' }, partner(yearEnd.eventId)),
    ).resolves.toMatchObject({ status: 'pending' });

    await expect(
      register(yearEnd.tournamentId, { first: 'C', last: 'D', email: 'c@x.test' }, partner(yearEnd.eventId)),
    ).rejects.toThrow(/needs your date of birth/);
  });

  it('checks gender', async () => {
    const { tournamentId, eventId } = await division({ gender: 'mens' });
    await expect(
      register(tournamentId, { first: 'A', last: 'B', email: 'a@x.test', gender: 'female' }, partner(eventId)),
    ).rejects.toThrow(/is for men/);
    await expect(
      register(tournamentId, { first: 'A', last: 'B', email: 'a@x.test', gender: 'male' }, partner(eventId)),
    ).resolves.toBeTruthy();
  });

  it('applies skill rules: no playing down, playing up only when allowed', async () => {
    const only = await division({ skill_rule: 'only', skill_level: 3.5 });
    await expect(
      register(only.tournamentId, { first: 'A', last: 'B', email: 'a@x.test', dupr_doubles: 4.02 }, partner(only.eventId)),
    ).rejects.toThrow(/rated under 4.0/);
    await expect(
      register(only.tournamentId, { first: 'A', last: 'B', email: 'b@x.test', dupr_doubles: 3.2 }, partner(only.eventId)),
    ).rejects.toThrow(/rated 3.5 and up/);
    await expect(
      register(only.tournamentId, { first: 'A', last: 'B', email: 'c@x.test', dupr_doubles: 3.99 }, partner(only.eventId)),
    ).resolves.toBeTruthy();

    const playUp = await division({ skill_rule: 'only', skill_level: 3.5, allow_play_up: true });
    await expect(
      register(playUp.tournamentId, { first: 'A', last: 'B', email: 'd@x.test', dupr_doubles: 3.2 }, partner(playUp.eventId)),
    ).resolves.toBeTruthy();

    const dupr = await division({ skill_rule: 'and_under', skill_level: 3.0, rating_source: 'dupr' });
    await expect(
      register(dupr.tournamentId, { first: 'A', last: 'B', email: 'e@x.test', dupr_doubles: null as never, self_rating: 2.5 }, partner(dupr.eventId)),
    ).rejects.toThrow(/needs your DUPR rating/);
  });

  it('waitlists entries once an event fills up', async () => {
    const { tournamentId, eventId } = await division({ max_teams: 1 });
    await register(tournamentId, { first: 'A', last: 'B', email: 'a@x.test' }, partner(eventId));
    await register(tournamentId, { first: 'C', last: 'D', email: 'c@x.test' }, partner(eventId));
    await expect(register(tournamentId, { first: 'E', last: 'F', email: 'e@x.test' }, partner(eventId))).resolves.toMatchObject({
      status: 'waitlisted',
      amount_cents: 0,
    });
  });

  it('lets players register without a partner when allowed', async () => {
    const required = await division({});
    await expect(
      register(required.tournamentId, { first: 'A', last: 'B', email: 'a@x.test' }, [{ event_id: required.eventId }]),
    ).rejects.toThrow(/partner's name/);
    const optional = await division({ partner_required: false });
    await expect(
      register(optional.tournamentId, { first: 'A', last: 'B', email: 'a@x.test' }, [{ event_id: optional.eventId }]),
    ).resolves.toBeTruthy();
  });

  it('only pairs a man with a woman in mixed doubles', async () => {
    const { tournamentId, eventId, director } = await division({ gender: 'mixed', partner_required: false });
    const a = await register(tournamentId, { first: 'Al', last: 'A', email: 'a@x.test', gender: 'male' }, [{ event_id: eventId }]);
    const b = await register(tournamentId, { first: 'Bo', last: 'B', email: 'b@x.test', gender: 'male' }, [{ event_id: eventId }]);
    const c = await register(tournamentId, { first: 'Cy', last: 'C', email: 'c@x.test', gender: 'female' }, [{ event_id: eventId }]);
    for (const r of [a, b, c]) await pay(r.registration_id, 4250);

    await actAs(db, director);
    await expect(
      db.query('select public.pair_registrations($1, $2, $3)', [eventId, a.registration_id, b.registration_id]),
    ).rejects.toThrow(/one man and one woman/);
    const team = await one(db, 'select * from public.pair_registrations($1, $2, $3)', [eventId, a.registration_id, c.registration_id]);
    expect(team.name).toBe('A/C');
  });
});

describe('texts and score links', () => {
  async function liveMatch() {
    const setup = await createLiveTournament(db, { courts: 1, start: START });
    const eventId = await addEvent(db, setup.tournamentId, 'Open');
    const a = await addPair(db, eventId, ['Davis', 'Lee']);
    const b = await addPair(db, eventId, ['Park', 'Cho']);
    await checkIn(db, a);
    await checkIn(db, b);
    await generate(db, eventId);
    const [match] = await liveMatches(db, setup.tournamentId);
    return { ...setup, match, a, b };
  }

  it('records Twilio delivery reports against the sent text', async () => {
    await liveMatch();
    const [n] = await rows(db, 'select id from public.notifications order by id limit 1');
    await db.query(`select public.finish_notification($1, 'sms', '+15550100', 'hi', null)`, [n.id]);
    await db.query(`select public.set_notification_provider_id($1, 'SM123')`, [n.id]);
    await db.query(`select public.record_delivery_status('SM123', 'undelivered', 'Twilio error 30003')`);
    const [log] = await rows(db, 'select delivery_status, provider_id, error from public.notification_log where id = $1', [n.id]);
    expect(log).toEqual({ delivery_status: 'undelivered', provider_id: 'SM123', error: 'Twilio error 30003' });
  });

  it('tells each player who they play, with a link placeholder', async () => {
    await liveMatch();
    const texts = await rows(db, 'select body from public.notifications order by id');
    expect(texts.map((t) => t.body)).toEqual(
      expect.arrayContaining([
        'Your match is ready on COURT 1 versus Park/Cho. One game to 11, win by 2. Promptly report your scores here: {url} when finished.',
        'Your match is ready on COURT 1 versus Davis/Lee. One game to 11, win by 2. Promptly report your scores here: {url} when finished.',
      ]),
    );
  });

  it('hands each text to the sender once', async () => {
    const { match } = await liveMatch();
    const claimed = (await one(db, 'select public.claim_notifications(10) as r')).r;
    expect(claimed).toHaveLength(4);
    expect(claimed[0].report_code).toBe(match.report_code);
    expect((await one(db, 'select public.claim_notifications(10) as r')).r).toHaveLength(0);

    await db.query(`select public.finish_notification($1, 'log', '+15550001111', 'sent text', null)`, [claimed[0].id]);
    const log = await one(db, 'select * from public.notification_log where id = $1', [claimed[0].id]);
    expect([log.channel, log.body]).toEqual(['log', 'sent text']);
  });

  it('lets anyone with the link report the score once, but not read the code', async () => {
    const { match, tournamentId } = await liveMatch();
    await actAs(db, null);
    await asRole(db, 'anon', async () => {
      await expect(rows(db, 'select report_code from public.matches')).rejects.toThrow(/permission denied/);
      const info = (await one(db, 'select public.get_match_by_code($1) as m', [match.report_code])).m;
      expect([info.court_name, info.best_of, info.status]).toEqual(['Court 1', 1, 'in_progress']);

      await db.query('select public.report_score_by_code($1, $2::jsonb)', [match.report_code, '[[11, 10]]']);
      await expect(
        db.query('select public.report_score_by_code($1, $2::jsonb)', [match.report_code, '[[11, 3]]']),
      ).rejects.toThrow(/already reported/);
      await expect(db.query('select public.get_match_by_code($1)', ['nope'])).resolves.toBeTruthy();
      await expect(db.query('select public.report_score_by_code($1, $2::jsonb)', ['nope', '[[11, 3]]'])).rejects.toThrow(
        /isn't valid/,
      );
    });
    const done = await one(db, 'select status, games from public.matches where id = $1', [match.id]);
    expect([done.status, done.games]).toEqual(['completed', [[11, 10]]]);
    expect(tournamentId).toBeTruthy();
  });
});
