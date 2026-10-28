// Division rules on the client: who can enter an event, and how to describe
// it. Mirrors private.entry_problem in the registration migration, which has
// the final say.
import type { TournamentEvent } from './types';

export interface PlayerFacts {
  gender: '' | 'male' | 'female';
  birth_date: string;
  dupr_doubles: string;
  dupr_singles: string;
  self_rating: string;
  dupr_id: string;
}

type Division = Pick<
  TournamentEvent,
  | 'kind'
  | 'gender'
  | 'min_age'
  | 'max_age'
  | 'age_basis'
  | 'skill_rule'
  | 'skill_level'
  | 'skill_level_to'
  | 'rating_source'
  | 'allow_play_up'
  | 'max_teams'
> &
  Partial<Pick<TournamentEvent, 'rating_tolerance' | 'play_up_limit' | 'require_dupr_id' | 'team_rating_max' | 'team_age_min'>>;

const num = (v: string | number | null | undefined) => (v === '' || v === null || v === undefined ? null : Number(v));

/** Ratings allowed: low inclusive, high exclusive (3.5 only = 3.50 up to but not 4.00). */
export function skillBounds(e: Division): { low: number | null; high: number | null } {
  const level = num(e.skill_level);
  switch (e.skill_rule) {
    case 'only':
      return { low: level, high: level! + 0.5 };
    case 'and_under':
      return { low: null, high: level! + 0.5 };
    case 'and_above':
      return { low: level, high: null };
    case 'range':
      return { low: level, high: num(e.skill_level_to)! + 0.5 };
    default:
      return { low: null, high: null };
  }
}

export function ageOn(birthDate: string, on: Date) {
  const b = new Date(`${birthDate}T12:00:00`);
  let age = on.getFullYear() - b.getFullYear();
  if (on.getMonth() < b.getMonth() || (on.getMonth() === b.getMonth() && on.getDate() < b.getDate())) age -= 1;
  return age;
}

/** Why this player can't enter, e.g. "is for ages 50 and up", or null. */
export function entryProblem(e: Division, startsOn: string, p: PlayerFacts): string | null {
  if (e.gender === 'mens' && p.gender !== 'male') return 'is for men';
  if (e.gender === 'womens' && p.gender !== 'female') return 'is for women';
  if (e.gender === 'mixed' && !p.gender) return 'needs your gender';

  if (e.min_age !== null || e.max_age !== null) {
    if (!p.birth_date) return 'needs your date of birth';
    const day = new Date(`${startsOn}T12:00:00`);
    const on = e.age_basis === 'year_end' ? new Date(day.getFullYear(), 11, 31, 12) : day;
    const age = ageOn(p.birth_date, on);
    if (age < (e.min_age ?? 0) || age > (e.max_age ?? 200)) return `is for ages ${ageText(e)}`;
  }

  if (e.require_dupr_id && !p.dupr_id.trim()) return 'needs your DUPR ID';

  if (e.skill_rule !== 'open') {
    let rating = num(e.kind === 'singles' ? p.dupr_singles : p.dupr_doubles);
    if (rating === null && e.rating_source === 'dupr_or_self') rating = num(p.self_rating);
    if (rating === null) return e.rating_source === 'dupr' ? 'needs your DUPR rating' : 'needs your rating';
    const { low, high } = skillBounds(e);
    const tolerance = Number(e.rating_tolerance ?? 0);
    if (high !== null && rating >= high + tolerance) return `is for players rated under ${(high + tolerance).toFixed(2)}`;
    if (low !== null && rating < low) {
      if (!e.allow_play_up) return `is for players rated ${low.toFixed(1)} and up`;
      const limit = num(e.play_up_limit ?? null);
      if (limit !== null && rating < low - limit) return `lets players rated ${(low - limit).toFixed(1)} and up play up`;
    }
  }
  return null;
}

const level = (v: string | number | null) => (v === null ? '' : Number(v).toFixed(1));

export function skillText(e: Division) {
  switch (e.skill_rule) {
    case 'only':
      return level(e.skill_level);
    case 'and_under':
      return `${level(e.skill_level)} & under`;
    case 'and_above':
      return `${level(e.skill_level)}+`;
    case 'range':
      return `${level(e.skill_level)}–${level(e.skill_level_to)}`;
    default:
      return '';
  }
}

export function ageText(e: Division) {
  if (e.min_age !== null && e.max_age !== null) return `${e.min_age}–${e.max_age}`;
  if (e.min_age !== null) return `${e.min_age}+`;
  if (e.max_age !== null) return `${e.max_age} & under`;
  return '';
}

const genderText = { open: '', mens: "Men's", womens: "Women's", mixed: 'Mixed' } as const;

/** "Men's Doubles 3.5 50+": a name to start from when creating an event. */
export function suggestEventName(e: Division) {
  return [genderText[e.gender] || 'Open', e.kind === 'singles' ? 'Singles' : 'Doubles', skillText(e), ageText(e)]
    .filter(Boolean)
    .join(' ');
}

/** "Men's doubles · 3.5 (DUPR) · ages 50+ · up to 16 teams" */
export function describeDivision(e: Division & { dupr_rated?: boolean }) {
  const skill = skillText(e);
  return [
    `${genderText[e.gender] ? `${genderText[e.gender]} ` : ''}${e.kind === 'singles' ? 'singles' : 'doubles'}`,
    skill ? `${skill}${e.rating_source === 'dupr' ? ' (DUPR)' : ''}${e.allow_play_up ? ', play-up OK' : ''}` : 'all levels',
    ageText(e) ? `ages ${ageText(e)}${e.age_basis === 'year_end' ? ' by Dec 31' : ''}` : '',
    e.team_rating_max ? `team rating under ${Number(e.team_rating_max).toFixed(1)}` : '',
    e.team_age_min ? `combined age ${e.team_age_min}+` : '',
    e.require_dupr_id ? 'DUPR ID required' : '',
    e.dupr_rated === false ? 'not DUPR rated' : '',
    e.max_teams ? `up to ${e.max_teams} ${e.kind === 'singles' ? 'players' : 'teams'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
