import { refreshAccountStatus } from '@/server/connect';
import { appUrl } from '@/server/serverRpc';

/** Stripe sends the owner back here after onboarding: note how the account stands, then back to Setup. */
export async function GET(request: Request) {
  const tournamentId = new URL(request.url).searchParams.get('t');
  if (!tournamentId || !/^[0-9a-f-]{36}$/.test(tournamentId)) return new Response('Missing tournament', { status: 400 });
  await refreshAccountStatus(tournamentId).catch((err: Error) => console.error(`Stripe account check failed: ${err.message}`));
  return Response.redirect(`${appUrl()}/t/${tournamentId}/setup?payments=return`, 303);
}
