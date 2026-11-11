'use client';

import { useState } from 'react';
import { Button, ErrorText, Field, Input } from '@/components/ui';
import { saveEvent, setBracketSize } from '@/lib/api';
import { ratingLimits, suggestEventName } from '@/lib/eligibility';
import { bracketSeeds, defaultRoundFormats, fromZonedInput, toZonedInput } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { BracketType, CourtBoardRow, EventFormat, PoolPlay, TournamentEvent } from '@/lib/types';
import { DivisionFields, FormatFields, GuideFields, ScoringFields } from './EventFields';
import { CourtPicker, hundredths, optionalNumber, Section } from './fields';

/** A division's settings as the form edits them: strings for optional numbers. */
function draftOf(event: TournamentEvent | undefined, timeZone: string, simple: boolean) {
  return {
    name: event?.name ?? '',
    kind: event?.kind ?? ('doubles' as TournamentEvent['kind']),
    gender: event?.gender ?? ('open' as TournamentEvent['gender']),
    skill_rule: event?.skill_rule ?? ('open' as TournamentEvent['skill_rule']),
    skill_level: event?.skill_level ? Number(event.skill_level).toFixed(1) : '3.5',
    skill_level_to: event?.skill_level_to ? Number(event.skill_level_to).toFixed(1) : '4.0',
    rating_source: event?.rating_source ?? ('dupr_or_self' as TournamentEvent['rating_source']),
    allow_play_up: event?.allow_play_up ?? false,
    min_age: event?.min_age?.toString() ?? '',
    max_age: event?.max_age?.toString() ?? '',
    age_basis: event?.age_basis ?? ('tournament_day' as TournamentEvent['age_basis']),
    max_teams: event?.max_teams?.toString() ?? '',
    partner_required: event?.partner_required ?? true,
    format: event?.format ?? ('pools_to_bracket' as EventFormat),
    pool_play: event?.pool_play ?? ('round_robin' as PoolPlay),
    pool_count: event?.pool_count ?? 2,
    bracket_size: event ? bracketSeeds(event) : 4,
    games_to: event?.games_to ?? 11,
    best_of: event?.best_of ?? 1,
    point_cap: event?.point_cap ?? null,
    playoff_games_to: event?.playoff_games_to ?? null,
    playoff_best_of: event?.playoff_best_of ?? null,
    playoff_point_cap: event?.playoff_point_cap ?? null,
    rating_tolerance: event && Number(event.rating_tolerance) > 0 ? String(Number(event.rating_tolerance)) : '',
    play_up_limit: event?.play_up_limit != null ? String(Number(event.play_up_limit)) : '',
    dupr_rated: event?.dupr_rated ?? !simple,
    included_in_registration: event?.included_in_registration ?? true,
    player_notes: event?.player_notes ?? '',
    timeouts_per_game: event?.timeouts_per_game ?? 2,
    timeout_minutes: event?.timeout_minutes ?? 1,
    team_rating_max: event?.team_rating_max != null ? String(Number(event.team_rating_max)) : '',
    team_age_min: event?.team_age_min?.toString() ?? '',
    max_rounds: event?.max_rounds?.toString() ?? '',
    round_robin_times: event?.round_robin_times ?? 1,
    bracket_type: event?.bracket_type ?? ('single' as BracketType),
    third_place_match: event?.third_place_match ?? true,
    grand_final_reset: event?.grand_final_reset ?? true,
    confirm_seeds: event?.confirm_seeds ?? false,
    round_formats: event?.round_formats ?? defaultRoundFormats,
    not_before: toZonedInput(event?.not_before, timeZone),
    court_ids: event?.court_ids ?? [],
  };
}

export type EventDraft = ReturnType<typeof draftOf>;

/**
 * Add or edit an event. Once its schedule is built, the fields that shape the
 * schedule (format, pools, singles/doubles) are locked; everything else can
 * still be changed live.
 */
export function EventForm({
  tournamentId,
  timeZone,
  courts,
  event,
  scheduled = false,
  firstEventIncluded = false,
  simple = false,
  onDone,
  onCancel,
}: {
  tournamentId: string;
  timeZone: string;
  courts: CourtBoardRow[];
  event?: TournamentEvent;
  scheduled?: boolean;
  /** The tournament's registration fee covers one event: ask whether this division can be it. */
  firstEventIncluded?: boolean;
  /** A simple tournament: teams are pasted in, so no entry rules. */
  simple?: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(() => draftOf(event, timeZone, simple));
  const { busy, error, run } = useAction();
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const hasPools = form.format !== 'single_elim';
  const hasBracket = form.format !== 'round_robin';
  const swiss = hasPools && form.pool_play === 'swiss';
  // Swiss rounds play as one group.
  const pools = hasPools && !swiss ? Math.max(1, form.pool_count) : 1;
  const division = {
    kind: form.kind,
    gender: form.gender,
    skill_rule: form.skill_rule,
    skill_level: form.skill_rule === 'open' ? null : form.skill_level,
    skill_level_to: form.skill_rule === 'range' ? form.skill_level_to : null,
    rating_source: form.rating_source,
    allow_play_up: form.allow_play_up,
    min_age: optionalNumber(form.min_age),
    max_age: optionalNumber(form.max_age),
    age_basis: form.age_basis,
    max_teams: optionalNumber(form.max_teams),
    rating_tolerance: form.skill_rule === 'open' ? 0 : (hundredths(form.rating_tolerance) ?? 0),
    play_up_limit: form.allow_play_up ? hundredths(form.play_up_limit) : null,
    team_rating_max: form.kind === 'doubles' ? optionalNumber(form.team_rating_max) : null,
    team_age_min: form.kind === 'doubles' ? optionalNumber(form.team_age_min) : null,
  };
  const suggested = suggestEventName(division);
  const limits = ratingLimits(division);

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          // After the schedule is built, a new bracket size rebuilds the bracket.
          if (scheduled && event && form.format === 'pools_to_bracket' && form.bracket_size !== bracketSeeds(event)) {
            await setBracketSize(event.id, form.bracket_size);
          }
          await saveEvent({
              id: event?.id,
              tournament_id: tournamentId,
              name: form.name || suggested,
              ...division,
              partner_required: form.partner_required,
              dupr_rated: !simple && form.dupr_rated,
              included_in_registration: form.included_in_registration,
              player_notes: form.player_notes.trim() || null,
              timeouts_per_game: form.timeouts_per_game,
              timeout_minutes: form.timeout_minutes,
              ...(scheduled
                ? {}
                : {
                    format: form.format,
                    pool_play: hasPools ? form.pool_play : 'round_robin',
                    pool_count: pools,
                    advance_per_pool: Math.max(1, Math.floor(form.bracket_size / pools)),
                    bracket_size: form.format === 'pools_to_bracket' ? form.bracket_size : null,
                    max_rounds: hasPools ? optionalNumber(form.max_rounds) : null,
                    round_robin_times: hasPools && form.pool_play !== 'swiss' ? form.round_robin_times : 1,
                    bracket_type: form.bracket_type,
                    third_place_match: form.bracket_type === 'single' && form.third_place_match,
                    grand_final_reset: form.bracket_type === 'double' && form.grand_final_reset,
                  }),
              confirm_seeds: form.confirm_seeds,
              round_formats: hasBracket ? form.round_formats : [],
              games_to: form.games_to,
              best_of: form.best_of,
              point_cap: form.point_cap,
              playoff_games_to: form.playoff_games_to,
              playoff_best_of: form.playoff_best_of,
              playoff_point_cap: form.playoff_point_cap,
              not_before: form.not_before ? new Date(fromZonedInput(form.not_before, timeZone)).toISOString() : null,
              court_ids: form.court_ids.filter((c) => courts.some((x) => x.court_id === c)),
            } as Partial<TournamentEvent> & { tournament_id: string });
        }, onDone);
      }}
    >
      <div className="flex flex-col gap-1">
        <Field label="Division name">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={suggested} />
        </Field>
        {form.name !== suggested && (
          <button type="button" className="self-start text-sm text-muted underline hover:text-text" onClick={() => set('name', suggested)}>
            Use “{suggested}”
          </button>
        )}
      </div>

      <DivisionFields form={form} set={set} scheduled={scheduled} limits={limits} firstEventIncluded={firstEventIncluded} simple={simple} />
      <FormatFields form={form} set={set} setForm={setForm} scheduled={scheduled} event={event} pools={pools} />
      <GuideFields form={form} set={set} />
      <Section title="Courts">
        <div className="sm:col-span-2">
          <CourtPicker courts={courts} value={form.court_ids} onChange={(ids) => set('court_ids', ids)} />
        </div>
      </Section>
      <ScoringFields form={form} set={set} />

      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {event ? 'Save division' : 'Add division'}
        </Button>
      </div>
    </form>
  );
}
