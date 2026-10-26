import { startSetupCheckout } from '@/server/payments';

/** Starts payment of a tournament's setup fee and returns where to send the director. */
export async function POST(request: Request) {
  const { tournamentId } = (await request.json()) as { tournamentId?: string };
  if (!tournamentId) return Response.json({ error: 'Missing tournament' }, { status: 400 });
  try {
    return Response.json({ url: await startSetupCheckout(tournamentId) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
