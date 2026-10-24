import type { BlockedReason, EventFormat, MatchDetails } from './types';

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

export function formatSummary(e: { format: EventFormat; pool_count: number; advance_per_pool: number }) {
  if (e.format === 'single_elim') return 'Single elimination';
  const pools = e.pool_count === 1 ? '1 pool' : `${e.pool_count} pools`;
  if (e.format === 'round_robin') return `Round robin · ${pools}`;
  return `${pools} → top ${e.advance_per_pool} to bracket`;
}

export const blockedLabel: Record<Exclude<BlockedReason, null>, string> = {
  on_hold: 'On hold',
  event_not_started: 'Event not started',
  not_checked_in: 'Not checked in',
  player_on_court: 'Player on court',
  resting: 'Resting',
  player_needed_elsewhere: 'Player up next elsewhere',
};

/** "11-7, 9-11, 11-5" with team 1 first. */
export function formatScore(m: Pick<MatchDetails, 'games' | 'forfeit'>) {
  if (m.forfeit) return 'Forfeit';
  if (!m.games) return '';
  return m.games.map(([a, b]) => `${a}-${b}`).join(', ');
}

export const poolName = (pool: number | null) => (pool ? `Pool ${String.fromCharCode(64 + pool)}` : '');

export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
