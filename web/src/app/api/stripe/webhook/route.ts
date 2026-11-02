import type Stripe from 'stripe';
import { updateAccountStatus } from '@/server/connect';
import { confirmPlayerFeesPayment, confirmSetupPayment, confirmPayment, stripe } from '@/server/payments';

/**
 * Stripe calls this when a checkout completes. Two webhooks point here (docs/payments.md):
 *   - your account's (setup and player fees): STRIPE_WEBHOOK_SECRET, event checkout.session.completed;
 *   - connected accounts' (registrations, account status): STRIPE_CONNECT_WEBHOOK_SECRET,
 *     events checkout.session.completed and account.updated.
 * Locally: stripe listen --forward-to localhost:3000/api/stripe/webhook (add --forward-connect-to for both).
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

  if (event.type === 'account.updated') {
    try {
      await updateAccountStatus(event.data.object);
    } catch (err) {
      return new Response((err as Error).message, { status: 500 });
    }
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const registrationId = session.metadata?.registration_id;
    const setupTournamentId = session.metadata?.setup_tournament_id;
    const feesTournamentId = session.metadata?.fees_tournament_id;
    if (feesTournamentId && session.payment_status === 'paid') {
      try {
        await confirmPlayerFeesPayment(feesTournamentId, 'stripe', session.id, session.amount_total ?? 0);
      } catch (err) {
        return new Response((err as Error).message, { status: 500 });
      }
    }
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
