import { createClient } from '@supabase/supabase-js';
import { refundToCard, type RefundPlan } from '@/server/refunds';
import { serverRpc } from '@/server/serverRpc';

/** Staff: refund a player to their card. Body: {tournamentId, playerId, amountCents, keepCents}. */
export async function POST(request: Request) {
  const { tournamentId, playerId, amountCents, keepCents } = (await request.json()) as {
    tournamentId?: string;
    playerId?: string;
    amountCents?: number;
    keepCents?: number;
  };
  const authorization = request.headers.get('authorization');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!tournamentId || !playerId) return Response.json({ error: 'Missing player' }, { status: 400 });
  if (!authorization) return Response.json({ error: 'Log in first' }, { status: 401 });
  if (!url || !key) return Response.json({ error: 'Supabase is not configured' }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false }, global: { headers: { authorization } } });
  const { data: who } = await db.auth.getUser(authorization.replace(/^Bearer /, ''));

  // Checks they're on the tournament's staff.
  const { data: plan, error } = await db.rpc('card_refund_plan', { p_tournament: tournamentId, p_player: playerId });
  if (error) return Response.json({ error: error.message }, { status: 403 });
  let refunds;
  try {
    refunds = await refundToCard(plan as RefundPlan, amountCents ?? 0, keepCents ?? 0);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
  try {
    return Response.json(
      await serverRpc('record_card_refunds', {
        p_tournament: tournamentId,
        p_player: playerId,
        p_refunds: refunds,
        p_keep_cents: keepCents ?? 0,
        p_user: who.user?.id ?? null,
      }),
    );
  } catch (err) {
    // The money went back; only the books failed. Say so, so it isn't refunded twice.
    return Response.json(
      { error: `The refund went through on Stripe, but recording it failed: ${(err as Error).message}. Record it by hand.` },
      { status: 500 },
    );
  }
}
