import { describe, expect, it } from 'vitest';
import { type WaitInput, estimateStart, formatWait } from '../../web/src/lib/waitTime';

const NOW = Date.parse('2026-11-07T15:00:00Z');
const MIN = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MIN).toISOString();

const event = (over: Partial<WaitInput['events'][number]> = {}) => ({
  id: 'e1',
  not_before: null,
  pool_match_minutes: 20,
  bracket_match_minutes: null,
  court_ids: [] as string[],
  ...over,
});

let n = 0;
const match = (over: Partial<WaitInput['matches'][number]> = {}) => ({
  id: `m${++n}`,
  event_id: 'e1',
  stage: 'pool' as const,
  status: 'queued',
  team1_id: `t${n}a`,
  team2_id: `t${n}b`,
  court_id: null,
  assigned_at: null,
  started_at: null,
  completed_at: null,
  forfeit: false,
  queue_seq: n,
  ...over,
});
const playing = (court: string, minutesAgo: number, over = {}) =>
  match({ status: 'in_progress', court_id: court, assigned_at: at(-minutesAgo), started_at: at(-minutesAgo), ...over });

function input(courts: string[], matches: ReturnType<typeof match>[], events = [event()]): WaitInput {
  return {
    now: NOW,
    slotMinutes: 20,
    events,
    courts: courts.map((court_id) => ({ court_id, out_of_service: false })),
    matches,
    queue: matches.filter((m) => m.status === 'queued').map((m) => ({ match_id: m.id, blocked_reason: null })),
  };
}
const waitMinutes = (i: WaitInput, id: string) => (estimateStart(i, id)! - NOW) / MIN;

describe('expected wait', () => {
  it('waits for courts to free up, matches ahead first', () => {
    const live = [playing('c1', 10), playing('c2', 10)];
    const ahead = [match(), match()];
    const mine = match();
    // Courts free at +10; the two ahead take them until +30; then mine.
    expect(waitMinutes(input(['c1', 'c2'], [...live, ...ahead, mine]), mine.id)).toBe(30);
  });

  it('waits for the next opponent to come off court, even with courts open', () => {
    const opponent = playing('c1', 15, { team1_id: 'rivals' });
    const mine = match({ team2_id: 'rivals' });
    // 15 minutes into a 20-minute match: about 5 minutes left.
    expect(waitMinutes(input(['c1', 'c2', 'c3'], [opponent, mine]), mine.id)).toBe(5);
  });

  it('goes on right away when a court is open and both teams are free', () => {
    const mine = match();
    expect(waitMinutes(input(['c1'], [mine]), mine.id)).toBe(0);
  });

  it('learns from how long the division’s matches have actually taken', () => {
    const done = [0, 1, 2].map((i) =>
      match({ status: 'completed', assigned_at: at(-100 - i * 40), completed_at: at(-70 - i * 40) }),
    );
    const live = playing('c1', 10);
    const mine = match();
    // Matches take 30 minutes here, not the planned 20: the court frees at +20.
    expect(waitMinutes(input(['c1'], [...done, live, mine]), mine.id)).toBe(20);
  });

  it('keeps to court sections', () => {
    const events = [event({ id: 'mens', court_ids: ['c1'] }), event({ id: 'open' })];
    const live = playing('c1', 5, { event_id: 'mens' });
    const mine = match({ event_id: 'mens' });
    // Court 2 is free but outside the men's section; court 1 frees at +15.
    expect(waitMinutes(input(['c1', 'c2'], [live, mine], events), mine.id)).toBe(15);
  });

  it('lets a ready match take a court that a blocked match above it can’t use yet', () => {
    const blocking = playing('c1', 0, { team1_id: 'busy' });
    const blocked = match({ team1_id: 'busy' }); // waits ~20 min for its team
    const mine = match();
    // Court 2 is open now: the engine sends mine there instead of holding it for the blocked match.
    expect(waitMinutes(input(['c1', 'c2'], [blocking, blocked, mine]), mine.id)).toBe(0);
  });

  it('skips held matches ahead, as the engine does', () => {
    const held = match();
    const mine = match();
    const i = input(['c1'], [held, mine]);
    i.queue[0].blocked_reason = 'on_hold';
    expect(waitMinutes(i, mine.id)).toBe(0);
  });

  it('reads as plain words', () => {
    expect(formatWait(1 * MIN)).toBe('any minute now');
    expect(formatWait(23 * MIN)).toBe('about 25 minutes');
    expect(formatWait(4 * MIN)).toBe('about 5 minutes');
    expect(formatWait(75 * MIN)).toBe('about 1 hr 15 min');
    expect(formatWait(120 * MIN)).toBe('about 2 hr');
  });
});
