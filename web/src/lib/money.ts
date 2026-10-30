// Registrant money on the screens: what a withdrawal credits (the same rule as
// public.withdraw_registration) and how ledger lines and balances read.
import { formatMoney, priceAt } from './format';
import type { LedgerEntry, PaymentMethod, Tournament } from './types';

/** The event fee a registration paid: the price schedule's when it registered. */
export function extraEventFee(
  t: Pick<Tournament, 'entry_fee_cents' | 'extra_event_fee_cents' | 'first_event_included' | 'price_schedule' | 'time_zone'>,
  registeredAt: string,
) {
  return priceAt(t, registeredAt).event;
}

/**
 * What withdrawing credits this player: nothing for a waitlisted or unpaid
 * entry, or one their partner paid for (the partner gets it); the extra-event
 * fee for one of several events, and all that's left of what they paid for
 * their own events for the last one (or everything at once). Plus what they
 * paid for a partner who hasn't registered yet.
 */
export function withdrawalCredit(o: {
  paid: boolean;
  /** What the registration paid for its own events: its amount less what it paid for partners. */
  ownAmountCents: number;
  /** Already credited for earlier withdrawals from it. */
  creditedCents: number;
  /** Its entries that aren't waitlisted. */
  countedEntries: number;
  extraFeeCents: number;
  /** The entry; null for every event, with unusedPartnerCents summed over them. */
  entry: { waitlisted: boolean; paidByPartner: boolean } | null;
  /** Paid for partners who haven't registered, in the entries being withdrawn. */
  unusedPartnerCents: number;
}) {
  if (!o.paid || o.entry?.waitlisted) return 0;
  if (o.entry?.paidByPartner) return 0;
  const left = Math.max(0, o.ownAmountCents - o.creditedCents);
  const own = o.entry === null || o.countedEntries <= 1 ? left : Math.min(o.extraFeeCents, left);
  return own + o.unusedPartnerCents;
}

export const methodLabel: Record<PaymentMethod, string> = {
  stripe: 'card (Stripe)',
  test: 'test checkout',
  cash: 'cash',
  check: 'check',
  other: 'other',
};

/** "Paid by card (Stripe)", "Withdrew from Men's 3.5", "Discount CLUB10"… */
export function describeLedger(l: LedgerEntry) {
  const by = l.method ? ` by ${methodLabel[l.method]}` : '';
  switch (l.kind) {
    case 'entry_fees':
      // A partner's entry paid along with your own carries its own note.
      return l.note ?? 'Entry fees';
    case 'discount':
      return `Discount${l.note ? ` ${l.note}` : ''}`;
    case 'payment':
      return `Paid${by}`;
    case 'withdrawal':
      return l.note ?? 'Withdrawal';
    case 'refund':
      return `Refunded${by}`;
    case 'fee':
      return l.note ?? 'Fee';
    case 'credit':
      return l.note ?? 'Credit';
  }
}

/** Who owes whom, from the director's side. */
export function balanceText(cents: number) {
  if (cents > 0) return `Owes ${formatMoney(cents)}`;
  if (cents < 0) return `Owed ${formatMoney(-cents)}`;
  return 'Settled';
}
