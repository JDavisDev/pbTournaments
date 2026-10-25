// Trusted server-side calls to database functions only the service role may
// run (payment confirmation, the text outbox). Local mode runs them in the
// dev server's database; otherwise they go to Supabase with the secret key.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const isLocal = process.env.NEXT_PUBLIC_DATA_MODE === 'local';

let serviceClient: SupabaseClient | null = null;

function service(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_SECRET_KEY (server only) to take payments and send texts');
  serviceClient ??= createClient(url, key, { auth: { persistSession: false } });
  return serviceClient;
}

/** Calls public.<fn>(name => value, ...) and returns its jsonb result. */
export async function serverRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (!/^[a-z_]+$/.test(fn)) throw new Error(`Bad function name: ${fn}`);
  if (!isLocal) {
    const { data, error } = await service().rpc(fn, args);
    if (error) throw new Error(error.message);
    return data as T;
  }
  const names = Object.keys(args);
  const values = names.map((n) => {
    const v = args[n];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  const call = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as result`;
  const { runAs } = await import('./localDb');
  return runAs(null, async (tx) => (await tx.query<{ result: T }>(call, values)).rows[0]?.result, { system: true });
}

export const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
