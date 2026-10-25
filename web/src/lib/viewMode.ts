'use client';

// Demo sites let a director see the tournament as a player would: "player"
// hides every director tab and control. Remembered on this device. Outside
// demo mode the view is always "admin" (directors see their tools).
import { useSyncExternalStore } from 'react';
import { isDemoMode } from './config';

export type ViewMode = 'admin' | 'player';

const KEY = 'courtside-view';
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
const read = (): ViewMode => {
  try {
    return isDemoMode && localStorage.getItem(KEY) === 'player' ? 'player' : 'admin';
  } catch {
    return 'admin';
  }
};

export function useViewMode(): ViewMode {
  return useSyncExternalStore(subscribe, read, () => 'admin');
}

export function setViewMode(mode: ViewMode) {
  try {
    if (mode === 'player') localStorage.setItem(KEY, 'player');
    else localStorage.removeItem(KEY);
  } catch {}
  listeners.forEach((l) => l());
}
