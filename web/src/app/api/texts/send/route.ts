import { sendPendingTexts } from '@/server/texts';

// Sending stops itself after about 20 seconds (server/texts.ts); this leaves room.
export const maxDuration = 60;

/**
 * Delivers queued texts. Call it every minute or so from a scheduler (Vercel
 * Cron, or Supabase pg_cron + pg_net) with "Authorization: Bearer $CRON_SECRET".
 * Local mode runs it automatically every few seconds.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  try {
    return Response.json({ handled: await sendPendingTexts() });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
