// Stripe Connect: each organization connects its own Stripe account and
// players pay into it (server/payments.ts). Onboarding is Stripe's hosted
// form (Account Links); account.updated keeps whether it can take payments.
// Payouts are held (a manual payout schedule): players' money stays in the
// account's Stripe balance until the owner pays it out after the tournament,
// so refunds come out of it. It's a soft hold: a Standard account's owner can
// still pay out from their own Stripe dashboard.
// Without Stripe keys, a pretend test account is connected at once.
import type Stripe from 'stripe';
import type { PayoutBalance } from '@/lib/types';
import { paymentsMode, stripe } from './payments';
import { appUrl, serverRpc } from './serverRpc';

export interface PaymentSetup {
  organization_id: string;
  organization_name: string;
  stripe_account_id: string | null;
  email: string | null;
}

const testAccount = (organizationId: string) => `acct_test_${organizationId.replace(/-/g, '').slice(0, 16)}`;

const save = (organizationId: string, account: string, ready: boolean, submitted: boolean) =>
  serverRpc('save_payment_account', {
    p_organization: organizationId,
    p_account: account,
    p_ready: ready,
    p_details_submitted: submitted,
  });

/** Where to send the owner: Stripe's onboarding form, or straight back in test mode. */
export async function startOnboarding(tournamentId: string, setup: PaymentSetup): Promise<string> {
  const setupPage = `${appUrl()}/t/${tournamentId}/setup`;
  if (paymentsMode() === 'test') {
    await save(setup.organization_id, setup.stripe_account_id ?? testAccount(setup.organization_id), true, true);
    return `${setupPage}?payments=connected`;
  }
  let account = setup.stripe_account_id;
  // A pretend account from before Stripe was set up is replaced by a real one.
  if (!account || account.startsWith('acct_test_')) {
    const created = await stripe().accounts.create({
      type: 'standard',
      email: setup.email ?? undefined,
      business_profile: { name: setup.organization_name },
      metadata: { organization_id: setup.organization_id },
    });
    account = created.id;
    await save(setup.organization_id, account, false, false);
    await holdPayouts(account).catch((err: Error) => console.error(`Couldn’t hold payouts for ${account}: ${err.message}`));
  }
  const link = await stripe().accountLinks.create({
    account,
    type: 'account_onboarding',
    refresh_url: `${setupPage}?payments=retry`,
    return_url: `${appUrl()}/api/connect/return?t=${tournamentId}`,
  });
  return link.url;
}

export const updateAccountStatus = (account: Stripe.Account) =>
  serverRpc('update_payment_account', {
    p_account: account.id,
    p_ready: account.charges_enabled,
    p_details_submitted: account.details_submitted,
  });

/** After onboarding: ask Stripe how the tournament's account stands. */
export async function refreshAccountStatus(tournamentId: string) {
  if (paymentsMode() !== 'stripe') return;
  const found = await serverRpc<{ stripe_account_id: string | null } | null>('payment_account_for_tournament', {
    p_tournament: tournamentId,
  });
  if (!found?.stripe_account_id || found.stripe_account_id.startsWith('acct_test_')) return;
  const account = await stripe().accounts.retrieve(found.stripe_account_id);
  await updateAccountStatus(account);
  // In case holding them failed when the account was made.
  if (account.settings?.payouts?.schedule?.interval !== 'manual') {
    await holdPayouts(account.id).catch((err: Error) => console.error(`Couldn’t hold payouts for ${account.id}: ${err.message}`));
  }
}

/**
 * Manual payouts: Stripe keeps the balance until we pay it out. Needs
 * Connect → Payouts → schedules in Courtside's Stripe dashboard to let the
 * platform manage connected accounts' payout schedules.
 */
export const holdPayouts = (account: string) =>
  stripe().accounts.update(account, { settings: { payouts: { schedule: { interval: 'manual' } } } });

/** The organization's Stripe balance in US dollars. */
export async function payoutBalance(account: string | null): Promise<PayoutBalance> {
  if (paymentsMode() === 'test' || !account || account.startsWith('acct_test_')) {
    return { available_cents: 0, pending_cents: 0, held: true, test: true };
  }
  const [balance, acct] = await Promise.all([
    stripe().balance.retrieve({}, { stripeAccount: account }),
    stripe().accounts.retrieve(account),
  ]);
  const usd = (list: { amount: number; currency: string }[]) =>
    list.filter((b) => b.currency === 'usd').reduce((sum, b) => sum + b.amount, 0);
  return {
    available_cents: usd(balance.available),
    pending_cents: usd(balance.pending),
    held: acct.settings?.payouts?.schedule?.interval === 'manual',
    test: false,
  };
}

/** Pays the whole available balance out to the organization's bank. Returns the amount. */
export async function payOutAll(account: string | null): Promise<number> {
  const { available_cents, test } = await payoutBalance(account);
  if (test) throw new Error('Test mode: there’s no real balance to pay out');
  if (available_cents <= 0) throw new Error('Nothing is ready to pay out yet');
  await stripe().payouts.create({ amount: available_cents, currency: 'usd' }, { stripeAccount: account! });
  return available_cents;
}
