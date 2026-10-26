import { confirmPayment, confirmSetupPayment, getRegistration, getSetupFee, paymentsMode } from '@/server/payments';
import { appUrl } from '@/server/serverRpc';

/**
 * The test checkout's Pay button. Only exists while no Stripe key is set, so
 * it can never mark a real registration paid.
 */
export async function POST(request: Request) {
  if (paymentsMode() !== 'test') return new Response('Not found', { status: 404 });
  const { registrationId, setupTournamentId, outcome } = (await request.json()) as {
    registrationId?: string;
    setupTournamentId?: string;
    outcome?: 'pay' | 'cancel';
  };
  try {
    if (setupTournamentId) {
      const fee = await getSetupFee(setupTournamentId);
      if (!fee) throw new Error('Tournament not found');
      if (outcome === 'pay') await confirmSetupPayment(setupTournamentId, 'test', `test_setup_${setupTournamentId}`, fee.amount_cents);
      return Response.json({ url: `${appUrl()}/t/${setupTournamentId}/setup${outcome === 'pay' ? '?setup=paid' : ''}` });
    }
    const r = registrationId ? await getRegistration(registrationId) : null;
    if (!r) throw new Error('Registration not found');
    if (outcome === 'pay') {
      await confirmPayment(r.id, 'test', `test_${r.id}`, r.amount_cents);
      return Response.json({ url: `${appUrl()}/t/${r.tournament_id}/register/done?r=${r.id}` });
    }
    return Response.json({ url: `${appUrl()}/t/${r.tournament_id}/register?cancelled=1` });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
