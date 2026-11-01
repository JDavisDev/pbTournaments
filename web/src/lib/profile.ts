'use client';

// A player's profile: who they are, once, so registering is a click. Kept on
// this device for now and only on demo and local sites; it isn't stored in the
// database, and registering still sends the details as it always has.
import { useSyncExternalStore } from 'react';
import { isDemoMode } from './config';
import type { PlayerFacts } from './eligibility';

export interface PlayerProfile extends PlayerFacts {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  sms_opt_in: boolean;
}

const KEY = 'courtside-profile';
const PARTNER_KEY = 'courtside-test-partner';
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
const raw = (key: string) => {
  try {
    return isDemoMode ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
};
const parse = (text: string | null) => (text ? (JSON.parse(text) as PlayerProfile) : null);

// Compared as text so the same profile doesn't re-render.
export function useProfile(): PlayerProfile | null {
  return parse(useSyncExternalStore(subscribe, () => raw(KEY), () => null));
}

export function useTestPartner(): PlayerProfile | null {
  return parse(useSyncExternalStore(subscribe, () => raw(PARTNER_KEY), () => null));
}

function store(key: string, profile: PlayerProfile | null) {
  if (!isDemoMode) return;
  try {
    if (profile) localStorage.setItem(key, JSON.stringify(profile));
    else localStorage.removeItem(key);
  } catch {}
  listeners.forEach((l) => l());
}

export const saveProfile = (profile: PlayerProfile) => store(KEY, profile);
export const clearProfile = () => store(KEY, null);

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/** Test menu: become a new made-up player. The last one stays handy as a partner to name. */
export function becomeFakePlayer(current: PlayerProfile | null) {
  store(PARTNER_KEY, current);
  const first = pick(['Pat', 'Sam', 'Jo', 'Alex', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Jamie', 'Drew']);
  const last = pick(['Davis', 'Lee', 'Park', 'Cho', 'Nguyen', 'Garcia', 'Patel', 'Kim', 'Rossi', 'Brown']);
  const n = Math.floor(Math.random() * 9000) + 1000;
  store(KEY, {
    first_name: first,
    last_name: last,
    email: `${first}.${last}.${n}@example.test`.toLowerCase(),
    phone: `(555) 01${n.toString().slice(0, 2)}-${n}`,
    sms_opt_in: true,
    gender: pick(['male', 'female']),
    birth_date: '1985-06-15',
    dupr_doubles: '3.500',
    dupr_singles: '3.500',
    self_rating: '',
    dupr_id: `T${n}X`,
  });
}
