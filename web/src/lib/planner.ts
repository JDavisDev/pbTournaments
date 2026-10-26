// The Planner: lays every division's matches onto the courts from the
// divisions' start times and expected match lengths, the way the court engine
// will run the day: the queue is ordered by expected start (division start +
// rounds × match length), a free court takes the first match whose teams are
// ready (a team is free as soon as its match ends), and bracket matches wait
// for the matches that feed them. Pure and fast, so it reruns as the director edits.

export interface PlanDivision {
  id: string;
  name: string;
  /** When the division may start (ms since epoch). */
  start: number;
  teams: number;
  format: 'round_robin' | 'pools_to_bracket' | 'single_elim';
  poolCount: number;
  advancePerPool: number;
  maxRounds: number | null;
  bracketType: 'single' | 'double';
  thirdPlace: boolean;
  gfReset: boolean;
  /** Minutes per match, court changeover included. */
  poolMinutes: number;
  bracketMinutes: number;
}

export interface PlanSettings {
  courts: number;
}

export interface PlannedMatch {
  id: string;
  divisionId: string;
  label: string;
  stage: 'pool' | 'bracket';
  /** "Grand final (if needed)": planned for, may not be played. */
  optional: boolean;
  court: number;
  start: number;
  end: number;
}

export interface DivisionPlan {
  id: string;
  matches: number;
  firstStart: number | null;
  /** How long after its start time the division's first match goes on. */
  startDelayMinutes: number;
  poolsEnd: number | null;
  end: number | null;
}

export interface Plan {
  matches: PlannedMatch[];
  divisions: DivisionPlan[];
  start: number;
  end: number;
}

type Source = { seed: number } | { winnerOf: string } | { loserOf: string } | { team: string };

interface Node {
  id: string;
  divisionId: string;
  label: string;
  stage: 'pool' | 'bracket';
  optional: boolean;
  sources: [Source, Source];
  /** Queue order: expected start, then division, pool, position. */
  priority: number;
  /** Bracket round 1 of pools_to_bracket waits for pool play. */
  afterPools: boolean;
  minutes: number;
}

const MIN = 60_000;

/** A sensible match length (minutes, changeover included) for a game format. */
export function suggestMinutes(gamesTo: number, bestOf: number) {
  const one = gamesTo <= 11 ? 15 : gamesTo <= 15 ? 20 : 25;
  return bestOf === 1 ? one : Math.round(one * (bestOf === 3 ? 2.3 : 3.6));
}

const seedOrder = (size: number) => {
  let order = [1];
  while (order.length < size) order = order.flatMap((s) => [s, order.length * 2 + 1 - s]);
  return order;
};

/** Every match of a division (byes resolved later), with how each slot gets its team. */
function buildDivision(d: PlanDivision, divisionIndex: number): Node[] {
  const nodes: Node[] = [];
  const priority = (wave: number, minutes: number, pool: number, position: number) =>
    (d.start / MIN + wave * minutes) * 1e6 + divisionIndex * 1000 + pool * 36 + position;
  let poolRounds = 0;

  if (d.format !== 'single_elim') {
    const pools = Math.max(1, d.poolCount);
    for (let pool = 1; pool <= pools; pool++) {
      // Snake seeding, as generate_pools does.
      const ring: (string | null)[] = [];
      for (let i = 1; i <= d.teams; i++) {
        const tier = Math.floor((i - 1) / pools);
        const p = tier % 2 === 0 ? ((i - 1) % pools) + 1 : pools - ((i - 1) % pools);
        if (p === pool) ring.push(`${d.id}:t${i}`);
      }
      if (ring.length % 2 === 1) ring.push(null);
      const size = ring.length;
      const rounds = Math.min(size - 1, d.maxRounds ?? size - 1);
      poolRounds = Math.max(poolRounds, rounds);
      let r = ring;
      for (let round = 1; round <= rounds; round++) {
        let position = 0;
        for (let slot = 0; slot < size / 2; slot++) {
          const a = r[slot];
          const b = r[size - 1 - slot];
          if (!a || !b) continue;
          position++;
          nodes.push({
            id: `${d.id}:p${pool}r${round}m${position}`,
            divisionId: d.id,
            label: `${pools > 1 ? `Pool ${String.fromCharCode(64 + pool)} · ` : ''}Round ${round}`,
            stage: 'pool',
            optional: false,
            sources: [{ team: a }, { team: b }],
            priority: priority(round, d.poolMinutes, pool, position),
            afterPools: false,
            minutes: d.poolMinutes,
          });
        }
        r = [r[0], r[size - 1], ...r.slice(1, size - 1)];
      }
    }
  }
  if (d.format === 'round_robin') return nodes;

  const seeds = d.format === 'single_elim' ? d.teams : Math.max(1, d.poolCount) * d.advancePerPool;
  if (seeds < 2) return nodes;
  let size = 1;
  let k = 0;
  while (size < seeds) {
    size *= 2;
    k++;
  }
  const order = seedOrder(size);
  const afterPools = d.format === 'pools_to_bracket';
  const id = (part: string) => `${d.id}:${part}`;
  const add = (part: string, label: string, wave: number, sources: [Source, Source], optional = false, position = 1) =>
    nodes.push({
      id: id(part),
      divisionId: d.id,
      label,
      stage: 'bracket',
      optional,
      sources,
      priority: priority(poolRounds + wave, d.poolMinutes, 0, position),
      afterPools,
      minutes: d.bracketMinutes,
    });
  const winnersName = (round: number, position: number) =>
    d.bracketType === 'double'
      ? k - round === 0
        ? 'Winners Final'
        : `Winners R${round} #${position}`
      : k - round === 0
        ? 'Final'
        : k - round === 1
          ? `Semifinal ${position}`
          : k - round === 2
            ? `Quarterfinal ${position}`
            : `Round of ${size >> (round - 1)} #${position}`;

  // Winners side (the whole bracket in single elimination).
  for (let round = 1; round <= k; round++) {
    for (let position = 1; position <= size >> round; position++) {
      const sources: [Source, Source] =
        round === 1
          ? [{ seed: order[2 * position - 2] }, { seed: order[2 * position - 1] }]
          : [{ winnerOf: id(`w${round - 1}m${2 * position - 1}`) }, { winnerOf: id(`w${round - 1}m${2 * position}`) }];
      add(`w${round}m${position}`, winnersName(round, position), d.bracketType === 'double' ? 2 * round - 1 : round, sources, false, position);
    }
  }

  if (d.bracketType === 'single') {
    if (d.thirdPlace && k >= 2) {
      add('bronze', 'Bronze', k, [{ loserOf: id(`w${k - 1}m1`) }, { loserOf: id(`w${k - 1}m2`) }]);
    }
    return nodes;
  }

  // Losers side: odd rounds pair survivors, even rounds take the teams
  // dropping from the winners side (as build_double_elim does).
  const losersRounds = 2 * (k - 1);
  for (let j = 1; j <= losersRounds; j++) {
    const count = size >> (Math.ceil(j / 2) + 1);
    for (let p = 1; p <= count; p++) {
      let sources: [Source, Source];
      if (j === 1) {
        sources = [{ loserOf: id(`w1m${2 * p - 1}`) }, { loserOf: id(`w1m${2 * p}`) }];
      } else if (j % 2 === 0) {
        const r = j / 2 + 1;
        const winnersCount = size >> r;
        const dropped = r % 2 === 0 ? winnersCount + 1 - p : p;
        sources = [{ winnerOf: id(`l${j - 1}m${p}`) }, { loserOf: id(`w${r}m${dropped}`) }];
      } else {
        sources = [{ winnerOf: id(`l${j - 1}m${2 * p - 1}`) }, { winnerOf: id(`l${j - 1}m${2 * p}`) }];
      }
      add(`l${j}m${p}`, j === losersRounds ? 'Losers Final' : `Losers R${j} #${p}`, j + 1, sources, false, p);
    }
  }
  const losersFinal: Source = k === 1 ? { loserOf: id('w1m1') } : { winnerOf: id(`l${losersRounds}m1`) };
  add('gf', 'Grand Final', 2 * k, [{ winnerOf: id(`w${k}m1`) }, losersFinal]);
  if (d.gfReset) add('gf2', 'Grand Final (if needed)', 2 * k + 1, [{ winnerOf: id('gf') }, { loserOf: id('gf') }], true);
  return nodes;
}

/** Schedules every division onto the courts. */
export function planDay(divisions: PlanDivision[], settings: PlanSettings): Plan {
  const all = divisions.flatMap((d, i) => buildDivision(d, i));
  const byId = new Map(all.map((n) => [n.id, n]));
  const division = new Map(divisions.map((d) => [d.id, d]));
  const seedsOf = (d: PlanDivision) => (d.format === 'single_elim' ? d.teams : Math.max(1, d.poolCount) * d.advancePerPool);

  // Which matches really get played: both slots must get a team.
  const real = new Map<string, boolean>();
  const sourceReal = (s: Source, d: PlanDivision): boolean => {
    if ('team' in s) return true;
    if ('seed' in s) return s.seed <= seedsOf(d);
    if ('loserOf' in s) return isReal(s.loserOf);
    const feeder = byId.get(s.winnerOf)!;
    return feeder.sources.some((x) => sourceReal(x, d));
  };
  const isReal = (id: string): boolean => {
    if (!real.has(id)) {
      const n = byId.get(id)!;
      real.set(id, n.sources.every((s) => sourceReal(s, division.get(n.divisionId)!)));
    }
    return real.get(id)!;
  };
  const pending = all.filter((n) => isReal(n.id));

  const scheduled = new Map<string, PlannedMatch>();
  const teamFree = new Map<string, number>();
  const poolsEnd = new Map<string, number>();
  const poolsLeft = new Map<string, number>();
  for (const n of pending) if (n.stage === 'pool') poolsLeft.set(n.divisionId, (poolsLeft.get(n.divisionId) ?? 0) + 1);

  /** When a slot's team is ready, or null if that's not known yet. */
  const sourceReady = (s: Source, n: Node): number | null => {
    const d = division.get(n.divisionId)!;
    if ('team' in s) return teamFree.get(s.team) ?? d.start;
    if ('seed' in s) {
      if (!n.afterPools) return d.start;
      return (poolsLeft.get(d.id) ?? 0) > 0 ? null : (poolsEnd.get(d.id) ?? d.start);
    }
    const feederId = 'loserOf' in s ? s.loserOf : s.winnerOf;
    const feeder = byId.get(feederId)!;
    if (isReal(feederId)) {
      const m = scheduled.get(feederId);
      return m ? m.end : null;
    }
    // A bye: the team comes straight from the feeder's real slot.
    const through = feeder.sources.find((x) => sourceReal(x, d))!;
    return sourceReady(through, feeder);
  };

  const courtFree = Array.from({ length: Math.max(1, settings.courts) }, () => Math.min(...divisions.map((d) => d.start)));
  const left = new Set(pending.map((n) => n.id));
  let guard = pending.length * 4 + 100;

  while (left.size > 0 && guard-- > 0) {
    const court = courtFree.indexOf(Math.min(...courtFree));
    const now = courtFree[court];
    let best: Node | null = null;
    let nextReady = Infinity;
    for (const id of left) {
      const n = byId.get(id)!;
      const [a, b] = n.sources.map((s) => sourceReady(s, n));
      if (a === null || b === null) continue;
      const ready = Math.max(a, b, division.get(n.divisionId)!.start);
      if (ready <= now) {
        if (!best || n.priority < best.priority) best = n;
      } else {
        nextReady = Math.min(nextReady, ready);
      }
    }
    if (!best) {
      courtFree[court] = Number.isFinite(nextReady) ? nextReady : now + MIN;
      continue;
    }
    const match: PlannedMatch = {
      id: best.id,
      divisionId: best.divisionId,
      label: best.label,
      stage: best.stage,
      optional: best.optional,
      court: court + 1,
      start: now,
      end: now + best.minutes * MIN,
    };
    scheduled.set(best.id, match);
    left.delete(best.id);
    courtFree[court] = match.end;
    for (const s of best.sources) if ('team' in s) teamFree.set(s.team, match.end);
    if (best.stage === 'pool') {
      poolsLeft.set(best.divisionId, poolsLeft.get(best.divisionId)! - 1);
      poolsEnd.set(best.divisionId, Math.max(poolsEnd.get(best.divisionId) ?? 0, match.end));
    }
  }

  const matches = [...scheduled.values()].sort((a, b) => a.start - b.start || a.court - b.court);
  const summaries = divisions.map((d): DivisionPlan => {
    const mine = matches.filter((m) => m.divisionId === d.id);
    const firstStart = mine.length ? Math.min(...mine.map((m) => m.start)) : null;
    return {
      id: d.id,
      matches: mine.filter((m) => !m.optional).length,
      firstStart,
      startDelayMinutes: firstStart === null ? 0 : Math.round((firstStart - d.start) / MIN),
      poolsEnd: poolsEnd.get(d.id) ?? null,
      end: mine.length ? Math.max(...mine.map((m) => m.end)) : null,
    };
  });
  return {
    matches,
    divisions: summaries,
    start: matches.length ? matches[0].start : Math.min(...divisions.map((d) => d.start)),
    end: matches.length ? Math.max(...matches.map((m) => m.end)) : Math.min(...divisions.map((d) => d.start)),
  };
}
