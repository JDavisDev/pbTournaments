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

/**
 * Hosted demo (private, not public): every visitor signs in to this one
 * Supabase account, so trying the demo doesn't make a user per visitor. The
 * password ships to the browser; only use it for a demo-only account.
 */
export const demoGuest = {
  email: process.env.NEXT_PUBLIC_DEMO_GUEST_EMAIL?.trim().toLowerCase() || null,
  password: process.env.NEXT_PUBLIC_DEMO_GUEST_PASSWORD || null,
};
