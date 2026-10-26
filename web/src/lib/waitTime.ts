// Expected wait for a queued match: the queue played forward onto the courts
// the way the engine calls matches. A court frees up when its match should
// end (its start plus the expected length); whenever one does, it takes the
// first match in line that may use it (court sections) and is ready: its
// teams off court and its division started. Held and not-checked-in matches
// are skipped, as the engine skips them.
//
// Expected length: the division's planned minutes until a few of its matches
// have finished, then how long they've actually taken.

const MIN = 60_000;

interface MatchLike {
  id: string;
  event_id: string;
  stage: 'pool' | 'bracket';
  status: string;
  team1_id: string | null;
  team2_id: string | null;
  court_id: string | null;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  forfeit: boolean;
  /** The engine's call order (up_next lists Next up matches first, which isn't it). */
  queue_seq: string | number | null;
}

interface EventLike {
  id: string;
  not_before: string | null;
  pool_match_minutes: number | null;
  bracket_match_minutes: number | null;
  court_ids: string[];
}

export interface WaitInput {
  now: number;
  /** The tournament's default minutes per match. */
  slotMinutes: number;
  events: EventLike[];
  courts: { court_id: string; out_of_service: boolean }[];
  matches: MatchLike[];
  /** up_next, top to bottom. */
  queue: { match_id: string; blocked_reason: string | null }[];
}

const time = (iso: string | null) => (iso ? Date.parse(iso) : null);

/** Minutes a match of this division and stage is expected to take. */
export function expectedMinutes(input: Pick<WaitInput, 'slotMinutes' | 'events' | 'matches'>, eventId: string, stage: 'pool' | 'bracket') {
  const played = input.matches
    .filter((m) => m.event_id === eventId && m.stage === stage && m.status === 'completed' && !m.forfeit && m.assigned_at && m.completed_at)
    .sort((a, b) => time(b.completed_at)! - time(a.completed_at)!)
    .slice(0, 10)
    .map((m) => (time(m.completed_at)! - time(m.assigned_at)!) / MIN)
    .sort((a, b) => a - b);
  if (played.length >= 3) return Math.min(120, Math.max(5, played[Math.floor(played.length / 2)]));
  const e = input.events.find((x) => x.id === eventId);
  return (stage === 'bracket' ? (e?.bracket_match_minutes ?? e?.pool_match_minutes) : e?.pool_match_minutes) ?? input.slotMinutes;
}

/** When the match is expected to go on a court (ms since epoch), with every match taking its expected length. */
export function estimateStart(input: WaitInput, matchId: string): number | null {
  return simulate(input, matchId, () => 1);
}

/**
 * The likely wait (ms from now): the day played forward many times with
 * match lengths varying by up to 20%, since who finishes first decides what
 * gets called next (a round robin rarely plays in round order). mid is the
 * typical run; low and high bracket most of them. Seeded, so the numbers
 * hold steady between page refreshes.
 */
export function estimateWait(input: WaitInput, matchId: string, runs = 40): { low: number; mid: number; high: number } | null {
  let seed = [...`${matchId}:${Math.floor(input.now / MIN)}`].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const starts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = simulate(input, matchId, () => 0.8 + random() * 0.4);
    if (start === null) return null;
    starts.push(start - input.now);
  }
  starts.sort((a, b) => a - b);
  const at = (q: number) => starts[Math.min(starts.length - 1, Math.floor(q * starts.length))];
  return { low: at(0.2), mid: at(0.5), high: at(0.8) };
}

function simulate(input: WaitInput, matchId: string, stretch: () => number): number | null {
  const { now, events, matches, queue } = input;
  const byId = new Map(matches.map((m) => [m.id, m]));
  const eventOf = new Map(events.map((e) => [e.id, e]));
  const courts = input.courts.filter((c) => !c.out_of_service).map((c) => c.court_id);
  if (courts.length === 0) return null;
  const planned = new Map<string, number>();
  const length = (m: MatchLike) => {
    const key = `${m.event_id}:${m.stage}`;
    if (!planned.has(key)) planned.set(key, expectedMinutes(input, m.event_id, m.stage) * MIN);
    return planned.get(key)! * stretch();
  };

  // Courts and teams busy now: free when their match should end.
  const courtFree = new Map(courts.map((c) => [c, now]));
  const teamFree = new Map<string, number>();
  for (const m of matches) {
    if ((m.status !== 'assigned' && m.status !== 'in_progress') || !m.court_id) continue;
    const start = time(m.started_at) ?? time(m.assigned_at) ?? now;
    // A match running long is about to finish.
    const end = Math.max(start + length(m), now + 2 * MIN);
    if (courtFree.has(m.court_id)) courtFree.set(m.court_id, end);
    for (const t of [m.team1_id, m.team2_id]) if (t) teamFree.set(t, end);
  }

  // Court sections in force: divisions with matches still to play hold their courts.
  const left = new Map<string, number>();
  for (const m of matches)
    if (['waiting', 'queued', 'assigned', 'in_progress'].includes(m.status)) left.set(m.event_id, (left.get(m.event_id) ?? 0) + 1);
  const held = new Set(events.filter((e) => (left.get(e.id) ?? 0) > 0).flatMap((e) => e.court_ids));
  const mayUse = (eventId: string, court: string) => {
    const own = eventOf.get(eventId)?.court_ids ?? [];
    return own.length > 0 ? own.includes(court) : !held.has(court);
  };

  // The engine skips held and not-checked-in matches; the asked-about one counts regardless.
  const pending = queue
    .map((q) => ({ q, m: byId.get(q.match_id) }))
    .filter((x): x is { q: (typeof queue)[number]; m: MatchLike } => !!x.m)
    .filter(({ q, m }) => m.id === matchId || (q.blocked_reason !== 'on_hold' && q.blocked_reason !== 'not_checked_in'))
    .map(({ m }) => m)
    .sort((a, b) => Number(a.queue_seq) - Number(b.queue_seq) || (a.id < b.id ? -1 : 1));
  if (!pending.some((m) => m.id === matchId)) return null;
  const startsAt = new Map(events.map((e) => [e.id, time(e.not_before) ?? now]));
  const ready = (m: MatchLike) =>
    Math.max(
      now,
      startsAt.get(m.event_id) ?? now,
      m.team1_id ? (teamFree.get(m.team1_id) ?? now) : now,
      m.team2_id ? (teamFree.get(m.team2_id) ?? now) : now,
    );

  // Play the queue forward: whenever a court frees, it takes the first match
  // in line that may use it and is ready by then.
  for (let guard = pending.length * (courts.length + 2) + 50; guard > 0; guard--) {
    let court = courts[0];
    for (const c of courts) if (courtFree.get(c)! < courtFree.get(court)!) court = c;
    const at = courtFree.get(court)!;
    if (!Number.isFinite(at)) return null;

    const i = pending.findIndex((m) => mayUse(m.event_id, court) && ready(m) <= at);
    if (i === -1) {
      // Nothing for this court yet: wait for a match it may take, or another court.
      const next = Math.min(
        ...pending.filter((m) => mayUse(m.event_id, court)).map(ready),
        ...courts.filter((c) => c !== court && courtFree.get(c)! > at).map((c) => courtFree.get(c)!),
      );
      courtFree.set(court, next > at ? next : Infinity);
      continue;
    }
    const [m] = pending.splice(i, 1);
    if (m.id === matchId) return at;
    const end = at + length(m);
    courtFree.set(court, end);
    for (const t of [m.team1_id, m.team2_id]) if (t) teamFree.set(t, end);
    left.set(m.event_id, (left.get(m.event_id) ?? 1) - 1);
    // A sectioned division that's done gives its courts back.
    if (left.get(m.event_id) === 0 && eventOf.get(m.event_id)?.court_ids.length) {
      held.clear();
      for (const e of events) if ((left.get(e.id) ?? 0) > 0) for (const c of e.court_ids) held.add(c);
    }
  }
  return null;
}

const round5 = (ms: number) => Math.max(5, Math.round(ms / MIN / 5) * 5);
const duration = (minutes: number) =>
  minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;

/** A likely wait in words: one figure when the runs agree, else a range ("15–30 minutes"). */
export function formatWaitRange(w: { low: number; mid: number; high: number }) {
  if (w.high - w.low <= 10 * MIN || w.high <= 2 * MIN) return formatWait(w.mid);
  const high = round5(w.high);
  if (w.low <= 2 * MIN) return `up to ${high < 60 ? `${high} minutes` : duration(high)}`;
  const low = Math.min(round5(w.low), high - 5);
  return high < 60 ? `${low}–${high} minutes` : `${duration(low)} to ${duration(high)}`;
}

/** "any minute now", "about 25 minutes", "about 1 hr 15 min". */
export function formatWait(ms: number) {
  const minutes = Math.round(ms / MIN);
  if (minutes <= 2) return 'any minute now';
  const rounded = Math.max(5, Math.round(minutes / 5) * 5);
  if (rounded < 60) return `about ${rounded} minutes`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return `about ${h} hr${m ? ` ${m} min` : ''}`;
}
