import type Stripe from 'stripe';
import { updateAccountStatus } from '@/server/connect';
import { confirmPlayerFeesPayment, confirmSetupPayment, confirmPayment, getRegistration, stripe } from '@/server/payments';

/**
 * Stripe calls this when a checkout completes. Two webhooks point here (docs/payments.md):
 *   - your account's (setup and player fees): STRIPE_WEBHOOK_SECRET, event checkout.session.completed;
 *   - connected accounts' (registrations, account status): STRIPE_CONNECT_WEBHOOK_SECRET,
 *     events checkout.session.completed and account.updated.
 * Locally: stripe listen --forward-to localhost:3000/api/stripe/webhook (add --forward-connect-to for both).
 *
 * Connected accounts are the organizations' own Stripe accounts, and they can make
 * checkouts of their own with any metadata. So Courtside's fees only count when paid
 * to Courtside's account, and a registration only when paid to the account its
 * checkout was started on.
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

  try {
    if (event.type === 'account.updated') await updateAccountStatus(event.data.object);
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await checkoutPaid(event.data.object, event.account ?? null);
    }
  } catch (err) {
    // A 500 makes Stripe retry, which is what we want for a database hiccup.
    return new Response((err as Error).message, { status: 500 });
  }
  return Response.json({ received: true });
}

/** `account`: the connected account it was paid to, or null for Courtside's own. */
async function checkoutPaid(session: Stripe.Checkout.Session, account: string | null) {
  if (session.payment_status !== 'paid') return;
  const { registration_id: registrationId, setup_tournament_id: setupTournamentId, fees_tournament_id: feesTournamentId } =
    session.metadata ?? {};
  const amount = session.amount_total ?? 0;
  if (feesTournamentId && !account) await confirmPlayerFeesPayment(feesTournamentId, 'stripe', session.id, amount);
  if (setupTournamentId && !account) await confirmSetupPayment(setupTournamentId, 'stripe', session.id, amount);
  if (registrationId && account) {
    const r = await getRegistration(registrationId);
    if (r?.checkout_account !== account) {
      console.warn(`Ignored a payment for registration ${registrationId} on ${account}: its checkout ran on ${r?.checkout_account ?? 'no account'}`);
      return;
    }
    await confirmPayment(registrationId, 'stripe', session.id, amount);
  }
}
