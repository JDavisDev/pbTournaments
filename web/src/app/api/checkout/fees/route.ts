import { startPlayerFeesCheckout } from '@/server/payments';

/** Starts payment of Courtside's fees for players who didn't pay by card. */
export async function POST(request: Request) {
  const { tournamentId } = (await request.json()) as { tournamentId?: string };
  if (!tournamentId) return Response.json({ error: 'Missing tournament' }, { status: 400 });
  try {
    return Response.json({ url: await startPlayerFeesCheckout(tournamentId) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
