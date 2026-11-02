import { createClient } from '@supabase/supabase-js';
import { pushConfigured, sendPush, type PushTarget } from '@/server/push';
import { testAlert } from '@/server/pushTest';

/** Signed in: a test alert to this account's phones. Returns how many got it. */
export async function POST(request: Request) {
  const authorization = request.headers.get('authorization');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!pushConfigured()) return Response.json({ error: 'Alerts aren’t set up on this site' }, { status: 404 });
  if (!authorization) return Response.json({ error: 'Log in first' }, { status: 401 });
  if (!url || !key) return Response.json({ error: 'Supabase is not configured' }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false }, global: { headers: { authorization } } });

  const { data, error } = await db.rpc('my_push_subscriptions');
  if (error) return Response.json({ error: error.message }, { status: 401 });
  const { sent, gone } = await sendPush(data as PushTarget[], testAlert);
  for (const endpoint of gone) await db.rpc('delete_push_subscription', { p_endpoint: endpoint });
  return Response.json({ sent: sent.length });
}
