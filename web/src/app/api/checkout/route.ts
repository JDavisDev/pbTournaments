import { startCheckout } from '@/server/payments';

/** Starts payment for a pending registration and returns where to send the player. */
export async function POST(request: Request) {
  const { registrationId } = (await request.json()) as { registrationId?: string };
  if (!registrationId) return Response.json({ error: 'Missing registration' }, { status: 400 });
  try {
    return Response.json({ url: await startCheckout(registrationId) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
