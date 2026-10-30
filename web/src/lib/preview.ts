// The schedule a division would get if it started now: the same seeding,
// pools and pairings as generate_matches, from the teams entered so far.
// Shown on the division page until it starts (start_event builds it then).
import { seedOrder } from './planner';
import type { Team, TournamentEvent } from './types';

export type Pairing = [Team, Team];

export interface PoolPreview {
  pool: number;
  teams: Team[];
  /** Each round's matches, and who sits out (an odd team count). */
  rounds: { round: number; matches: Pairing[]; sitsOut: Team | null }[];
}

export interface SchedulePreview {
  teams: Team[];
  /** Round robin pools, or Swiss (one group, round 1 only: later rounds are drawn from results). */
  pools: PoolPreview[];
  /** Bracket only: the first round by seed. A null team is a bye. */
  bracket: [Team | null, Team | null][];
  /** Why it can't be built yet, e.g. too few teams. */
  problem: string | null;
}

/** As generate_matches orders them: by seed, then entry. */
const bySeed = (a: Team, b: Team) =>
  (a.seed ?? Infinity) - (b.seed ?? Infinity) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

export function previewSchedule(e: TournamentEvent, entered: Team[]): SchedulePreview {
  const teams = entered.filter((t) => !t.withdrawn_at).sort(bySeed);
  const result: SchedulePreview = { teams, pools: [], bracket: [], problem: null };
  const n = teams.length;
  if (n < 2) return { ...result, problem: 'A division needs at least 2 teams.' };

  if (e.format === 'single_elim') {
    let size = 1;
    while (size < n) size *= 2;
    const order = seedOrder(size);
    for (let i = 0; i < size; i += 2) result.bracket.push([teams[order[i] - 1] ?? null, teams[order[i + 1] - 1] ?? null]);
    return result;
  }

  if (e.pool_play === 'swiss') {
    const half = Math.floor(n / 2);
    const matches = Array.from({ length: half }, (_, i): Pairing => [teams[i], teams[i + half]]);
    result.pools.push({ pool: 1, teams, rounds: [{ round: 1, matches, sitsOut: n % 2 ? teams[n - 1] : null }] });
    return result;
  }

  const pools = Math.max(1, e.pool_count);
  if (n < 2 * pools) return { ...result, problem: `${pools} pools need at least ${2 * pools} teams.` };
  for (let pool = 1; pool <= pools; pool++) {
    // Snake: seeds 1..P go to pools A..P, seeds P+1..2P back from P to A, ...
    const members = teams.filter((_, i) => (Math.floor(i / pools) % 2 === 0 ? (i % pools) + 1 : pools - (i % pools)) === pool);
    let ring: (Team | null)[] = members.length % 2 ? [...members, null] : [...members];
    const size = ring.length;
    const rounds: PoolPreview['rounds'] = [];
    for (let round = 1; round <= Math.min(size - 1, e.max_rounds ?? size - 1); round++) {
      const matches: Pairing[] = [];
      let sitsOut: Team | null = null;
      for (let slot = 0; slot < size / 2; slot++) {
        const a = ring[slot];
        const b = ring[size - 1 - slot];
        if (a && b) matches.push([a, b]);
        else sitsOut = a ?? b;
      }
      rounds.push({ round, matches, sitsOut });
      // Keep the first team fixed and rotate the rest one place.
      ring = [ring[0], ring[size - 1], ...ring.slice(1, size - 1)];
    }
    result.pools.push({ pool, teams: members, rounds });
  }
  return result;
}
