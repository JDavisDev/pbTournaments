'use client';

// The sections of a division's form (EventForm), each editing part of its draft.
import { Check, Field, Input, Select, Textarea } from '@/components/ui';
import { advanceRule } from '@/lib/format';
import type { BracketType, EventFormat, PoolPlay, TournamentEvent } from '@/lib/types';
import { ratingText, type ratingLimits } from '@/lib/eligibility';
import type { EventDraft } from './EventForm';
import { LEVELS, optionalNumber, Section } from './fields';
import { RoundFormatsEditor } from './RoundFormatsEditor';

export interface FieldsProps {
  form: EventDraft;
  set: <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => void;
}

/** Who may enter: singles or doubles, gender, skill and age rules, size. */
export function DivisionFields({
  form,
  set,
  scheduled,
  limits,
  firstEventIncluded,
  simple,
}: FieldsProps & {
  scheduled: boolean;
  limits: ReturnType<typeof ratingLimits>;
  firstEventIncluded: boolean;
  /** Teams are pasted in, so nobody is checked against rules: only singles or doubles. */
  simple: boolean;
}) {
  const play = (
    <Field label="Play">
      <Select value={form.kind} disabled={scheduled} onChange={(e) => set('kind', e.target.value as TournamentEvent['kind'])}>
        <option value="doubles">Doubles</option>
        <option value="singles">Singles</option>
      </Select>
    </Field>
  );
  if (simple) return <Section title="Division">{play}</Section>;
  return (
    <Section title="Division">
      {play}
      <Field label="Gender">
        <Select value={form.gender} onChange={(e) => set('gender', e.target.value as TournamentEvent['gender'])}>
          <option value="open">Open (anyone)</option>
          <option value="mens">Men’s</option>
          <option value="womens">Women’s</option>
          {form.kind === 'doubles' && <option value="mixed">Mixed (one man, one woman)</option>}
        </Select>
      </Field>
      <Field label="Skill" hint="Nobody may play down. Ratings like 3.99 count as 3.5.">
        <Select value={form.skill_rule} onChange={(e) => set('skill_rule', e.target.value as TournamentEvent['skill_rule'])}>
          <option value="open">All levels</option>
          <option value="only">Only this level</option>
          <option value="and_under">This level and under</option>
          <option value="and_above">This level and above</option>
          <option value="range">Range</option>
        </Select>
      </Field>
      {form.skill_rule !== 'open' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={form.skill_rule === 'range' ? 'From' : 'Level'}>
            <Select value={form.skill_level} onChange={(e) => set('skill_level', e.target.value)}>
              {LEVELS.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </Select>
          </Field>
          {form.skill_rule === 'range' && (
            <Field label="To">
              <Select value={form.skill_level_to} onChange={(e) => set('skill_level_to', e.target.value)}>
                {LEVELS.filter((l) => Number(l) >= Number(form.skill_level)).map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}
      {form.skill_rule !== 'open' && (
        <>
          <Field label="Rating">
            <Select
              value={form.rating_source}
              onChange={(e) => set('rating_source', e.target.value as TournamentEvent['rating_source'])}
            >
              <option value="dupr_or_self">DUPR, or self-rating if none</option>
              <option value="dupr">DUPR only</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--accent)]"
              checked={form.allow_play_up}
              onChange={(e) => set('allow_play_up', e.target.checked)}
            />
            Allow lower-rated players to play up
          </label>
          {limits.under !== null && (
            <Field
              label="Leeway over the top"
              hint={`Players rated under ${ratingText(limits.under)} can enter.${
                form.rating_tolerance ? '' : ' Add leeway (any amount, e.g. 0.15) to let players just over the limit in.'
              }`}
            >
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                max={5}
                step={0.01}
                placeholder="None"
                value={form.rating_tolerance}
                onChange={(e) => set('rating_tolerance', e.target.value)}
              />
            </Field>
          )}
          {form.allow_play_up && (
            <Field
              label="How far players may play up"
              hint={
                limits.playUpFrom !== null
                  ? `Players rated ${ratingText(limits.playUpFrom)} and up can play up.`
                  : 'Optional, any amount (e.g. 0.3). Blank: anyone rated lower can play up.'
              }
            >
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                max={5}
                step={0.01}
                placeholder="Any amount"
                value={form.play_up_limit}
                onChange={(e) => set('play_up_limit', e.target.value)}
              />
            </Field>
          )}
        </>
      )}
      {form.kind === 'doubles' && (
        <>
          <Field label="Team rating limit" hint="Optional. Both players’ ratings added must be under this, e.g. 7.5.">
            <Input
              type="number"
              step="0.25"
              min={2}
              placeholder="No limit"
              value={form.team_rating_max}
              onChange={(e) => set('team_rating_max', e.target.value)}
            />
          </Field>
          <Field label="Combined age" hint="Optional. Both players’ ages added must be at least this, e.g. 110.">
            <Input
              type="number"
              min={1}
              placeholder="Any"
              value={form.team_age_min}
              onChange={(e) => set('team_age_min', e.target.value)}
            />
          </Field>
        </>
      )}
      <Check
        label="Results go to DUPR (rated division)"
        checked={form.dupr_rated}
        onChange={(v) => set('dupr_rated', v)}
      />
      {firstEventIncluded && (
        <Check
          label="Can be the event included in registration"
          checked={form.included_in_registration}
          onChange={(v) => set('included_in_registration', v)}
        />
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Min age">
          <Input type="number" min={0} placeholder="Any" value={form.min_age} onChange={(e) => set('min_age', e.target.value)} />
        </Field>
        <Field label="Max age" hint="Players must be 18 or older.">
          <Input type="number" min={0} placeholder="Any" value={form.max_age} onChange={(e) => set('max_age', e.target.value)} />
        </Field>
      </div>
      {(form.min_age || form.max_age) && (
        <Field label="Age counted on">
          <Select value={form.age_basis} onChange={(e) => set('age_basis', e.target.value as TournamentEvent['age_basis'])}>
            <option value="tournament_day">Tournament day</option>
            <option value="year_end">December 31 of this year</option>
          </Select>
        </Field>
      )}
      <Field label={form.kind === 'singles' ? 'Max players' : 'Max teams'} hint="Optional. Registration closes when full.">
        <Input type="number" min={1} placeholder="No limit" value={form.max_teams} onChange={(e) => set('max_teams', e.target.value)} />
      </Field>
      {form.kind === 'doubles' && (
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[var(--accent)]"
            checked={!form.partner_required}
            onChange={(e) => set('partner_required', !e.target.checked)}
          />
          Players can register without a partner
        </label>
      )}
    </Section>
  );
}

/** Format and pools, then the bracket. */
export function FormatFields({
  form,
  set,
  setForm,
  scheduled,
  event,
  pools,
}: FieldsProps & {
  setForm: React.Dispatch<React.SetStateAction<EventDraft>>;
  scheduled: boolean;
  event?: TournamentEvent;
  pools: number;
}) {
  const hasPools = form.format !== 'single_elim';
  const hasBracket = form.format !== 'round_robin';
  const swiss = hasPools && form.pool_play === 'swiss';
  return (
    <>
      <Section title="Format">
        <Field label="Format" hint={scheduled ? 'Clear the schedule to change the format.' : undefined}>
          <Select
            value={form.format}
            disabled={scheduled}
            onChange={(e) => {
              const format = e.target.value as EventFormat;
              // Medal matches only follow pool play.
              setForm((f) => ({ ...f, format, bracket_type: format !== 'pools_to_bracket' && f.bracket_type === 'medal' ? 'single' : f.bracket_type }));
            }}
          >
            <option value="pools_to_bracket">Pool play, then bracket</option>
            <option value="round_robin">Pool play only</option>
            <option value="single_elim">Bracket only</option>
          </Select>
        </Field>
        {hasPools && (
          <Field
            label="Pool play"
            hint={swiss ? 'Each round pairs teams with similar records who haven’t played yet.' : 'Everyone in a pool plays each other.'}
          >
            <Select value={form.pool_play} disabled={scheduled} onChange={(e) => set('pool_play', e.target.value as PoolPlay)}>
              <option value="round_robin">Round robin</option>
              <option value="swiss">Swiss rounds</option>
            </Select>
          </Field>
        )}
        {hasPools && !swiss && (
          <Field label="Pools" hint="Teams are snake-seeded into pools">
            <Input
              type="number"
              min={1}
              max={26}
              disabled={scheduled}
              value={form.pool_count}
              onChange={(e) => set('pool_count', Number(e.target.value))}
            />
          </Field>
        )}
        {hasPools && !swiss && (
          <Field label="Teams play each other" hint="A double round robin plays everyone, then everyone again.">
            <Select
              disabled={scheduled}
              value={form.round_robin_times}
              onChange={(e) => set('round_robin_times', Number(e.target.value))}
            >
              <option value={1}>Once</option>
              <option value={2}>Twice (double round robin)</option>
              <option value={3}>3 times (triple round robin)</option>
            </Select>
          </Field>
        )}
        {hasPools && (
          <Field
            label={swiss ? 'Swiss rounds' : 'Max rounds'}
            hint={
              swiss
                ? 'Each round is drawn when the one before it finishes. 3 to 5 is typical.'
                : 'Optional. E.g. one pool of 15 can play 6 rounds instead of 15.'
            }
          >
            <Input
              type="number"
              min={1}
              required={swiss}
              disabled={scheduled}
              placeholder={swiss ? 'e.g. 4' : 'Everyone plays everyone'}
              value={form.max_rounds}
              onChange={(e) => set('max_rounds', e.target.value)}
            />
          </Field>
        )}
        {form.format === 'pools_to_bracket' && (
          <Field
            label="Teams in the bracket"
            hint={
              event?.playoffs_seeded_at
                ? 'The bracket is seeded, so this is set.'
                : `${advanceRule(pools, form.bracket_size)}${scheduled ? ' Changing it rebuilds the bracket, until pool play ends.' : ''}`
            }
          >
            <Input
              type="number"
              min={2}
              disabled={!!event?.playoffs_seeded_at}
              value={form.bracket_size}
              onChange={(e) => set('bracket_size', Number(e.target.value))}
            />
          </Field>
        )}
        <Field label="Start time" hint="Optional. Matches won’t be sent out before this.">
          <Input type="datetime-local" value={form.not_before} onChange={(e) => set('not_before', e.target.value)} />
        </Field>
      </Section>

      {hasBracket && (
        <Section title="Bracket">
          <Field label="Elimination">
            <Select
              value={form.bracket_type}
              disabled={scheduled}
              onChange={(e) => {
                const bracket_type = e.target.value as BracketType;
                // Medal matches are 1 v 2 for gold and 3 v 4 for bronze.
                setForm((f) => ({ ...f, bracket_type, bracket_size: bracket_type === 'medal' && f.bracket_size !== 2 ? 4 : f.bracket_size }));
              }}
            >
              <option value="single">Single elimination</option>
              <option value="double">Double elimination</option>
              {form.format === 'pools_to_bracket' && <option value="medal">Straight to medal matches</option>}
            </Select>
          </Field>
          {form.bracket_type === 'medal' ? (
            <p className="self-end pb-2 text-sm text-muted">
              Seeds 1 and 2 play for gold, 3 and 4 for bronze.
              {pools === 2 ? ' With 2 pools: the pool winners play for gold and the runners-up for bronze.' : ''}
            </p>
          ) : form.bracket_type === 'single' ? (
            <Check
              label="Bronze match (semifinal losers play for 3rd)"
              checked={form.third_place_match}
              disabled={scheduled}
              onChange={(v) => set('third_place_match', v)}
            />
          ) : (
            <Check
              label="Reset final if the losers-bracket team wins the grand final"
              checked={form.grand_final_reset}
              disabled={scheduled}
              onChange={(v) => set('grand_final_reset', v)}
            />
          )}
          {form.format === 'single_elim' ? (
            <Check
              label="Hold the bracket so I can review and swap seeds before it starts"
              checked={form.confirm_seeds}
              onChange={(v) => set('confirm_seeds', v)}
            />
          ) : (
            <p className="self-end pb-2 text-sm text-muted">When pool play ends, you review the results and finalize them, then start the bracket.</p>
          )}
        </Section>
      )}
    </>
  );
}

/** Notes on the division's player guide. */
export function GuideFields({ form, set }: FieldsProps) {
  return (
    <Section title="Player guide">
      <div className="sm:col-span-2">
        <Field
          label="Notes for this division’s players"
          hint="Optional. On the division’s player guide, after its format and schedule: warm-ups, balls, courts, anything you’d otherwise announce."
        >
          <Textarea
            rows={4}
            maxLength={5000}
            value={form.player_notes}
            onChange={(e) => set('player_notes', e.target.value)}
            placeholder={'5-minute warm-up on your court.\nFranklin X-40 balls, provided.\nCourts 1–4 all morning.'}
          />
        </Field>
      </div>
    </Section>
  );
}

/** Game formats: pools, the bracket, and each bracket round. */
export function ScoringFields({ form, set }: FieldsProps) {
  const hasPools = form.format !== 'single_elim';
  const hasBracket = form.format !== 'round_robin';
  return (
    <Section title="Scoring">
      <Field label={hasBracket && hasPools ? 'Pool games to' : 'Games to'}>
        <Select value={form.games_to} onChange={(e) => set('games_to', Number(e.target.value))}>
          {[11, 15, 21].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </Select>
      </Field>
      <Field label={hasBracket && hasPools ? 'Pool match' : 'Match'}>
        <Select value={form.best_of} onChange={(e) => set('best_of', Number(e.target.value))}>
          <option value={1}>1 game</option>
          <option value={3}>Best of 3</option>
        </Select>
      </Field>
      <Field label={hasBracket && hasPools ? 'Pool point cap' : 'Point cap'} hint="Optional. Game ends here even if won by 1.">
        <Input
          type="number"
          min={form.games_to}
          placeholder="None (win by 2)"
          value={form.point_cap ?? ''}
          onChange={(e) => set('point_cap', optionalNumber(e.target.value))}
        />
      </Field>
      <Field label="Timeouts per team, per game" hint="Usually 2 in games to 11, 3 in games to 15 or 21.">
        <Input
          type="number"
          min={0}
          max={9}
          value={form.timeouts_per_game}
          onChange={(e) => set('timeouts_per_game', Math.max(0, Math.min(9, Number(e.target.value) || 0)))}
        />
      </Field>
      <Field label="Timeout length (min)">
        <Input
          type="number"
          min={1}
          max={10}
          value={form.timeout_minutes}
          onChange={(e) => set('timeout_minutes', Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
        />
      </Field>
      {hasBracket && (
        <RoundFormatsEditor
          bracketType={form.bracket_type}
          bronze={form.bracket_type === 'medal' ? form.bracket_size !== 2 : form.bracket_type === 'single' && form.third_place_match}
          value={form.round_formats}
          fallback={{
            games_to: form.playoff_games_to ?? form.games_to,
            best_of: form.playoff_best_of ?? form.best_of,
            point_cap: form.playoff_point_cap ?? form.point_cap,
          }}
          onChange={(v) => set('round_formats', v)}
        />
      )}
      {hasBracket && hasPools && (
        <>
          <Field label="Bracket games to">
            <Select value={form.playoff_games_to ?? ''} onChange={(e) => set('playoff_games_to', optionalNumber(e.target.value))}>
              <option value="">Same as pools</option>
              {[11, 15, 21].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </Select>
          </Field>
          <Field label="Bracket match">
            <Select value={form.playoff_best_of ?? ''} onChange={(e) => set('playoff_best_of', optionalNumber(e.target.value))}>
              <option value="">Same as pools</option>
              <option value={1}>1 game</option>
              <option value={3}>Best of 3</option>
            </Select>
          </Field>
          <Field label="Bracket point cap" hint="Optional. Blank = same as pools.">
            <Input
              type="number"
              min={form.playoff_games_to ?? form.games_to}
              value={form.playoff_point_cap ?? ''}
              onChange={(e) => set('playoff_point_cap', optionalNumber(e.target.value))}
            />
          </Field>
        </>
      )}
    </Section>
  );
}
