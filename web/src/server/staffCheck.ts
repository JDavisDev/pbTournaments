// Routes that only a tournament's staff may use: checks the caller's sign-in
// (a Supabase token, or the local user in local mode) against the database's
// own staff rule.
import { createClient } from '@supabase/supabase-js';

/** Null when the caller is on the tournament's staff; otherwise the response to send. */
export async function staffOnly(request: Request, tournamentId: string): Promise<Response | null> {
  if (process.env.NEXT_PUBLIC_DATA_MODE === 'local') {
    const user = request.headers.get('x-local-user');
    if (!user) return Response.json({ error: 'Log in first' }, { status: 401 });
    const { runAs } = await import('./localDb');
    const staff = await runAs(user, async (tx) =>
      (await tx.query<{ v: boolean }>('select public.is_tournament_staff($1) as v', [tournamentId])).rows[0]?.v,
    );
    return staff ? null : Response.json({ error: 'Only the tournament’s directors can do that' }, { status: 403 });
  }

  const authorization = request.headers.get('authorization');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!authorization) return Response.json({ error: 'Log in first' }, { status: 401 });
  if (!url || !key) return Response.json({ error: 'Supabase is not configured' }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false }, global: { headers: { authorization } } });
  const { data, error } = await db.rpc('is_tournament_staff', { p_tournament: tournamentId });
  if (error) return Response.json({ error: error.message }, { status: 403 });
  return data ? null : Response.json({ error: 'Only the tournament’s directors can do that' }, { status: 403 });
}
