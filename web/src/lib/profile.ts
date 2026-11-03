'use client';

// A player's profile: who they are, once, so registering is a click. It belongs
// to their account, the same one that runs any tournaments they manage.
import { useEffect, useSyncExternalStore } from 'react';
import { getMyProfile, saveMyProfile } from './api';
import { auth } from './auth';
import { isDemoMode } from './config';
import { useSession } from './hooks';
import type { PlayerProfile } from './profileTypes';

export type { PlayerProfile };

/** Every fake player from the Test menu logs in with this. */
export const TEST_PASSWORD = 'test1234';
const PARTNER_KEY = 'courtside-test-partner';
const TEST_PLAYER_KEY = 'courtside-test-player';

interface State {
  userId: string | null | undefined;
  profile: PlayerProfile | null;
}
const unknown: State = { userId: undefined, profile: null };
let state = unknown;
/** The account whose profile is on its way; a switch of account drops it. */
let loading: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
function publish(next: State) {
  state = next;
  listeners.forEach((l) => l());
}

async function load(userId: string | null) {
  if (state.userId === userId) {
    loading = null;
    return;
  }
  if (!userId) {
    loading = null;
    return publish({ userId: null, profile: null });
  }
  if (loading === userId) return;
  loading = userId;
  let profile: PlayerProfile | null = null;
  try {
    profile = (await getMyProfile()) ?? (await savePending());
  } catch {}
  // Signed out or switched accounts while it loaded: that one counts instead.
  if (loading !== userId) return;
  loading = null;
  publish({ userId, profile });
}

/**
 * A sign-up that had to confirm its email: what they filled in waits on the
 * account, and is saved the first time it's logged in (from the email's link,
 * or a log-in on any browser).
 */
async function savePending() {
  const pending = await auth.pendingProfile?.();
  if (!pending) return null;
  const saved = await saveMyProfile(pending);
  await auth.clearPendingProfile?.().catch(() => null);
  return saved;
}

/** The signed-in account's profile: undefined while loading, null if there's none. */
export function useProfile(): PlayerProfile | null | undefined {
  const session = useSession();
  const id = session?.id ?? null;
  const current = useSyncExternalStore(subscribe, () => state, () => unknown);
  useEffect(() => {
    if (session !== undefined) load(id);
  }, [session, id]);
  return session === undefined || current.userId !== id ? undefined : current.profile;
}

const local = (key: string, value?: string | null) => {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
  return null;
};

/** Saves the signed-in account's profile. */
export async function saveProfile(profile: PlayerProfile) {
  const user = await auth.current();
  if (!user) throw new Error('Log in to save your profile');
  publish({ userId: user.id, profile: await saveMyProfile(profile) });
}

/** Creates the account. 'confirm-email' when the address has to be confirmed before logging in. */
export async function signUpPlayer(profile: PlayerProfile, password: string) {
  const result = await auth.signUp(profile.email.trim().toLowerCase(), password, profile);
  if (result === 'signed-in') await saveProfile(profile);
  return result;
}

export async function logInPlayer(email: string, password: string) {
  await auth.signIn(email.trim().toLowerCase(), password);
}

export const logOut = () => auth.signOut();

// Test menu ------------------------------------------------------------------

export function useTestPartner(): PlayerProfile | null {
  const text = useSyncExternalStore(subscribe, () => (isDemoMode ? local(PARTNER_KEY) : null), () => null);
  return text ? (JSON.parse(text) as PlayerProfile) : null;
}

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/** Signs up a new made-up player. The last one stays handy as a partner to name. */
export async function becomeFakePlayer(current: PlayerProfile | null | undefined) {
  local(PARTNER_KEY, current ? JSON.stringify(current) : null);
  const first = pick(['Pat', 'Sam', 'Jo', 'Alex', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Jamie', 'Drew']);
  const last = pick(['Davis', 'Lee', 'Park', 'Cho', 'Nguyen', 'Garcia', 'Patel', 'Kim', 'Rossi', 'Brown']);
  const n = Math.floor(Math.random() * 9000) + 1000;
  const email = `${first}.${last}.${n}@example.test`.toLowerCase();
  const result = await signUpPlayer(
    {
      first_name: first,
      last_name: last,
      email,
      phone: `(555) 01${n.toString().slice(0, 2)}-${n}`,
      sms_opt_in: true,
      gender: pick(['male', 'female']),
      birth_date: '1985-06-15',
      dupr_doubles: '3.500',
      dupr_singles: '3.500',
      self_rating: '',
      dupr_id: `T${n}X`,
    },
    TEST_PASSWORD,
  );
  if (result !== 'signed-in') throw new Error('This site makes new accounts confirm their email, so fake players can’t sign up here.');
  local(TEST_PLAYER_KEY, email);
  listeners.forEach((l) => l());
}

/** Back to the fake player, after acting as the director. */
export async function backToTestPlayer() {
  await auth.signOut();
  const email = local(TEST_PLAYER_KEY);
  if (email) await auth.signIn(email, TEST_PASSWORD).catch(() => local(TEST_PLAYER_KEY, null));
}

export const forgetTestPlayer = () => local(TEST_PLAYER_KEY, null);
