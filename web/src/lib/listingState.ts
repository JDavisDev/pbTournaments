'use client';

// The state a player browses tournament listings in, remembered on this
// device ('' = every state). The home page shows what's coming up there.
import { useSyncExternalStore } from 'react';

const KEY = 'courtside-listing-state';
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
const read = () => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};

/** null until this device's choice is read, so screens load the right listings first. */
export function useListingState(): string | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

export function setListingState(code: string) {
  try {
    if (code) localStorage.setItem(KEY, code);
    else localStorage.removeItem(KEY);
  } catch {}
  listeners.forEach((l) => l());
}
