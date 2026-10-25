import { isSupabaseConfigured } from './supabase';

/**
 * NEXT_PUBLIC_DATA_MODE=local runs everything against a database inside the
 * dev server (no Supabase, no Docker). Anything else uses Supabase.
 */
export const isLocalMode = process.env.NEXT_PUBLIC_DATA_MODE === 'local';

export const isBackendConfigured = isLocalMode || isSupabaseConfigured;

/**
 * Demo site (NEXT_PUBLIC_DEMO_MODE=1, and always in local mode): anyone can
 * sign up and build practice tournaments with the demo clock. Payments use
 * the test checkout and texts go to the log, whatever keys are set.
 */
export const isDemoMode = isLocalMode || process.env.NEXT_PUBLIC_DEMO_MODE === '1';
