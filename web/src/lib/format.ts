import type { BracketType, ChampionshipMode, EventFormat, MatchDetails, PoolPlay, RoundFormat, RoundKey, Tournament } from './types';

export function formatTime(iso: string | null | undefined, timeZone?: string) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
}

export function formatDate(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** "Sat, Nov 14, 2026", or "Sat, Nov 14 – Sun, Nov 15, 2026" across days. */
export function formatDateRange(start: string, end: string | null) {
  if (!end || end === start) return formatDate(start);
  const first = new Date(`${start}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(start.slice(0, 4) !== end.slice(0, 4) && { year: 'numeric' }),
  });
  return `${first} – ${formatDate(end)}`;
}

/** Today in the viewer's time zone, as 'YYYY-MM-DD'. */
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function minutesSince(iso: string | null | undefined, now: number) {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

export const formatLabel: Record<EventFormat, string> = {
  round_robin: 'Round robin',
  pools_to_bracket: 'Pools → bracket',
  single_elim: 'Bracket',
};

export function formatSummary(e: {
  format: EventFormat;
  pool_count: number;
  advance_per_pool: number;
  bracket_size?: number | null;
  bracket_type?: BracketType;
  max_rounds?: number | null;
  pool_play?: PoolPlay;
}) {
  const bracket =
    e.bracket_type === 'double' ? 'double elimination' : e.bracket_type === 'medal' ? 'medal matches' : 'single elimination';
  if (e.format === 'single_elim') return bracket[0].toUpperCase() + bracket.slice(1);
  const play =
    e.pool_play === 'swiss'
      ? `${e.max_rounds ?? '?'} Swiss rounds`
      : `${e.pool_count === 1 ? '1 pool' : `${e.pool_count} pools`}${e.max_rounds ? ` · ${e.max_rounds} rounds max` : ''}`;
  if (e.format === 'round_robin') return e.pool_play === 'swiss' ? play : `Round robin · ${play}`;
  return `${play} → ${e.bracket_type === 'medal' ? 'gold and bronze matches' : `top ${bracketSeeds(e)} to ${bracket}`}`;
}

/** Teams that go from pool play to the bracket. */
export const bracketSeeds = (e: { pool_count: number; advance_per_pool: number; bracket_size?: number | null }) =>
  e.bracket_size ?? e.pool_count * e.advance_per_pool;

/** Who goes to the bracket: "Top 2 in each pool, plus the 2 best third-place teams." */
export function advanceRule(pools: number, size: number) {
  if (pools <= 1) return `The top ${size} go to the bracket.`;
  const each = Math.floor(size / pools);
  const extra = size % pools;
  const place = ordinal(each + 1);
  if (each === 0) return `The best ${size} of the ${pools} pool winners go to the bracket.`;
  const plus = extra === 0 ? '' : extra === 1 ? `, plus the best ${place}-place team` : `, plus the ${extra} best ${place}-place teams`;
  return `Top ${each} in each pool${plus}.`;
}

/** Matches that are (or will be) played: not byes, not cancelled. */
export const isPlayable = (m: Pick<MatchDetails, 'is_bye' | 'status' | 'team1_bye' | 'team2_bye'>) =>
  !m.is_bye && !m.team1_bye && !m.team2_bye && m.status !== 'cancelled';

export interface Podium {
  gold: string | null;
  silver: string | null;
  bronze: string[];
}

/**
 * Medal winners once the bracket's deciding match is played: the final (or
 * the grand final, and its reset if played), and the bronze match, or both
 * semifinal losers when there isn't one. Team ids.
 */
export function podium(bracket: MatchDetails[]): Podium | null {
  const done = (m?: MatchDetails) => m?.status === 'completed' && !!m.winner_team_id;
  const loser = (m: MatchDetails) => (m.winner_team_id === m.team1_id ? m.team2_id : m.team1_id);
  const reset = bracket.find((m) => m.round_key === 'grand_final' && m.round === 2 && m.status !== 'cancelled');
  const final = reset ?? bracket.find((m) => m.round_key === 'grand_final' && m.round === 1) ?? bracket.find((m) => m.round_key === 'final');
  if (!final || !done(final)) return null;

  let bronze: string[] = [];
  const bronzeMatch = bracket.find((m) => m.round_key === 'bronze');
  if (bronzeMatch) {
    if (done(bronzeMatch)) bronze = [bronzeMatch.winner_team_id!];
  } else if (final.round_key === 'grand_final') {
    const losersFinal = bracket.filter((m) => m.side === 'losers').sort((a, b) => b.round - a.round)[0];
    if (done(losersFinal) && !losersFinal.is_bye) bronze = [loser(losersFinal)!].filter(Boolean);
  } else {
    bronze = bracket
      .filter((m) => m.round_key === 'semifinal' && done(m) && !m.is_bye)
      .map((m) => loser(m)!)
      .filter(Boolean);
  }
  return { gold: final.winner_team_id, silver: loser(final), bronze };
}

/** "Bo3 to 15" style shorthand for a round's format. */
export function shortFormat(f: { games_to: number; best_of: number; point_cap?: number | null }) {
  return `${f.best_of === 1 ? '1 game' : `Bo${f.best_of}`} to ${f.games_to}${f.point_cap ? ` (cap ${f.point_cap})` : ''}`;
}

/** A court section: "Courts 1–5" for numbered courts in a row, else the names ("Court 2, Stadium"). */
export function courtsLabel(names: string[]) {
  const numbers = names.map((n) => /^Court (\d+)$/i.exec(n)?.[1]).map(Number);
  const consecutive = numbers.every((n, i) => n > 0 && (i === 0 || n === numbers[i - 1] + 1));
  if (names.length > 1 && consecutive) return `Courts ${numbers[0]}–${numbers.at(-1)}`;
  return names.join(', ');
}

/** A new division's medal matches: Gold best of 3 to 11, Bronze one game to 15, win by 2 (as the database defaults). */
export const defaultRoundFormats: RoundFormat[] = [
  { key: 'final', games_to: 11, best_of: 3, point_cap: null },
  { key: 'grand_final', games_to: 11, best_of: 3, point_cap: null },
  { key: 'bronze', games_to: 15, best_of: 1, point_cap: null },
];

/** A match's type at a glance: RR (pool play), Bracket, Gold (the final) or Bronze. */
export function matchType(stage: 'pool' | 'bracket' | null, roundKey: RoundKey | null): 'RR' | 'Bracket' | 'Gold' | 'Bronze' | null {
  if (stage === 'pool') return 'RR';
  if (stage !== 'bracket') return null;
  if (roundKey === 'final' || roundKey === 'grand_final') return 'Gold';
  if (roundKey === 'bronze') return 'Bronze';
  return 'Bracket';
}

/** A championship court's rank: "Main", "2nd", "3rd", "4th", ... */
export function championshipRankLabel(rank: number) {
  if (rank === 1) return 'Main';
  const suffix = rank % 100 >= 11 && rank % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[rank % 10] ?? 'th';
  return `${rank}${suffix}`;
}

/** What a championship match does when the championship courts are busy. */
export const championshipModes: { value: ChampionshipMode; label: string; hint: string }[] = [
  { value: 'wait', label: 'Wait for one', hint: 'Finals wait for the Main court. Set how long below.' },
  { value: 'first_available', label: 'Use the first free court', hint: 'Faster: big matches go out as soon as any court is free.' },
  { value: 'off', label: 'Off', hint: 'Championship courts are ordinary courts.' },
];

/** "11-7, 9-11, 11-5" with team 1 first. */
export function formatScore(m: Pick<MatchDetails, 'games' | 'forfeit'>) {
  if (m.forfeit) return 'Forfeit';
  if (!m.games) return '';
  return m.games.map(([a, b]) => `${a}-${b}`).join(', ');
}

export const poolName = (pool: number | null) => (pool ? `Pool ${String.fromCharCode(64 + pool)}` : '');

export const formatMoney = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0 });

type Priced = Pick<Tournament, 'entry_fee_cents' | 'extra_event_fee_cents' | 'first_event_included' | 'price_schedule' | 'time_zone'>;

/**
 * Same rule as private.price_at: the registration and event fees at a
 * moment. `through`: the last day of the schedule step in effect (null for
 * the regular price).
 */
export function priceAt(t: Priced, at: number | string = Date.now()) {
  const day = toZonedInput(new Date(at).toISOString(), t.time_zone).slice(0, 10);
  const step = [...t.price_schedule].sort((a, b) => a.through.localeCompare(b.through)).find((s) => day <= s.through);
  return {
    registration: step?.registration_cents ?? t.entry_fee_cents,
    event: step?.event_cents ?? t.extra_event_fee_cents,
    through: step?.through ?? null,
  };
}

/**
 * Same rule as private.entry_cost: a player's own events, given whether each
 * division may be the included one. The registration fee, and the event fee
 * for each event it doesn't cover.
 */
export function entryCost(t: Priced, includable: boolean[], now: number = Date.now()) {
  if (includable.length === 0) return 0;
  const p = priceAt(t, now);
  const covered = t.first_event_included && includable.some(Boolean) ? 1 : 0;
  return p.registration + p.event * (includable.length - covered);
}

/** Same rule as public.registration_price: this many events, all in divisions that may be the included one. */
export function registrationPrice(t: Priced, eventCount: number, now: number = Date.now()) {
  return entryCost(t, Array(Math.max(0, eventCount)).fill(true), now);
}

/** "$42.50 registration, first event included · $15.50 each extra event", for players. */
export function priceSummary(t: Priced, now: number = Date.now()) {
  const p = priceAt(t, now);
  const until = p.through ? ` · until ${formatDay(p.through)}` : '';
  return t.first_event_included
    ? `${formatMoney(p.registration)} registration, first event included · ${formatMoney(p.event)} each extra event${until}`
    : `${formatMoney(p.registration)} registration + ${formatMoney(p.event)} per event${until}`;
}

/**
 * Same rule as private.registration_open: whether players can register now.
 * In registration, or live once a director reopens it, until any closing date.
 */
export function registrationOpen(
  t: Pick<Tournament, 'status' | 'registration_reopened' | 'registration_closes_at'>,
  now: number = Date.now(),
) {
  return (
    (t.status === 'registration' || (t.status === 'live' && t.registration_reopened)) &&
    (!t.registration_closes_at || new Date(t.registration_closes_at).getTime() >= now)
  );
}

/** "Nov 3" from "2026-11-03". */
export const formatDay = (day: string) =>
  new Date(`${day}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Minutes a time zone is ahead of UTC at this moment (e.g. -240 for New York in summer). */
function zoneOffsetMinutes(ms: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - ms) / 60_000);
}

/** "2026-11-07T08:30" for a datetime-local input, in the tournament's time zone. */
export function toZonedInput(iso: string | number | null | undefined, timeZone: string) {
  if (iso === null || iso === undefined || iso === '') return '';
  const ms = typeof iso === 'number' ? iso : new Date(iso).getTime();
  return new Date(ms + zoneOffsetMinutes(ms, timeZone) * 60_000).toISOString().slice(0, 16);
}

/** The instant a datetime-local value means in the tournament's time zone (NaN if incomplete). */
export function fromZonedInput(value: string, timeZone: string) {
  const naive = Date.parse(`${value}:00Z`);
  if (Number.isNaN(naive)) return NaN;
  // Correct twice so times next to a daylight-saving change land right.
  let ms = naive - zoneOffsetMinutes(naive, timeZone) * 60_000;
  ms = naive - zoneOffsetMinutes(ms, timeZone) * 60_000;
  return ms;
}
