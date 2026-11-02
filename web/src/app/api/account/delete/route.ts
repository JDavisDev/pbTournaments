import { createClient } from '@supabase/supabase-js';

/**
 * Signed in: deletes this account. public.delete_my_account checks it's
 * allowed and removes the player's details as them; then the login goes,
 * which needs the server's secret key.
 */
export async function POST(request: Request) {
  const authorization = request.headers.get('authorization');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !secret) return Response.json({ error: 'Deleting accounts isn’t set up on this site' }, { status: 500 });
  const token = authorization?.replace(/^Bearer /, '');
  if (!token) return Response.json({ error: 'Log in first' }, { status: 401 });

  const db = createClient(url, key, { auth: { persistSession: false }, global: { headers: { authorization: `Bearer ${token}` } } });
  const { data: who, error: whoError } = await db.auth.getUser(token);
  if (whoError || !who.user) return Response.json({ error: 'Log in first' }, { status: 401 });
  const guest = process.env.NEXT_PUBLIC_DEMO_GUEST_EMAIL?.toLowerCase();
  if (!who.user.email || who.user.email.toLowerCase() === guest) {
    return Response.json({ error: 'The shared guest account can’t be deleted' }, { status: 403 });
  }

  const { error } = await db.rpc('delete_my_account');
  if (error) return Response.json({ error: error.message }, { status: 409 });
  const admin = createClient(url, secret, { auth: { persistSession: false } });
  const { error: deleteError } = await admin.auth.admin.deleteUser(who.user.id);
  if (deleteError) return Response.json({ error: `Your details were removed, but the login wasn’t: ${deleteError.message}` }, { status: 500 });
  return Response.json({ deleted: true });
}
