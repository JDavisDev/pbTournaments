import { describe, expect, it } from 'vitest';
import { type PlayerFacts, entryProblem, ratingLimits } from '../../web/src/lib/eligibility';

// Mixed 3.5 only: 3.50 up to (not including) 4.00.
const division = (over: Record<string, unknown> = {}) =>
  ({
    kind: 'doubles',
    gender: 'open',
    min_age: null,
    max_age: null,
    age_basis: 'tournament_day',
    skill_rule: 'only',
    skill_level: '3.5',
    skill_level_to: null,
    rating_source: 'dupr',
    allow_play_up: false,
    max_teams: null,
    rating_tolerance: 0,
    play_up_limit: null,
    ...over,
  }) as Parameters<typeof entryProblem>[0];

const rated = (dupr: string): PlayerFacts => ({
  gender: '',
  birth_date: '',
  dupr_doubles: dupr,
  dupr_singles: '',
  self_rating: '',
  dupr_id: '',
});

const problem = (over: Record<string, unknown>, dupr: string) => entryProblem(division(over), '2026-11-07', rated(dupr));

describe('rating fine-tuning', () => {
  it('takes any leeway over the top, to the hundredth', () => {
    expect(ratingLimits(division({ rating_tolerance: 0.15 })).under).toBeCloseTo(4.15);
    expect(problem({ rating_tolerance: 0.15 }, '4.149')).toBeNull();
    expect(problem({ rating_tolerance: 0.15 }, '4.15')).toBe('is for players rated under 4.15');
    expect(problem({}, '4.0')).toBe('is for players rated under 4.0');
  });

  it('takes any play-up limit', () => {
    const up = { allow_play_up: true, play_up_limit: 0.35 };
    expect(ratingLimits(division(up)).playUpFrom).toBeCloseTo(3.15);
    expect(problem(up, '3.15')).toBeNull();
    expect(problem(up, '3.149')).toBe('lets players rated 3.15 and up play up');
    expect(problem({ allow_play_up: true, play_up_limit: null }, '2.5')).toBeNull();
    expect(problem({}, '3.4')).toBe('is for players rated 3.5 and up');
  });
});
