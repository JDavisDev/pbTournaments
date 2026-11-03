// One live feed per tournament, shared by every component on the page that
// watches it (the nav, the page, a banner): one Realtime channel (a revision
// poll in local mode), one safety-net poll and one set of focus listeners. The
// reads every live screen makes (shareReads) are shared too, so a change costs
// one request per read, not one per component.
//
// Screens watch one row (tournament_live), whose revision goes up whenever the
// tournament, its divisions, teams, matches, courts or check-ins change. A
// finished read is reused only while the feed would have heard of any change
// since: Realtime is connected, and nothing has changed or been written from
// this browser since it was made.
import { isLocalMode } from './config';
import { localCall } from './localClient';
import { supabase } from './supabase';

type Listener = () => void;

interface Feed {
  /** Each listener and how often it wants the safety-net poll (ms). */
  listeners: Map<Listener, number>;
  /** Goes up on every change; shared reads belong to one generation. */
  gen: number;
  /** Changes are arriving (Realtime subscribed, or the local poll answering). */
  live: boolean;
  /** Something changed while the page was hidden: reload when it's shown. */
  stale: boolean;
  /** Restarts the safety-net poll when the fastest listener changes. */
  retime: () => void;
  stop: () => void;
  linger?: ReturnType<typeof setTimeout>;
}

const feeds = new Map<string, Feed>();
// Never reused, so a feed started again can't match reads from an older one.
let generations = 0;
// Goes up after every change made from this browser.
let writes = 0;

// In local mode the demo clock can run ahead of real time; elapsed times and
// countdowns use the server's clock.
let clockOffset = 0;
export const serverNow = () => Date.now() + clockOffset;

function notify(feed: Feed) {
  feed.gen = ++generations;
  if (document.hidden) {
    feed.stale = true;
    return;
  }
  feed.stale = false;
  feed.listeners.forEach((_, listener) => listener());
}

function start(tournamentId: string): Feed {
  const feed: Feed = { listeners: new Map(), gen: ++generations, live: false, stale: false, retime: () => {}, stop: () => {} };
  // Many rows change at once (a score report assigns several courts), so wait
  // a beat and reload once.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => notify(feed), 250);
  };

  let stopSource: () => void;
  let check: () => void = changed;
  if (isLocalMode) {
    let revision: string | null | undefined;
    check = () =>
      localCall<{ revision: string | null; now: string }>('getLiveState', [tournamentId])
        .then((live) => {
          clockOffset = new Date(live.now).getTime() - Date.now();
          feed.live = true;
          if (revision !== undefined && live.revision !== revision) notify(feed);
          revision = live.revision;
        })
        .catch(() => {
          feed.live = false;
          notify(feed);
        });
    check();
    const poll = setInterval(() => !document.hidden && check(), 1500);
    stopSource = () => clearInterval(poll);
  } else {
    let dropped = false;
    const channel = supabase()
      .channel(`tournament-${tournamentId}-${feed.gen}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournament_live', filter: `tournament_id=eq.${tournamentId}` },
        changed,
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Reconnected after a drop: catch up on what was missed.
          if (dropped) changed();
          feed.live = true;
          dropped = false;
        } else {
          dropped ||= feed.live;
          feed.live = false;
        }
      });
    // A safety net for dropped connections, at the fastest rate any listener
    // asked for; a third as often while Realtime is connected.
    let poll: ReturnType<typeof setInterval> | undefined;
    let every = 0;
    let ticks = 0;
    feed.retime = () => {
      const fastest = Math.min(...feed.listeners.values());
      if (fastest === every || !Number.isFinite(fastest)) return;
      every = fastest;
      clearInterval(poll);
      poll = setInterval(() => {
        ticks += 1;
        if (!document.hidden && (!feed.live || ticks % 3 === 0)) notify(feed);
      }, every);
    };
    stopSource = () => {
      supabase().removeChannel(channel);
      clearInterval(poll);
    };
  }

  // Back to the page (another tab or app, a phone waking up): catch up if
  // anything changed meanwhile, or the connection may have slept.
  let hiddenAt = 0;
  const onVisibility = () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (feed.stale || !feed.live || Date.now() - hiddenAt > 10_000) check();
  };
  const onFocus = () => !document.hidden && (feed.stale || !feed.live) && check();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);

  feed.stop = () => {
    stopSource();
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    for (const key of reads.keys()) if (key.startsWith(`${tournamentId}|`)) reads.delete(key);
  };
  return feed;
}

/**
 * Calls `listener` now and whenever the tournament changes, until the returned
 * function is called. `pollMs`: the safety-net poll while Realtime is down.
 */
export function watchTournament(tournamentId: string, listener: Listener, pollMs: number) {
  let feed = feeds.get(tournamentId);
  if (!feed) {
    feed = start(tournamentId);
    feeds.set(tournamentId, feed);
  }
  clearTimeout(feed.linger);
  feed.listeners.set(listener, pollMs);
  feed.retime();
  listener();
  const mine = feed;
  return () => {
    mine.listeners.delete(listener);
    mine.retime();
    // Kept a moment: moving between a tournament's pages, or React mounting
    // twice in development, shouldn't drop and reopen the connection.
    if (mine.listeners.size === 0) {
      mine.linger = setTimeout(() => {
        mine.stop();
        feeds.delete(tournamentId);
      }, 3000);
    }
  };
}

/** The next shared reads for this tournament fetch again (a reload the user asked for). */
export function invalidateTournament(tournamentId: string) {
  const feed = feeds.get(tournamentId);
  if (feed) feed.gen = ++generations;
}

interface Read {
  stamp: string;
  done: boolean;
  promise: Promise<unknown>;
}
const reads = new Map<string, Read>();

function sharedRead<T>(tournamentId: string, name: string, run: () => Promise<T>): Promise<T> {
  const key = `${tournamentId}|${name}`;
  const feed = feeds.get(tournamentId);
  const stamp = `${writes}:${feed?.gen ?? 'none'}`;
  const hit = reads.get(key);
  // A read still on its way always answers; a finished one only while the
  // feed is connected (it would have heard of a change).
  if (hit && hit.stamp === stamp && (!hit.done || feed?.live)) return hit.promise as Promise<T>;
  const read: Read = { stamp, done: false, promise: run() };
  reads.set(key, read);
  read.promise.then(
    () => {
      read.done = true;
      if (!feed && reads.get(key) === read) reads.delete(key);
    },
    () => reads.get(key) === read && reads.delete(key),
  );
  return read.promise as Promise<T>;
}

// The reads live screens make, each by tournament id. Everything they read
// moves tournament_live's revision.
const SHARED = new Set([
  'getTournament',
  'getEvents',
  'getTeams',
  'getCourtBoard',
  'getQueue',
  'getChampionshipHolds',
  'getMatches',
  'getStandings',
]);
const READ = /^(get|is|check|claim|search)/;

/** Shares the live screens' reads; any other call that changes something starts a new generation. */
export function shareReads<T extends object>(api: T): T {
  return new Proxy({} as T, {
    get(_, name) {
      const fn = (api as Record<string | symbol, unknown>)[name];
      if (typeof fn !== 'function' || typeof name !== 'string') return fn;
      if (SHARED.has(name)) {
        return (tournamentId: string, ...rest: unknown[]) => sharedRead(tournamentId, name, () => fn(tournamentId, ...rest));
      }
      if (READ.test(name)) return fn;
      return async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } finally {
          writes += 1;
        }
      };
    },
  });
}
