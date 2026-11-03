'use client';

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { claimStaffInvites, getMyRole } from './api';
import { auth, isGuest, type AuthUser } from './auth';
import { isBackendConfigured } from './config';
import { invalidateTournament, serverNow, watchTournament } from './live';
import type { StaffRole } from './types';
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
  // Loads overlap (a change, a poll and a focus at once) and can finish out of
  // order: only the latest one counts, so older data never replaces newer.
  const latest = useRef(0);
  const reload = () => {
    if (!isBackendConfigured) return;
    const n = ++latest.current;
    load()
      .then((d) => {
        if (n !== latest.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (n === latest.current) setError(e.message);
      });
  };
  return { data, error, reload };
}

/**
 * Loads data for a tournament and reloads it whenever anything in the
 * tournament changes (lib/live.ts: one feed per tournament, shared by every
 * component watching it). `pollMs`: the safety net while Realtime is down.
 */
export function useLiveTournament<T>(tournamentId: string, load: () => Promise<T>, pollMs = 20_000): LiveState<T> {
  const state = useLoader(load);
  const refresh = useEffectEvent(() => state.reload());

  useEffect(() => {
    if (!isBackendConfigured) return;
    return watchTournament(tournamentId, refresh, pollMs);
  }, [tournamentId, pollMs]);

  // Asked for (after an action): fetch again, not a read another component shared.
  const reload = () => {
    invalidateTournament(tournamentId);
    state.reload();
  };
  return { ...state, reload };
}

/** Loads data when `deps` change (and on demand) for screens that don't need live updates. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): LiveState<T> {
  const state = useLoader(load);
  const refresh = useEffectEvent(() => state.reload());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => refresh(), deps);
  return state;
}

// The nav and the page ask at the same time: one request answers both.
const roleRequests = new Map<string, Promise<StaffRole | null>>();

function myRole(user: AuthUser, tournamentId: string) {
  const key = `${user.id}:${tournamentId}`;
  let request = roleRequests.get(key);
  if (!request) {
    request = (async () => {
      if (!isGuest(user)) await claimStaffInvites().catch(() => 0);
      return getMyRole(tournamentId);
    })().finally(() => roleRequests.delete(key));
    roleRequests.set(key, request);
  }
  return request;
}

/**
 * What the signed-in user may do in this tournament. `data`: admin tools
 * (an admin, not viewing as a player on a demo site). `monitor`: court
 * monitor tools (courts, scores, check-in), which admins have too. Both are
 * undefined while loading. Invites sent to the user's email are claimed first.
 */
export function useStaffAccess(tournamentId: string) {
  const session = useSession();
  const role = useLoad(async () => (session ? myRole(session, tournamentId) : null), [tournamentId, session?.id]);
  const view = useViewMode();
  const loading = session === undefined || role.data === undefined;
  return {
    data: loading ? undefined : role.data === 'admin' && view === 'admin',
    monitor: loading ? undefined : !!role.data && view === 'admin',
    account: role.data === undefined ? undefined : role.data === 'admin',
    role: role.data ?? null,
    view,
  };
}

/** Re-renders every `ms` so elapsed times and no-show countdowns stay current. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), ms);
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
