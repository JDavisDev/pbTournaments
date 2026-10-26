import type Stripe from 'stripe';
import { confirmSetupPayment, confirmPayment, stripe } from '@/server/payments';

/**
 * Stripe calls this when a checkout completes. Point a webhook at
 * /api/stripe/webhook (event: checkout.session.completed) and set
 * STRIPE_WEBHOOK_SECRET. Locally: stripe listen --forward-to localhost:3000/api/stripe/webhook
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!process.env.STRIPE_SECRET_KEY || !secret) return new Response('Stripe is not configured', { status: 404 });

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(await request.text(), request.headers.get('stripe-signature') ?? '', secret);
  } catch (err) {
    return new Response(`Bad signature: ${(err as Error).message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const registrationId = session.metadata?.registration_id;
    const setupTournamentId = session.metadata?.setup_tournament_id;
    if (setupTournamentId && session.payment_status === 'paid') {
      try {
        await confirmSetupPayment(setupTournamentId, 'stripe', session.id, session.amount_total ?? 0);
      } catch (err) {
        return new Response((err as Error).message, { status: 500 });
      }
    }
    if (registrationId && session.payment_status === 'paid') {
      try {
        await confirmPayment(registrationId, 'stripe', session.id, session.amount_total ?? 0);
      } catch (err) {
        // A 500 makes Stripe retry, which is what we want for a database hiccup.
        return new Response((err as Error).message, { status: 500 });
      }
    }
  }
  return Response.json({ received: true });
}
