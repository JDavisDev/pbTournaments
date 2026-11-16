// Registration checkout. With STRIPE_SECRET_KEY (use a sk_test_ key while
// testing) players pay on Stripe Checkout, into the organization's own
// connected Stripe account (Stripe Connect, server/connect.ts), with
// Courtside's fee taken as Stripe's application fee; the webhook confirms
// payment. Without it, a built-in test checkout stands in, so the whole flow
// can be tried with no Stripe account.
import Stripe from 'stripe';
import { appUrl, serverRpc } from './serverRpc';

export type PaymentsMode = 'stripe' | 'test';

// The demo site never charges, whatever keys are set.
export const paymentsMode = (): PaymentsMode =>
  process.env.STRIPE_SECRET_KEY && process.env.NEXT_PUBLIC_DEMO_MODE !== '1' ? 'stripe' : 'test';

// Every Checkout Session's settings, as chosen in Stripe's Checkout Studio.
const checkoutSettings = {
  ui_mode: 'hosted_page',
  billing_address_collection: 'auto',
  phone_number_collection: { enabled: false },
  automatic_tax: { enabled: false },
  allow_promotion_codes: false,
  submit_type: 'auto',
  integration_identifier: 'hosted_web_0001',
  origin_context: 'web',
} satisfies Stripe.Checkout.SessionCreateParams;

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
  /** The organization's connected Stripe account, and whether Stripe lets it take payments. */
  stripe_account_id: string | null;
  payments_ready: boolean;
  /** Courtside's fee from this payment. */
  platform_fee_cents: number;
  /** The Stripe checkout already started for it, and the account it runs on. */
  checkout_session_id: string | null;
  checkout_account: string | null;
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
  if (paymentsMode() === 'stripe' && (!r.stripe_account_id || !r.payments_ready)) {
    throw new Error('This tournament can’t take card payments yet. Contact the director.');
  }
  // Stripe's smallest card payment.
  if (paymentsMode() === 'stripe' && r.amount_cents < 50) {
    throw new Error('Card payments start at $0.50. Contact the director to finish registering.');
  }

  // The 30-minute hold on the spots starts again now (the checkout closes
  // with it), unless it lapsed and someone else took them meanwhile.
  const hold = await serverRpc<{ ok: boolean; status: string; full?: string }>('renew_registration_hold', {
    p_registration: r.id,
  });
  if (hold.status === 'paid') return done;
  if (!hold.ok) {
    throw new Error(
      hold.full
        ? `${hold.full} filled up while this registration waited to be paid. Register again to join the waitlist.`
        : `This registration is ${hold.status}`,
    );
  }

  if (paymentsMode() === 'test') return `${appUrl()}/checkout/test?r=${r.id}`;
  const account = r.stripe_account_id;
  if (!account) throw new Error('This tournament can’t take card payments yet. Contact the director.');

  // One open checkout per registration, so the player can't pay twice (going
  // back from Stripe and pressing Pay again starts a new one).
  if (r.checkout_session_id && r.checkout_account) {
    const options = { stripeAccount: r.checkout_account };
    const previous = await stripe().checkout.sessions.retrieve(r.checkout_session_id, {}, options).catch(() => null);
    // Paid, and the webhook hasn't caught up yet.
    if (previous?.status === 'complete') return done;
    if (previous?.status === 'open') await stripe().checkout.sessions.expire(previous.id, {}, options).catch(() => null);
  }

  // A direct charge on the organization's account: the payment, its card fee,
  // refunds and disputes are theirs; Courtside's fee comes out of it.
  const session = await stripe().checkout.sessions.create(
    {
    ...checkoutSettings,
    mode: 'payment',
    // The hold just renewed lasts 30 minutes, so the checkout closes then too
    // (30 minutes is Stripe's shortest): a late payment can't overfill a division.
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
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
    payment_intent_data: {
      metadata: { registration_id: r.id },
      ...(r.platform_fee_cents > 0 ? { application_fee_amount: r.platform_fee_cents } : {}),
    },
    success_url: done,
    cancel_url: `${appUrl()}/t/${r.tournament_id}/register?cancelled=1`,
    },
    { stripeAccount: account },
  );
  await serverRpc('attach_checkout_session', {
    p_registration: r.id,
    p_session_id: session.id,
    p_account: account,
    p_platform_fee_cents: r.platform_fee_cents,
  });
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

/** `duplicate`: an earlier payment already covered it, so this one is extra. */
export const confirmSetupPayment = (tournamentId: string, provider: string, ref: string, amountCents: number) =>
  serverRpc<{ paid: boolean; already: boolean; duplicate: boolean }>('confirm_setup_payment', {
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

  return platformCheckout(tournamentId, 'setup', fee.amount_cents, done, () => ({
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
  }));
}

/**
 * A checkout for one of Courtside's fees, on Courtside's own account. The one
 * already open for the same amount is reused (a second tab, or Pay pressed
 * twice, goes to the same checkout), so it can't be paid twice; one for a
 * different amount is closed first. One just paid goes to `done`.
 */
async function platformCheckout(
  tournamentId: string,
  kind: 'setup' | 'fees',
  amountCents: number,
  done: string,
  params: () => Omit<Stripe.Checkout.SessionCreateParams, 'mode'>,
): Promise<string> {
  const previous = await serverRpc<{ session_id: string; amount_cents: number } | null>('platform_checkout', {
    p_tournament: tournamentId,
    p_kind: kind,
  });
  if (previous) {
    const session = await stripe().checkout.sessions.retrieve(previous.session_id).catch(() => null);
    // Paid, and the webhook hasn't caught up yet.
    if (session?.status === 'complete') return done;
    if (session?.status === 'open') {
      if (previous.amount_cents === amountCents && session.url) return session.url;
      await stripe().checkout.sessions.expire(session.id).catch(() => null);
    }
  }
  const session = await stripe().checkout.sessions.create({ ...checkoutSettings, mode: 'payment', ...params() });
  await serverRpc('save_platform_checkout', {
    p_tournament: tournamentId,
    p_kind: kind,
    p_session: session.id,
    p_amount_cents: amountCents,
  });
  return session.url!;
}

// ---------------------------------------------------------------------------
// Courtside's fee for players who didn't pay by card (paid by the director)
// ---------------------------------------------------------------------------

interface PlayerFees {
  tournament_id: string;
  tournament_name: string;
  amount_cents: number;
  players: number;
}

export const getPlayerFees = (tournamentId: string) =>
  serverRpc<PlayerFees | null>('player_fees_for_checkout', { p_tournament: tournamentId });

/** `excess_cents`: paid beyond what was owed, to give back. */
export const confirmPlayerFeesPayment = (tournamentId: string, provider: string, ref: string, amountCents: number) =>
  serverRpc<{ paid: boolean; already: boolean; excess_cents: number }>('confirm_player_fees_payment', {
    p_tournament: tournamentId,
    p_provider: provider,
    p_payment_ref: ref,
    p_amount_cents: amountCents,
  });

/** Where to send the director to pay what's owed. */
export async function startPlayerFeesCheckout(tournamentId: string): Promise<string> {
  const fees = await getPlayerFees(tournamentId);
  if (!fees) throw new Error('Tournament not found');
  const done = `${appUrl()}/t/${tournamentId}/finance?fees=paid`;
  if (fees.amount_cents === 0) return done;
  if (paymentsMode() === 'test') return `${appUrl()}/checkout/test?fees=${tournamentId}`;

  return platformCheckout(tournamentId, 'fees', fees.amount_cents, done, () => ({
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: fees.amount_cents,
          product_data: { name: `Player fees: ${fees.tournament_name}`, description: `${fees.players} players not paid by card` },
        },
      },
    ],
    metadata: { fees_tournament_id: tournamentId },
    payment_intent_data: { metadata: { fees_tournament_id: tournamentId } },
    success_url: done,
    cancel_url: `${appUrl()}/t/${tournamentId}/finance`,
  }));
}
