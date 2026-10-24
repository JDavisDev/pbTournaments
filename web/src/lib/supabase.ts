import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseConfigured = Boolean(url && key);

let client: SupabaseClient | null = null;

/**
 * The browser's Supabase client. Everything goes through row-level security
 * and the engine's own permission checks, so this is safe to use directly
 * from client components (the same way the Kotlin apps will).
 */
export function supabase(): SupabaseClient {
  if (!client) {
    if (!url || !key) {
      throw new Error('Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    }
    client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  return client;
}
