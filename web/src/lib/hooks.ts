'use client';

import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { isStaff } from './api';
import { auth, type AuthUser } from './auth';
import { isBackendConfigured, isLocalMode } from './config';
import { localCall } from './localClient';
import { supabase } from './supabase';
import { useViewMode } from './viewMode';

/** The signed-in director (null when signed out, undefined while loading). */
export function useSession(): AuthUser | null | undefined {
  const [user, setUser] = useState<AuthUser | null | undefined>(isBackendConfigured ? undefined : null);
  useEffect(() => {
    if (!isBackendConfigured) return;
    auth.current().then(setUser);
    return auth.subscribe(setUser);
  }, []);
  return user;
}

interface LiveState<T> {
  data: T | undefined;
  error: string | null;
  reload: () => void;
}

/** Data plus error from an async loader, with a way to load again. */
function useLoader<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(isBackendConfigured ? null : 'not-configured');
  const reload = () => {
    if (!isBackendConfigured) return;
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };
  return { data, error, reload };
}

// In local mode the demo clock can run ahead of real time; elapsed times and
// countdowns use the server's clock.
let clockOffset = 0;

/**
 * Loads data for a tournament and reloads it whenever anything in the
 * tournament changes. Screens watch one row (tournament_live): over Realtime
 * with Supabase, by polling in local mode. A slow poll covers dropped connections.
 */
export function useLiveTournament<T>(tournamentId: string, load: () => Promise<T>, pollMs = 20_000): LiveState<T> {
  const state = useLoader(load);
  const refresh = useEffectEvent(() => state.reload());

  useEffect(() => {
    if (!isBackendConfigured) return;

    if (isLocalMode) {
      let revision: string | null | undefined;
      const check = () =>
        localCall<{ revision: string | null; now: string }>('getLiveState', [tournamentId])
          .then((live) => {
            clockOffset = new Date(live.now).getTime() - Date.now();
            if (live.revision !== revision) {
              revision = live.revision;
              refresh();
            }
          })
          .catch(() => refresh());
      check();
      const poll = setInterval(check, 1500);
      return () => clearInterval(poll);
    }

    refresh();
    // Many rows change at once (a score report assigns several courts), so
    // wait a beat and reload once.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh(), 250);
    };
    const channel = supabase()
      .channel(`tournament-${tournamentId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournament_live', filter: `tournament_id=eq.${tournamentId}` },
        refreshSoon,
      )
      .subscribe();
    const poll = setInterval(() => refresh(), pollMs);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      supabase().removeChannel(channel);
      clearInterval(poll);
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [tournamentId, pollMs]);

  return state;
}

/** Loads data when `deps` change (and on demand) for screens that don't need live updates. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): LiveState<T> {
  const state = useLoader(load);
  const refresh = useEffectEvent(() => state.reload());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => refresh(), deps);
  return state;
}

/**
 * Whether to show director tools for this tournament: the signed-in user is
 * its staff and isn't viewing as a player (demo sites). `data` is undefined
 * while loading; `account` says whether they're staff at all.
 */
export function useStaffAccess(tournamentId: string) {
  const session = useSession();
  const staff = useLoad(() => (session ? isStaff(tournamentId) : Promise.resolve(false)), [tournamentId, session?.id]);
  const view = useViewMode();
  return {
    data: staff.data === undefined ? undefined : staff.data && view === 'admin',
    account: staff.data,
    view,
  };
}

/** Re-renders every `ms` so elapsed times and no-show countdowns stay current. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + clockOffset), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Runs a director action, tracking busy state and the error to show. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      after?.();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}
