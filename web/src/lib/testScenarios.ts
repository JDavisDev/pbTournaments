'use client';

// Test menu: tournaments ready to register for, built with the same calls a
// director's screens make. They're practice tournaments, so nothing is charged.
import {
  addDiscountCode,
  deleteEvent,
  getEvents,
  newTournament,
  saveEvent,
  saveRegistrationQuestion,
  setTournamentStatus,
  startRegistration,
  updateTournament,
} from './api';
import { auth } from './auth';
import type { TournamentEvent } from './types';

const division = (tournament_id: string, fields: Partial<TournamentEvent>) =>
  saveEvent({
    tournament_id,
    kind: 'doubles',
    gender: 'open',
    format: 'round_robin',
    skill_rule: 'open',
    partner_required: false,
    ...fields,
  });

async function build(name: string, fees: { entry: number; extra: number }) {
  // The shared guest owns test tournaments, so test players are only players there.
  await auth.signInAsGuest();
  const t = await newTournament(null);
  for (const e of await getEvents(t.id)) await deleteEvent(e.id);
  await updateTournament(t.id, {
    name,
    entry_fee_cents: fees.entry,
    extra_event_fee_cents: fees.extra,
    location: 'Test Pickleball Center, Denver',
    state: 'CO',
    ball: 'Franklin X-40',
  });
  return t.id;
}

async function open(id: string) {
  await setTournamentStatus(id, 'registration');
  // Back to signed out: registering as a player, not as the director who built it.
  await auth.signOut();
  return id;
}

export const scenarios = [
  {
    key: 'free',
    label: 'Simple and free',
    hint: 'Two open divisions, no fee, no waiver.',
    run: async () => {
      const id = await build('Test: simple and free', { entry: 0, extra: 0 });
      await division(id, { name: 'Open Doubles' });
      await division(id, { name: 'Open Singles', kind: 'singles' });
      return open(id);
    },
  },
  {
    key: 'full',
    label: 'Everything on',
    hint: 'Fees, waiver, a question, code TEST10, and gender, age and skill divisions.',
    run: async () => {
      const id = await build('Test: everything on', { entry: 4250, extra: 1550 });
      await updateTournament(id, {
        waiver_text: 'Test waiver: I play at my own risk.',
        refund_policy: 'Test policy: refunds until a week before.',
      });
      await division(id, { name: 'Open Doubles' });
      await division(id, { name: 'Mixed Doubles', gender: 'mixed', partner_required: true });
      await division(id, { name: "Women's Doubles", gender: 'womens' });
      await division(id, { name: 'Over 50 Doubles', min_age: 50 });
      await division(id, { name: 'Doubles 3.5', skill_rule: 'only', skill_level: '3.5' });
      await saveRegistrationQuestion({
        tournament_id: id,
        label: 'Shirt size',
        kind: 'choice',
        options: ['S', 'M', 'L'],
        required: true,
        sort_order: 1,
      });
      await addDiscountCode({
        tournament_id: id,
        code: 'TEST10',
        percent_off: 10,
        amount_off_cents: null,
        max_uses: null,
        expires_at: null,
      });
      return open(id);
    },
  },
  {
    key: 'waitlist',
    label: 'Full division',
    hint: 'Singles is already full, so you join the waitlist.',
    run: async () => {
      const id = await build('Test: full division', { entry: 0, extra: 0 });
      const singles = await division(id, { name: 'Singles (full)', kind: 'singles', max_teams: 1 });
      await division(id, { name: 'Open Doubles' });
      await setTournamentStatus(id, 'registration');
      await startRegistration(id, {
        player: {
          first_name: 'Already',
          last_name: 'Entered',
          email: 'already.entered@example.test',
          phone: '',
          sms_opt_in: false,
          gender: null,
          birth_date: null,
          dupr_doubles: null,
          dupr_singles: null,
          self_rating: null,
          dupr_id: 'TEST01',
          terms_accepted: true,
        },
        entries: [{ event_id: singles.id }],
      });
      return open(id);
    },
  },
];
