// Stripe Connect: each organization connects its own Stripe account and
// players pay into it (server/payments.ts). Onboarding is Stripe's hosted
// form (Account Links); account.updated keeps whether it can take payments.
// Without Stripe keys, a pretend test account is connected at once.
import type Stripe from 'stripe';
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
  await updateAccountStatus(await stripe().accounts.retrieve(found.stripe_account_id));
}
