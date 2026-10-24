'use client';

import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { isSupabaseConfigured, supabase } from './supabase';

/** The signed-in session (null when signed out, undefined while loading). */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(isSupabaseConfigured ? undefined : null);
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    supabase()
      .auth.getSession()
      .then(({ data }) => setSession(data.session));
    const { data } = supabase().auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

interface LiveState<T> {
  data: T | undefined;
  error: string | null;
  reload: () => void;
}

/**
 * Loads data for a tournament and reloads it whenever anything in the
 * tournament changes. Screens subscribe to one row (tournament_live) over
 * Realtime instead of every table; a slow poll covers dropped connections.
 */
/** Data plus error from an async loader, with a way to load again. */
function useLoader<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(isSupabaseConfigured ? null : 'not-configured');
  const reload = () => {
    if (!isSupabaseConfigured) return;
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };
  return { data, error, reload };
}

export function useLiveTournament<T>(tournamentId: string, load: () => Promise<T>, pollMs = 20_000): LiveState<T> {
  const state = useLoader(load);
  const refresh = useEffectEvent(() => state.reload());

  useEffect(() => {
    if (!isSupabaseConfigured) return;
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

/** Re-renders every `ms` so elapsed times and no-show countdowns stay current. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
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
