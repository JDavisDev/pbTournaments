import { createClient } from '@supabase/supabase-js';
import { duprConnected, fetchDuprRatings } from '@/server/dupr';
import type { DuprRefreshPlayer, RatingsImport } from '@/lib/types';

/**
 * Staff: refreshes a tournament's ratings from DUPR. The database calls run as
 * the signed-in caller, so they check that this person is on the tournament's staff.
 */
export async function POST(request: Request) {
  if (!duprConnected()) return Response.json({ connected: false });
  const { tournamentId } = (await request.json()) as { tournamentId?: string };
  const authorization = request.headers.get('authorization');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!tournamentId) return Response.json({ error: 'Missing tournament' }, { status: 400 });
  if (!authorization) return Response.json({ error: 'Sign in first' }, { status: 401 });
  if (!url || !key) return Response.json({ error: 'Supabase is not configured' }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false }, global: { headers: { authorization } } });

  const { data: list, error } = await db.rpc('dupr_refresh_list', { p_tournament: tournamentId });
  if (error) return Response.json({ error: error.message }, { status: 403 });
  const players = list as DuprRefreshPlayer[];
  const withId = players.filter((p) => p.dupr_id);
  const name = (p: DuprRefreshPlayer) => `${p.first_name} ${p.last_name}`;

  try {
    const { found, notFound } = await fetchDuprRatings([...new Set(withId.map((p) => p.dupr_id!))]);
    const rated = found.filter((r) => r.doubles !== null || r.singles !== null);
    const { data, error: importError } = await db.rpc('import_dupr_ratings', {
      p_tournament: tournamentId,
      p_rows: rated.map((r) => ({ dupr_id: r.dupr_id, doubles: r.doubles, singles: r.singles })),
    });
    if (importError) throw new Error(importError.message);
    const named = (ids: string[]) => withId.filter((p) => ids.includes(p.dupr_id!)).map(name);
    return Response.json({
      connected: true,
      result: data as RatingsImport,
      noDuprId: players.filter((p) => !p.dupr_id).map(name),
      notFound: named(notFound.map((id) => id.toUpperCase())),
      noRating: named(found.filter((r) => r.doubles === null && r.singles === null).map((r) => r.dupr_id)),
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
