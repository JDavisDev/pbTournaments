// Refunds to the player's card, from the Players page. Each goes back to the
// card payments it came from (newest first), on the organization's own Stripe
// account. Courtside's fee from the payment isn't refunded, and Stripe keeps
// its card fee, so the tournament covers those; it can also keep its refund fee.
import { randomUUID } from 'node:crypto';
import { paymentsMode, stripe } from './payments';

export interface RefundPlan {
  owed_cents: number;
  refund_fee_cents: number;
  payments: {
    registration_id: string;
    provider: 'stripe' | 'test';
    payment_ref: string;
    stripe_account_id: string | null;
    refundable_cents: number;
  }[];
}

export interface CardRefund {
  registration_id: string;
  amount_cents: number;
  refund_id: string;
  method: 'stripe' | 'test';
}

/**
 * Checks the amounts, then refunds on Stripe (or pretends, for test payments).
 * Returns what went through, to record, and the error that stopped the rest:
 * a refund split over several payments can fail part way.
 */
export async function refundToCard(
  plan: RefundPlan,
  amountCents: number,
  keepCents: number,
): Promise<{ refunds: CardRefund[]; error: Error | null }> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Enter an amount more than $0');
  if (!Number.isInteger(keepCents) || keepCents < 0) throw new Error('The refund fee can’t be negative');
  if (amountCents + keepCents > plan.owed_cents) {
    throw new Error(`That’s more than the $${(plan.owed_cents / 100).toFixed(2)} they’re owed. Add a credit first to refund more.`);
  }
  const refundable = plan.payments.reduce((sum, p) => sum + Math.max(0, p.refundable_cents), 0);
  if (amountCents > refundable) {
    throw new Error(`Only $${(refundable / 100).toFixed(2)} of their card payments is left to refund.`);
  }

  const refunds: CardRefund[] = [];
  let left = amountCents;
  try {
    for (const p of plan.payments) {
      if (left === 0) break;
      const part = Math.min(left, Math.max(0, p.refundable_cents));
      if (part === 0) continue;
      if (p.provider === 'test') {
        refunds.push({ registration_id: p.registration_id, amount_cents: part, refund_id: `test_re_${randomUUID()}`, method: 'test' });
      } else {
        if (paymentsMode() !== 'stripe' || !p.stripe_account_id) throw new Error('Stripe isn’t set up on this site, so card refunds can’t go through.');
        const options = { stripeAccount: p.stripe_account_id };
        const session = await stripe().checkout.sessions.retrieve(p.payment_ref, {}, options);
        const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        if (!intent) throw new Error('Couldn’t find that card payment on Stripe.');
        const refund = await stripe().refunds.create(
          { payment_intent: intent, amount: part, metadata: { registration_id: p.registration_id } },
          // The same click twice makes one refund.
          { ...options, idempotencyKey: `refund-${p.registration_id}-${p.refundable_cents}-${part}` },
        );
        refunds.push({ registration_id: p.registration_id, amount_cents: part, refund_id: refund.id, method: 'stripe' });
      }
      left -= part;
    }
  } catch (err) {
    return { refunds, error: err as Error };
  }
  return { refunds, error: null };
}
