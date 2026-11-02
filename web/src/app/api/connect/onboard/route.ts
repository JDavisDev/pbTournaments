import { createClient } from '@supabase/supabase-js';
import { startOnboarding, type PaymentSetup } from '@/server/connect';

/** The tournament's owner: start (or finish) connecting their Stripe account. Returns where to go. */
export async function POST(request: Request) {
  const { tournamentId } = (await request.json()) as { tournamentId?: string };
  const authorization = request.headers.get('authorization');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!tournamentId) return Response.json({ error: 'Missing tournament' }, { status: 400 });
  if (!authorization) return Response.json({ error: 'Log in first' }, { status: 401 });
  if (!url || !key) return Response.json({ error: 'Supabase is not configured' }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false }, global: { headers: { authorization } } });

  // Checks they own the tournament's organization.
  const { data, error } = await db.rpc('payment_account_for_setup', { p_tournament: tournamentId });
  if (error) return Response.json({ error: error.message }, { status: 403 });
  try {
    return Response.json({ url: await startOnboarding(tournamentId, data as PaymentSetup) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
