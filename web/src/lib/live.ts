// One live feed per tournament, shared by every component on the page that
// watches it (the nav, the page, a banner): one Realtime channel (a revision
// poll in local mode), one safety-net poll and one set of focus listeners. The
// reads every live screen makes (shareReads) are shared too, so a change costs
// one request per read, not one per component.
//
// Screens watch one row (tournament_live), which keeps a revision per area
// (the tournament, its divisions, teams, matches, courts, check-ins; see the
// live_areas migration). When an area changes, only the reads that depend on
// it fetch again; the rest are reused. Matches, the biggest read, fetch only
// the matches that changed since the last read. The safety-net poll reads
// that one small row, not the screens' data.
//
// Many phones watch the same tournament, so each waits a random moment (up to
// a second) before reloading: a score report doesn't bring them all at once.
import { isLocalMode } from './config';
import { localCall } from './localClient';
import { supabase } from './supabase';
import type { MatchDetails } from './types';

export type LiveArea = 'tournament' | 'events' | 'teams' | 'team_names' | 'matches' | 'match_deletes' | 'courts' | 'checkins';
const AREAS: LiveArea[] = ['tournament', 'events', 'teams', 'team_names', 'matches', 'match_deletes', 'courts', 'checkins'];
type Revs = Partial<Record<LiveArea, number>>;

type Listener = () => void;

interface Watcher {
  /** How often it wants the safety-net poll (ms). */
  pollMs: number;
  /** The areas it reloads for; null: any change. */
  areas: LiveArea[] | null;
}

interface Feed {
  listeners: Map<Listener, Watcher>;
  /** Per area, goes up on every change; shared reads belong to the generations of what they read. */
  gens: Record<LiveArea, number>;
  /** The server's revisions as last seen; null until the first answer. */
  revs: Revs | null;
  /** Changes are arriving (Realtime subscribed, or the local poll answering). */
  live: boolean;
  /** Changed while the page was hidden: reload these when it's shown. */
  hiddenChanges: Set<LiveArea>;
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

// This browser's place in the line of phones reloading after a change.
const jitter = Math.random() * 1000;

const freshGens = () => Object.fromEntries(AREAS.map((a) => [a, ++generations])) as Record<LiveArea, number>;

function notify(feed: Feed, areas: Set<LiveArea>) {
  for (const a of areas) feed.gens[a] = ++generations;
  if (document.hidden) {
    for (const a of areas) feed.hiddenChanges.add(a);
    return;
  }
  feed.listeners.forEach((w, listener) => {
    if (!w.areas || w.areas.some((a) => areas.has(a))) listener();
  });
}

function start(tournamentId: string): Feed {
  const feed: Feed = {
    listeners: new Map(),
    gens: freshGens(),
    revs: null,
    live: false,
    hiddenChanges: new Set(),
    retime: () => {},
    stop: () => {},
  };
  // Many rows change at once (a score report assigns several courts), so wait
  // a beat, plus this browser's jitter, and reload once for all of them.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<LiveArea>();
  const changed = (areas: Iterable<LiveArea>) => {
    for (const a of areas) pending.add(a);
    if (pending.size === 0) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = new Set(pending);
      pending.clear();
      notify(feed, batch);
    }, 250 + jitter);
  };

  // What went up since last time. The first answer only sets the baseline
  // (the screens are loading then anyway), unless it came from a change.
  const apply = (revs: Revs | null | undefined, fromChange: boolean) => {
    if (!revs) {
      if (fromChange) changed(AREAS);
      return;
    }
    const before = feed.revs;
    feed.revs = { ...before };
    const up: LiveArea[] = [];
    for (const a of AREAS) {
      const n = Number(revs[a] ?? 0);
      if (n > Number(before?.[a] ?? 0)) {
        feed.revs[a] = n;
        up.push(a);
      }
    }
    if (before || fromChange) changed(up);
  };

  let stopSource: () => void;
  let check: () => void;
  if (isLocalMode) {
    check = () =>
      localCall<{ revs: Revs | null; now: string }>('getLiveState', [tournamentId])
        .then((state) => {
          clockOffset = new Date(state.now).getTime() - Date.now();
          feed.live = true;
          apply(state.revs, false);
        })
        .catch(() => {
          feed.live = false;
        });
    check();
    const poll = setInterval(() => !document.hidden && check(), 1500);
    stopSource = () => clearInterval(poll);
  } else {
    check = () => {
      supabase()
        .from('tournament_live')
        .select('revs')
        .eq('tournament_id', tournamentId)
        .maybeSingle()
        .then(({ data, error }) => {
          if (!error) apply((data?.revs as Revs | undefined) ?? null, false);
        });
    };
    check();
    let dropped = false;
    const channel = supabase()
      .channel(`tournament-${tournamentId}-${generations}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournament_live', filter: `tournament_id=eq.${tournamentId}` },
        (payload) => apply((payload.new as { revs?: Revs } | undefined)?.revs, true),
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Reconnected after a drop: catch up on what was missed.
          if (dropped) check();
          feed.live = true;
          dropped = false;
        } else {
          dropped ||= feed.live;
          feed.live = false;
        }
      });
    // A safety net for dropped connections, at the fastest rate any listener
    // asked for; a third as often while Realtime is connected. It reads only
    // the revisions, so it costs one tiny request.
    let poll: ReturnType<typeof setInterval> | undefined;
    let every = 0;
    let ticks = 0;
    feed.retime = () => {
      const fastest = Math.min(...[...feed.listeners.values()].map((w) => w.pollMs));
      if (fastest === every || !Number.isFinite(fastest)) return;
      every = fastest;
      clearInterval(poll);
      poll = setInterval(() => {
        ticks += 1;
        if (!document.hidden && (!feed.live || ticks % 3 === 0)) check();
      }, every);
    };
    stopSource = () => {
      supabase().removeChannel(channel);
      clearInterval(poll);
    };
  }

  // Back to the page (another tab or app, a phone waking up): show what
  // changed meanwhile, and ask in case the connection slept.
  let hiddenAt = 0;
  const onVisibility = () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    if (feed.hiddenChanges.size > 0) {
      const missed = new Set(feed.hiddenChanges);
      feed.hiddenChanges.clear();
      notify(feed, missed);
    }
    if (!feed.live || Date.now() - hiddenAt > 10_000) check();
  };
  const onFocus = () => !document.hidden && !feed.live && check();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);

  feed.stop = () => {
    stopSource();
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    for (const key of reads.keys()) if (key.startsWith(`${tournamentId}|`)) reads.delete(key);
    matchCaches.delete(tournamentId);
  };
  return feed;
}

/**
 * Calls `listener` now and whenever the tournament changes, until the returned
 * function is called. `pollMs`: the safety-net poll while Realtime is down.
 * `areas`: only reload for changes to these (default: any change).
 */
export function watchTournament(tournamentId: string, listener: Listener, pollMs: number, areas: LiveArea[] | null = null) {
  let feed = feeds.get(tournamentId);
  if (!feed) {
    feed = start(tournamentId);
    feeds.set(tournamentId, feed);
  }
  clearTimeout(feed.linger);
  feed.listeners.set(listener, { pollMs, areas });
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

/** The next shared reads for this tournament fetch again in full (a reload the user asked for). */
export function invalidateTournament(tournamentId: string) {
  const feed = feeds.get(tournamentId);
  if (feed) feed.gens = freshGens();
}

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

interface Read {
  stamp: string;
  done: boolean;
  promise: Promise<unknown>;
}
const reads = new Map<string, Read>();

/** Identifies the state of these areas: the same stamp means nothing in them changed. */
function stampOf(tournamentId: string, areas: readonly LiveArea[]) {
  const feed = feeds.get(tournamentId);
  return `${writes}:${feed ? areas.map((a) => feed.gens[a]).join('.') : 'none'}`;
}

function sharedRead<T>(tournamentId: string, name: string, run: () => Promise<T>): Promise<T> {
  const key = `${tournamentId}|${name}`;
  const feed = feeds.get(tournamentId);
  const stamp = stampOf(tournamentId, SHARED[name]);
  const hit = reads.get(key);
  // A read still on its way always answers; a finished one only while the
  // feed is following changes (Realtime, or the revision poll when it's down).
  if (hit && hit.stamp === stamp && (!hit.done || feed?.live || feed?.revs)) return hit.promise as Promise<T>;
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

// The reads live screens make, each by tournament id, and the areas each one
// shows. A read fetches again only when one of its areas changed.
const SHARED: Record<string, readonly LiveArea[]> = {
  getTournament: ['tournament'],
  getEvents: ['events'],
  getTeams: ['teams'],
  getCourtBoard: ['courts', 'matches', 'teams', 'events', 'checkins'],
  getQueue: AREAS,
  getChampionshipHolds: ['tournament', 'events', 'courts', 'matches'],
  getMatches: ['matches', 'team_names', 'match_deletes', 'events', 'courts'],
  getStandings: ['matches', 'teams'],
};

// Matches: after a change to matches alone, only the ones that changed are
// fetched and merged in. Anything else they show (team, division and court
// names) or a match removed, and the whole list is fetched again.
const MATCHES_FULL: LiveArea[] = ['team_names', 'match_deletes', 'events', 'courts'];
// Changes commit a moment after they're stamped, so each partial read looks
// back a little past the newest change it has seen.
const LOOK_BACK_MS = 30_000;

interface MatchCache {
  stamp: string;
  rows: Map<string, MatchDetails>;
  newest: number;
}
const matchCaches = new Map<string, MatchCache>();

// As the database orders them: queue_seq (a bigint, nulls last), then id.
const seq = (m: MatchDetails) => (m.queue_seq == null ? Infinity : Number(m.queue_seq));
const matchOrder = (a: MatchDetails, b: MatchDetails) =>
  seq(a) - seq(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const newestOf = (rows: MatchDetails[], from = 0) =>
  rows.reduce((max, m) => Math.max(max, m.updated_at ? Date.parse(m.updated_at) : 0), from);

async function readMatches(tournamentId: string, fetch: (since?: string) => Promise<MatchDetails[]>) {
  const stamp = stampOf(tournamentId, MATCHES_FULL);
  const cache = matchCaches.get(tournamentId);
  if (feeds.has(tournamentId) && cache && cache.stamp === stamp && cache.newest > 0) {
    const changed = await fetch(new Date(cache.newest - LOOK_BACK_MS).toISOString());
    for (const m of changed) cache.rows.set(m.id, m);
    cache.newest = newestOf(changed, cache.newest);
    return [...cache.rows.values()].sort(matchOrder);
  }
  const rows = await fetch();
  if (feeds.has(tournamentId)) {
    matchCaches.set(tournamentId, { stamp, rows: new Map(rows.map((m) => [m.id, m])), newest: newestOf(rows) });
  }
  return rows;
}

const READ = /^(get|is|check|claim|search)/;

/** Shares the live screens' reads; any other call that changes something starts a new generation. */
export function shareReads<T extends object>(api: T): T {
  return new Proxy({} as T, {
    get(_, name) {
      const fn = (api as Record<string | symbol, unknown>)[name];
      if (typeof fn !== 'function' || typeof name !== 'string') return fn;
      if (name === 'getMatches') {
        return (tournamentId: string) =>
          sharedRead(tournamentId, name, () =>
            readMatches(tournamentId, (since) => fn(tournamentId, since) as Promise<MatchDetails[]>),
          );
      }
      if (name in SHARED) {
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
