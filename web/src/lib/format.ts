import type { BracketType, EventFormat, MatchDetails } from './types';

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
  bracket_type?: BracketType;
  max_rounds?: number | null;
}) {
  const bracket = e.bracket_type === 'double' ? 'double elimination' : 'single elimination';
  if (e.format === 'single_elim') return bracket[0].toUpperCase() + bracket.slice(1);
  const pools = e.pool_count === 1 ? '1 pool' : `${e.pool_count} pools`;
  const rounds = e.max_rounds ? ` · ${e.max_rounds} rounds max` : '';
  if (e.format === 'round_robin') return `Round robin · ${pools}${rounds}`;
  return `${pools}${rounds} → top ${e.advance_per_pool} to ${bracket}`;
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

/** "11-7, 9-11, 11-5" with team 1 first. */
export function formatScore(m: Pick<MatchDetails, 'games' | 'forfeit'>) {
  if (m.forfeit) return 'Forfeit';
  if (!m.games) return '';
  return m.games.map(([a, b]) => `${a}-${b}`).join(', ');
}

export const poolName = (pool: number | null) => (pool ? `Pool ${String.fromCharCode(64 + pool)}` : '');

export const formatMoney = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0 });

/** Same rule as public.registration_price: first event, then each extra; early prices until the cutoff. */
export function registrationPrice(
  t: {
    entry_fee_cents: number;
    extra_event_fee_cents: number;
    early_entry_fee_cents: number | null;
    early_extra_event_fee_cents: number | null;
    early_until: string | null;
  },
  eventCount: number,
  now = Date.now(),
) {
  if (eventCount < 1) return 0;
  const early = t.early_until !== null && new Date(t.early_until).getTime() > now;
  const first = early ? (t.early_entry_fee_cents ?? t.entry_fee_cents) : t.entry_fee_cents;
  const extra = early ? (t.early_extra_event_fee_cents ?? t.extra_event_fee_cents) : t.extra_event_fee_cents;
  return first + (eventCount - 1) * extra;
}

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
