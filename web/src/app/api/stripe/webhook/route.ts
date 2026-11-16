import type Stripe from 'stripe';
import { updateAccountStatus } from '@/server/connect';
import { confirmPlayerFeesPayment, confirmSetupPayment, confirmPayment, getRegistration, stripe } from '@/server/payments';
import { serverRpc } from '@/server/serverRpc';

/**
 * Stripe calls this when a checkout completes, and when a payment is
 * refunded or disputed. Two webhooks point here (docs/payments.md):
 *   - your account's (setup and player fees): STRIPE_WEBHOOK_SECRET, event checkout.session.completed;
 *   - connected accounts' (registrations, account status): STRIPE_CONNECT_WEBHOOK_SECRET, events
 *     checkout.session.completed, account.updated, charge.refunded, charge.dispute.created and
 *     charge.dispute.closed.
 * Locally: stripe listen --forward-to localhost:3000/api/stripe/webhook (add --forward-connect-to for both).
 *
 * Connected accounts are the organizations' own Stripe accounts, and they can make
 * checkouts of their own with any metadata. So Courtside's fees only count when paid
 * to Courtside's account, and a registration only when paid to the account its
 * checkout was started on.
 *
 * A payment that can't be applied (the registration was cancelled, or its price
 * changed while checkout was open) is noted for the director (stripe_notices) and
 * acknowledged: retrying wouldn't change it. Only a failure on our side (the
 * database unreachable) answers 500, so Stripe tries again.
 */
export async function POST(request: Request) {
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean) as string[];
  if (!process.env.STRIPE_SECRET_KEY || secrets.length === 0) return new Response('Stripe is not configured', { status: 404 });

  const body = await request.text();
  const signature = request.headers.get('stripe-signature') ?? '';
  let event: Stripe.Event | null = null;
  for (const secret of secrets) {
    try {
      event = stripe().webhooks.constructEvent(body, signature, secret);
      break;
    } catch {}
  }
  if (!event) return new Response('Bad signature', { status: 400 });
  const account = event.account ?? null;

  try {
    switch (event.type) {
      case 'account.updated':
        await updateAccountStatus(event.data.object);
        break;
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await checkoutPaid(event.data.object, account);
        break;
      case 'charge.refunded':
        if (account) await chargeRefunded(event.data.object, account);
        break;
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
        if (account) await chargeDisputed(event.data.object, account);
        break;
    }
  } catch (err) {
    // A 500 makes Stripe retry, which is what we want for a database hiccup.
    return new Response((err as Error).message, { status: 500 });
  }
  return Response.json({ received: true });
}

const intentId = (pi: string | Stripe.PaymentIntent | null) => (typeof pi === 'string' ? pi : (pi?.id ?? null));

/** `account`: the connected account it was paid to, or null for Courtside's own. */
async function checkoutPaid(session: Stripe.Checkout.Session, account: string | null) {
  if (session.payment_status !== 'paid') return;
  const { registration_id: registrationId, setup_tournament_id: setupTournamentId, fees_tournament_id: feesTournamentId } =
    session.metadata ?? {};
  const amount = session.amount_total ?? 0;
  const intent = intentId(session.payment_intent);

  if (feesTournamentId && !account) {
    const { excess_cents } = await confirmPlayerFeesPayment(feesTournamentId, 'stripe', session.id, amount);
    // Paid more than was owed by then (a second checkout, fewer players): give the rest back.
    if (excess_cents > 0 && intent) {
      await stripe().refunds.create(
        { payment_intent: intent, amount: excess_cents, metadata: { courtside: 'fees_excess', tournament_id: feesTournamentId } },
        { idempotencyKey: `fees-excess-${session.id}` },
      );
    }
  }
  if (setupTournamentId && !account) {
    const { duplicate } = await confirmSetupPayment(setupTournamentId, 'stripe', session.id, amount);
    // Already paid by an earlier checkout: this one goes back in full.
    if (duplicate && intent) {
      await stripe().refunds.create(
        { payment_intent: intent, metadata: { courtside: 'setup_duplicate', tournament_id: setupTournamentId } },
        { idempotencyKey: `setup-duplicate-${session.id}` },
      );
    }
  }
  if (registrationId && account) {
    const r = await getRegistration(registrationId);
    if (!r || r.checkout_account !== account) {
      console.warn(`Ignored a payment for registration ${registrationId} on ${account}: its checkout ran on ${r?.checkout_account ?? 'no account'}`);
      return;
    }
    // Why it can't be applied, if it can't.
    const problem =
      r.status === 'paid'
        ? r.checkout_session_id === session.id
          ? null
          : 'Paid again: this registration was already paid.'
        : r.status !== 'pending'
          ? `The registration was ${r.status} before this payment arrived.`
          : amount !== r.amount_cents
            ? `Paid ${money(amount)}, but the registration now costs ${money(r.amount_cents)}.`
            : null;
    if (problem) {
      await serverRpc('record_unmatched_payment', {
        p_registration: r.id,
        p_session: session.id,
        p_account: account,
        p_payment_intent: intent,
        p_amount_cents: amount,
        p_detail: problem,
      });
      return;
    }
    await confirmPayment(registrationId, 'stripe', session.id, amount);
  }
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The registration a payment on a connected account was for (its payment's metadata). */
async function registrationOf(intent: string | null, account: string) {
  if (!intent) return null;
  const pi = await stripe().paymentIntents.retrieve(intent, {}, { stripeAccount: account });
  return pi.metadata?.registration_id ?? null;
}

/** Refunds of a registration payment, including ones made in the Stripe dashboard. */
async function chargeRefunded(charge: Stripe.Charge, account: string) {
  const intent = intentId(charge.payment_intent);
  const registrationId = await registrationOf(intent, account);
  if (!registrationId) return;
  const refunds = await stripe().refunds.list({ charge: charge.id, limit: 100 }, { stripeAccount: account });
  for (const refund of refunds.data) {
    if (refund.status === 'failed' || refund.status === 'canceled') continue;
    await serverRpc('record_stripe_refund', {
      p_registration: registrationId,
      p_account: account,
      p_payment_intent: intent,
      p_refund: refund.id,
      p_amount_cents: refund.amount,
      // Made from the Players page (server/refunds.ts), which records it itself.
      p_ours: refund.metadata?.courtside === 'refund',
    });
  }
}

/** A cardholder disputed a registration payment, or the dispute ended. */
async function chargeDisputed(dispute: Stripe.Dispute, account: string) {
  const intent = intentId(dispute.payment_intent);
  const registrationId = await registrationOf(intent, account);
  if (!registrationId) return;
  await serverRpc('record_stripe_dispute', {
    p_registration: registrationId,
    p_account: account,
    p_payment_intent: intent,
    p_dispute: dispute.id,
    p_amount_cents: dispute.amount,
    p_status: dispute.status,
    p_reason: dispute.reason ?? null,
  });
}
