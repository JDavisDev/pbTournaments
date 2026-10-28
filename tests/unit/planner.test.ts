import { describe, expect, it } from 'vitest';
import { type PlanDivision, planDay, suggestMinutes } from '../../web/src/lib/planner';

const T0 = Date.parse('2026-11-07T13:00:00Z');
const MIN = 60_000;

const division = (over: Partial<PlanDivision> = {}): PlanDivision => ({
  id: 'd1',
  name: 'Open',
  start: T0,
  teams: 8,
  format: 'round_robin',
  poolCount: 1,
  advancePerPool: 2,
  maxRounds: null,
  bracketType: 'single',
  thirdPlace: false,
  gfReset: false,
  poolMinutes: 15,
  bracketMinutes: 20,
  ...over,
});

const count = (plan: ReturnType<typeof planDay>, id = 'd1') => plan.divisions.find((d) => d.id === id)!.matches;

describe('planner', () => {
  it('plays an 8-team round robin in 7 rounds on 4 courts', () => {
    const plan = planDay([division()], { courts: 4 });
    expect(count(plan)).toBe(28);
    expect((plan.end - T0) / MIN).toBe(7 * 15);
  });

  it('honors max rounds', () => {
    expect(count(planDay([division({ maxRounds: 6 })], { courts: 4 }))).toBe(24);
  });

  it('never puts two matches on a court at once', () => {
    const plan = planDay([division({ teams: 10, poolCount: 2 })], { courts: 3 });
    for (const court of [1, 2, 3]) {
      const mine = plan.matches.filter((m) => m.court === court);
      for (let i = 1; i < mine.length; i++) expect(mine[i].start).toBeGreaterThanOrEqual(mine[i - 1].end);
    }
  });

  it('counts brackets with byes, bronze and double elimination', () => {
    const settings = { courts: 4 };
    expect(count(planDay([division({ format: 'single_elim', teams: 6 })], settings))).toBe(5);
    expect(count(planDay([division({ format: 'single_elim', teams: 4, thirdPlace: true })], settings))).toBe(4);
    const de = planDay([division({ format: 'single_elim', teams: 6, bracketType: 'double', gfReset: true })], settings);
    expect(count(de)).toBe(2 * 6 - 2); // plus the reset final, planned as optional
    expect(de.matches.filter((m) => m.optional)).toHaveLength(1);
  });

  it('plays each Swiss round after the whole round before it, then the bracket', () => {
    // 8 teams, 3 rounds on 2 courts: each round takes two slots of 15 minutes.
    const plan = planDay([division({ format: 'pools_to_bracket', swiss: true, maxRounds: 3, advancePerPool: 4 })], { courts: 2 });
    expect(count(plan)).toBe(3 * 4 + 3);
    const roundStarts = [2, 3].map((r) => Math.min(...plan.matches.filter((m) => m.label === `Round ${r}`).map((m) => m.start)));
    expect(roundStarts.map((t) => (t - T0) / MIN)).toEqual([30, 60]);
    const bracketStart = Math.min(...plan.matches.filter((m) => m.stage === 'bracket').map((m) => m.start));
    expect((bracketStart - T0) / MIN).toBe(90);
  });

  it('counts any bracket size and straight-to-medal matches', () => {
    const settings = { courts: 6 };
    const wildcards = division({ format: 'pools_to_bracket', teams: 15, poolCount: 3, bracketSize: 8 });
    expect(count(planDay([wildcards], settings))).toBe(3 * 10 + 7);
    const medal = division({ format: 'pools_to_bracket', poolCount: 2, advancePerPool: 2, bracketType: 'medal' });
    const plan = planDay([medal], settings);
    expect(count(plan)).toBe(2 * 6 + 2);
    expect(plan.matches.filter((m) => m.stage === 'bracket').map((m) => m.label).sort()).toEqual(['Bronze', 'Final']);
  });

  it('gives the gold and bronze matches their own length', () => {
    const length = (plan: ReturnType<typeof planDay>, label: string) => {
      const m = plan.matches.find((x) => x.label === label)!;
      return (m.end - m.start) / MIN;
    };
    const single = planDay([division({ format: 'single_elim', thirdPlace: true, goldMinutes: 45, bronzeMinutes: 25 })], { courts: 4 });
    expect([length(single, 'Final'), length(single, 'Bronze'), length(single, 'Semifinal 1')]).toEqual([45, 25, 20]);
    const double = planDay([division({ format: 'single_elim', teams: 4, bracketType: 'double', gfReset: true, goldMinutes: 40 })], { courts: 4 });
    expect([length(double, 'Grand Final'), length(double, 'Grand Final (if needed)'), length(double, 'Winners Final')]).toEqual([40, 40, 20]);
    // Not set: the bracket length.
    expect(length(planDay([division({ format: 'single_elim' })], { courts: 4 }), 'Final')).toBe(20);
  });

  it('starts the bracket after pool play, and late divisions at their start time', () => {
    const plan = planDay(
      [
        division({ id: 'a', format: 'pools_to_bracket', teams: 8, poolCount: 2 }),
        division({ id: 'b', start: T0 + 90 * MIN }),
      ],
      { courts: 6 },
    );
    const a = plan.divisions.find((d) => d.id === 'a')!;
    const firstBracket = Math.min(...plan.matches.filter((m) => m.divisionId === 'a' && m.stage === 'bracket').map((m) => m.start));
    expect(firstBracket).toBeGreaterThanOrEqual(a.poolsEnd!);
    expect(plan.divisions.find((d) => d.id === 'b')!.firstStart).toBeGreaterThanOrEqual(T0 + 90 * MIN);
  });

  it('shows a division waiting when the courts are full', () => {
    const plan = planDay([division({ id: 'a', teams: 12 }), division({ id: 'b' })], { courts: 2 });
    expect(plan.divisions.find((d) => d.id === 'b')!.startDelayMinutes).toBeGreaterThan(0);
  });

  it('suggests match lengths from the format', () => {
    expect(suggestMinutes(11, 1)).toBe(15);
    expect(suggestMinutes(15, 3)).toBe(46);
  });
});

describe('planner court sections', () => {
  it('keeps a sectioned division on its courts and the others off them', () => {
    const plan = planDay(
      [division({ id: 'a', teams: 8, courts: [1, 2] }), division({ id: 'b', teams: 8 })],
      { courts: 4 },
    );
    const courtsOf = (id: string) => new Set(plan.matches.filter((m) => m.divisionId === id).map((m) => m.court));
    expect([...courtsOf('a')].sort()).toEqual([1, 2]);
    expect([...courtsOf('b')].sort()).toEqual([3, 4]);
    expect(count(plan, 'a') + count(plan, 'b')).toBe(56);
  });

  it('opens a finished division’s courts to everyone', () => {
    const plan = planDay(
      [division({ id: 'a', teams: 2, courts: [1] }), division({ id: 'b', teams: 8 })],
      { courts: 2 },
    );
    const aEnd = plan.divisions.find((d) => d.id === 'a')!.end!;
    const onCourt1 = plan.matches.filter((m) => m.divisionId === 'b' && m.court === 1);
    expect(onCourt1.length).toBeGreaterThan(0);
    expect(Math.min(...onCourt1.map((m) => m.start))).toBeGreaterThanOrEqual(aEnd);
  });
});

describe('tournament time zone inputs', () => {
  it('round-trips a start time in the tournament’s zone, whatever the browser’s', async () => {
    const { fromZonedInput, toZonedInput } = await import('../../web/src/lib/format');
    const ms = fromZonedInput('2026-11-07T08:30', 'America/New_York');
    expect(new Date(ms).toISOString()).toBe('2026-11-07T13:30:00.000Z');
    expect(toZonedInput(ms, 'America/New_York')).toBe('2026-11-07T08:30');
    expect(toZonedInput('2026-07-04T13:00:00Z', 'America/Los_Angeles')).toBe('2026-07-04T06:00');
  });
});
