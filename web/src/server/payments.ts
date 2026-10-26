// Registration checkout. With STRIPE_SECRET_KEY (use a sk_test_ key while
// testing) players pay on Stripe Checkout and the webhook confirms payment.
// Without it, a built-in test checkout stands in, so the whole flow can be
// tried with no Stripe account.
import Stripe from 'stripe';
import { appUrl, serverRpc } from './serverRpc';

export type PaymentsMode = 'stripe' | 'test';

// The demo site never charges, whatever keys are set.
export const paymentsMode = (): PaymentsMode =>
  process.env.STRIPE_SECRET_KEY && process.env.NEXT_PUBLIC_DEMO_MODE !== '1' ? 'stripe' : 'test';

let stripeClient: Stripe | null = null;
export function stripe(): Stripe {
  stripeClient ??= new Stripe(process.env.STRIPE_SECRET_KEY!);
  return stripeClient;
}

interface RegistrationView {
  id: string;
  tournament_id: string;
  tournament_name: string;
  status: 'pending' | 'paid' | 'cancelled' | 'refunded';
  amount_cents: number;
  player_name: string;
  email: string;
  entries: { event_name: string }[];
}

export const getRegistration = (id: string) =>
  serverRpc<RegistrationView | null>('registration_for_checkout', { p_registration: id });

/** Where to send the player to pay. */
export async function startCheckout(registrationId: string): Promise<string> {
  const r = await getRegistration(registrationId);
  if (!r) throw new Error('Registration not found');
  const done = `${appUrl()}/t/${r.tournament_id}/register/done?r=${r.id}`;
  if (r.status === 'paid') return done;
  if (r.status !== 'pending') throw new Error(`This registration is ${r.status}`);

  if (paymentsMode() === 'test') return `${appUrl()}/checkout/test?r=${r.id}`;

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer_email: r.email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: r.amount_cents,
          product_data: {
            name: `${r.tournament_name} registration`,
            description: `${r.player_name}: ${r.entries.map((e) => e.event_name).join(', ')}`,
          },
        },
      },
    ],
    metadata: { registration_id: r.id },
    payment_intent_data: { metadata: { registration_id: r.id } },
    success_url: done,
    cancel_url: `${appUrl()}/t/${r.tournament_id}/register?cancelled=1`,
  });
  await serverRpc('attach_checkout_session', { p_registration: r.id, p_session_id: session.id });
  return session.url!;
}

export const confirmPayment = (registrationId: string, provider: string, ref: string, amountCents: number) =>
  serverRpc('confirm_registration_payment', {
    p_registration: registrationId,
    p_provider: provider,
    p_payment_ref: ref,
    p_amount_cents: amountCents,
  });

// ---------------------------------------------------------------------------
// The tournament setup fee (paid by the director, once per tournament)
// ---------------------------------------------------------------------------

interface SetupFee {
  tournament_id: string;
  tournament_name: string;
  amount_cents: number;
  paid: boolean;
}

export const getSetupFee = (tournamentId: string) =>
  serverRpc<SetupFee | null>('setup_fee_for_checkout', { p_tournament: tournamentId });

export const confirmSetupPayment = (tournamentId: string, provider: string, ref: string, amountCents: number) =>
  serverRpc('confirm_setup_payment', {
    p_tournament: tournamentId,
    p_provider: provider,
    p_payment_ref: ref,
    p_amount_cents: amountCents,
  });

/** Where to send the director to pay the setup fee. */
export async function startSetupCheckout(tournamentId: string): Promise<string> {
  const fee = await getSetupFee(tournamentId);
  if (!fee) throw new Error('Tournament not found');
  const done = `${appUrl()}/t/${tournamentId}/setup?setup=paid`;
  if (fee.paid || fee.amount_cents === 0) return done;
  if (paymentsMode() === 'test') return `${appUrl()}/checkout/test?setup=${tournamentId}`;

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: fee.amount_cents,
          product_data: { name: `Tournament setup: ${fee.tournament_name}` },
        },
      },
    ],
    metadata: { setup_tournament_id: tournamentId },
    payment_intent_data: { metadata: { setup_tournament_id: tournamentId } },
    success_url: done,
    cancel_url: `${appUrl()}/t/${tournamentId}/setup`,
  });
  return session.url!;
}
