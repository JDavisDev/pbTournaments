import { createClient } from '@supabase/supabase-js';
import { payOutAll, payoutBalance, type PaymentSetup } from '@/server/connect';

/**
 * The organization's owner or admin: its Stripe balance ({ payout: false }),
 * or pay all of it out to their bank ({ payout: true }).
 */
export async function POST(request: Request) {
  const { tournamentId, payout } = (await request.json()) as { tournamentId?: string; payout?: boolean };
  const authorization = request.headers.get('authorization');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!tournamentId) return Response.json({ error: 'Missing tournament' }, { status: 400 });
  if (!authorization) return Response.json({ error: 'Log in first' }, { status: 401 });
  if (!url || !key) return Response.json({ error: 'Supabase is not configured' }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false }, global: { headers: { authorization } } });

  // Checks they're an owner or admin of the tournament's organization.
  const { data, error } = await db.rpc('payment_account_for_setup', { p_tournament: tournamentId });
  if (error) return Response.json({ error: error.message }, { status: 403 });
  const account = (data as PaymentSetup).stripe_account_id;
  try {
    if (payout) return Response.json({ paid_cents: await payOutAll(account) });
    return Response.json(await payoutBalance(account));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
