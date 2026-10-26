'use client';

import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import {
  addTeamsFromText,
  clearMatches,
  deleteEvent,
  deleteTeam,
  generateMatches,
  getCourtBoard,
  getEvents,
  getMatches,
  getTeams,
  getTournament,
  renameCourt,
  saveEvent,
  setAdvancePerPool,
  setCourtStream,
  setTournamentStatus,
  updateTournament,
} from '@/lib/api';
import { describeDivision, suggestEventName } from '@/lib/eligibility';
import { formatSummary, fromZonedInput, poolName, shortFormat, toZonedInput } from '@/lib/format';
import { isYoutubeUrl } from '@/lib/youtube';
import { DiscountCodesCard, FeesCard, RegistrationCard, SharingCard } from './SetupCards';
import { useAction, useLiveTournament, useStaffAccess } from '@/lib/hooks';
import type {
  BracketType,
  CourtBoardRow,
  EventFormat,
  MatchDetails,
  RoundFormat,
  RoundKey,
  Team,
  Tournament,
  TournamentEvent,
  TournamentStatus,
} from '@/lib/types';

async function load(id: string) {
  const [tournament, events, teams, matches, courts] = await Promise.all([
    getTournament(id),
    getEvents(id),
    getTeams(id),
    getMatches(id),
    getCourtBoard(id),
  ]);
  return { tournament, events, teams, matches, courts };
}

export function Setup({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => load(id));
  const [adding, setAdding] = useState(false);

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>Setup is for this tournament’s directors.</Empty>;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-3xl">Events</h2>
          {!adding && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add event
            </Button>
          )}
        </div>
        {adding && (
          <Card className="p-4">
            <EventForm tournamentId={id} timeZone={data.tournament.time_zone} onDone={() => (setAdding(false), reload())} onCancel={() => setAdding(false)} />
          </Card>
        )}
        {data.events.length === 0 && !adding && <Empty>Add your first event, e.g. “Men’s Doubles 3.5”.</Empty>}
        {data.events.map((e) => (
          <EventCard
            key={e.id}
            event={e}
            timeZone={data.tournament.time_zone}
            teams={data.teams.filter((t) => t.event_id === e.id)}
            matches={data.matches.filter((m) => m.event_id === e.id)}
            onChanged={reload}
          />
        ))}
      </section>

      <aside className="flex flex-col gap-4">
        <StatusCard tournament={data.tournament} onChanged={reload} />
        <SettingsCard key={data.tournament.id} tournament={data.tournament} onChanged={reload} />
        <PricesCard key={`prices-${data.tournament.id}`} tournament={data.tournament} onChanged={reload} />
        <FeesCard tournament={data.tournament} onChanged={reload} />
        <SharingCard tournament={data.tournament} />
        <RegistrationCard key={`reg-${data.tournament.id}`} tournament={data.tournament} onChanged={reload} />
        <DiscountCodesCard tournament={data.tournament} />
        <StreamsCard tournament={data.tournament} courts={data.courts} onChanged={reload} />
      </aside>
    </div>
  );
}

const statuses: { value: TournamentStatus; label: string; hint: string }[] = [
  { value: 'draft', label: 'Draft', hint: 'Only directors can see it.' },
  { value: 'registration', label: 'Registration', hint: 'Public, not playing yet.' },
  { value: 'live', label: 'Live', hint: 'Courts are filled automatically.' },
  { value: 'complete', label: 'Complete', hint: 'Finished; results stay public.' },
];

function StatusCard({ tournament, onChanged }: { tournament: Tournament; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-xl">Status</h2>
      <div className="flex flex-col gap-2">
        {statuses.map((s) => (
          <button
            key={s.value}
            disabled={busy}
            onClick={() => run(() => setTournamentStatus(tournament.id, s.value), onChanged)}
            className={`rounded-lg border px-3 py-2 text-left ${
              tournament.status === s.value ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2'
            }`}
          >
            <div className="text-sm font-medium">{s.label}</div>
            <div className="text-xs text-muted">{s.hint}</div>
          </button>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

function SettingsCard({ tournament, onChanged }: { tournament: Tournament; onChanged: () => void }) {
  const [form, setForm] = useState({
    name: tournament.name,
    starts_on: tournament.starts_on,
    time_zone: tournament.time_zone,
    min_rest_minutes: tournament.min_rest_minutes,
    no_show_minutes: tournament.no_show_minutes,
    overdue_after_minutes: tournament.overdue_after_minutes,
    match_slot_minutes: tournament.match_slot_minutes,
    location: tournament.location ?? '',
    dupr_score_type: tournament.dupr_score_type,
  });
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const num = (key: keyof typeof form) => ({
    type: 'number',
    min: 0,
    value: form[key] as number,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: Number(e.target.value) }),
  });

  return (
    <Card className="p-4">
      <h2 className="mb-3 text-xl">Settings</h2>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          run(
            () => updateTournament(tournament.id, { ...form, location: form.location.trim() || null }),
            () => (setSaved(true), onChanged()),
          );
        }}
      >
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Date">
          <Input type="date" value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} />
        </Field>
        <Field label="Venue" hint="Sent to DUPR with results">
          <Input placeholder="Club name, street, city" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </Field>
        <Field label="Scoring" hint="For DUPR results">
          <Select
            value={form.dupr_score_type}
            onChange={(e) => setForm({ ...form, dupr_score_type: e.target.value as Tournament['dupr_score_type'] })}
          >
            <option value="SIDEOUT">Side-out (traditional)</option>
            <option value="RALLY">Rally scoring</option>
          </Select>
        </Field>
        <Field label="Time zone">
          <Select value={form.time_zone} onChange={(e) => setForm({ ...form, time_zone: e.target.value })}>
            {['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'Pacific/Honolulu'].map(
              (z) => (
                <option key={z}>{z}</option>
              ),
            )}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Rest (min)" hint="Between a player’s matches">
            <Input {...num('min_rest_minutes')} />
          </Field>
          <Field label="No-show (min)" hint="Flag a court after">
            <Input {...num('no_show_minutes')} />
          </Field>
          <Field label="Overdue (min)" hint="Hold players for a match after">
            <Input {...num('overdue_after_minutes')} />
          </Field>
          <Field label="Match length (min)" hint="Orders the queue">
            <Input {...num('match_slot_minutes')} />
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        {saved && <p className="text-sm text-accent">Saved.</p>}
        <Button type="submit" disabled={busy}>
          Save settings
        </Button>
      </form>
    </Card>
  );
}

/** YouTube links: one for the whole event, and one per streamed court. */
function StreamsCard({ tournament, courts, onChanged }: { tournament: Tournament; courts: CourtBoardRow[]; onChanged: () => void }) {
  const [main, setMain] = useState(tournament.stream_url ?? '');
  const [perCourt, setPerCourt] = useState<Record<string, { name: string; url: string }>>(() =>
    Object.fromEntries(courts.map((c) => [c.court_id, { name: c.court_name, url: c.stream_url ?? '' }])),
  );
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const bad = [main, ...Object.values(perCourt).map((c) => c.url)].find((u) => u.trim() && !isYoutubeUrl(u.trim()));

  return (
    <Card className="p-4">
      <h2 className="text-xl">Live streams</h2>
      <p className="mb-3 text-xs text-muted">
        Paste YouTube links. Players see “Watch live” on the tournament page, and their court’s stream when their match is on it.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          run(
            async () => {
              await updateTournament(tournament.id, { stream_url: main.trim() || null });
              for (const c of courts) {
                const next = perCourt[c.court_id];
                if (!next) continue;
                if (next.url.trim() !== (c.stream_url ?? '')) await setCourtStream(c.court_id, next.url.trim() || null);
                if (next.name.trim() && next.name.trim() !== c.court_name) await renameCourt(c.court_id, next.name.trim());
              }
            },
            () => (setSaved(true), onChanged()),
          );
        }}
      >
        <Field label="Main stream">
          <Input placeholder="https://youtube.com/live/…" value={main} onChange={(e) => setMain(e.target.value)} />
        </Field>
        {courts.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Courts</span>
            {courts.map((c) => {
              const v = perCourt[c.court_id] ?? { name: c.court_name, url: '' };
              const update = (patch: Partial<typeof v>) => setPerCourt((p) => ({ ...p, [c.court_id]: { ...v, ...patch } }));
              return (
                <div key={c.court_id} className="grid grid-cols-[6.5rem_1fr] gap-2">
                  <Input aria-label="Court name" value={v.name} onChange={(e) => update({ name: e.target.value })} />
                  <Input aria-label={`${c.court_name} stream`} placeholder="No stream" value={v.url} onChange={(e) => update({ url: e.target.value })} />
                </div>
              );
            })}
          </div>
        )}
        {bad && <p className="text-xs text-late">“{bad}” isn’t a YouTube link.</p>}
        <ErrorText>{error}</ErrorText>
        {saved && <p className="text-sm text-accent">Saved.</p>}
        <Button type="submit" disabled={busy || !!bad}>
          Save streams
        </Button>
      </form>
    </Card>
  );
}

const dollars = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));
const cents = (value: string) => (value.trim() === '' ? null : Math.round(Number(value) * 100));

function PricesCard({ tournament, onChanged }: { tournament: Tournament; onChanged: () => void }) {
  const [form, setForm] = useState({
    entry: dollars(tournament.entry_fee_cents),
    extra: dollars(tournament.extra_event_fee_cents),
    earlyEntry: dollars(tournament.early_entry_fee_cents),
    earlyExtra: dollars(tournament.early_extra_event_fee_cents),
    earlyUntil: tournament.early_until ? toLocalInput(tournament.early_until).slice(0, 10) : '',
    refundFee: dollars(tournament.refund_fee_cents),
  });
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const money = (key: keyof typeof form, placeholder = '0.00') => ({
    type: 'number',
    min: 0,
    step: '0.01',
    inputMode: 'decimal' as const,
    placeholder,
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value }),
  });

  return (
    <Card className="p-4">
      <h2 className="text-xl">Prices</h2>
      <p className="mb-3 text-xs text-muted">All-in prices players see: bake processing and texting costs in.</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          run(
            () =>
              updateTournament(tournament.id, {
                entry_fee_cents: cents(form.entry) ?? 0,
                extra_event_fee_cents: cents(form.extra) ?? 0,
                early_entry_fee_cents: cents(form.earlyEntry),
                early_extra_event_fee_cents: cents(form.earlyExtra),
                // Early prices last through the end of the chosen day.
                early_until: form.earlyUntil ? new Date(`${form.earlyUntil}T23:59:59`).toISOString() : null,
                refund_fee_cents: cents(form.refundFee) ?? 0,
              }),
            () => (setSaved(true), onChanged()),
          );
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="First event ($)">
            <Input {...money('entry')} />
          </Field>
          <Field label="Each extra event ($)">
            <Input {...money('extra')} />
          </Field>
          <Field label="Early first event ($)" hint="Optional">
            <Input {...money('earlyEntry', '')} />
          </Field>
          <Field label="Early extra event ($)" hint="Optional">
            <Input {...money('earlyExtra', '')} />
          </Field>
          <Field label="Early prices through">
            <Input type="date" value={form.earlyUntil} onChange={(e) => setForm({ ...form, earlyUntil: e.target.value })} />
          </Field>
          <Field label="Kept on refunds ($)">
            <Input {...money('refundFee')} />
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        {saved && <p className="text-sm text-accent">Saved.</p>}
        <Button type="submit" disabled={busy}>
          Save prices
        </Button>
      </form>
    </Card>
  );
}

const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const LEVELS = ['2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5', '6.0'];
const optionalNumber = (v: string) => (v === '' ? null : Number(v));

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 font-display text-lg font-bold uppercase">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/**
 * Add or edit an event. Once its schedule is built, the fields that shape the
 * schedule (format, pools, singles/doubles) are locked; everything else can
 * still be changed live.
 */
function EventForm({
  tournamentId,
  timeZone,
  event,
  scheduled = false,
  onDone,
  onCancel,
}: {
  tournamentId: string;
  timeZone: string;
  event?: TournamentEvent;
  scheduled?: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
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
    pool_count: event?.pool_count ?? 2,
    advance_per_pool: event?.advance_per_pool ?? 2,
    games_to: event?.games_to ?? 11,
    best_of: event?.best_of ?? 1,
    point_cap: event?.point_cap ?? null,
    playoff_games_to: event?.playoff_games_to ?? null,
    playoff_best_of: event?.playoff_best_of ?? null,
    playoff_point_cap: event?.playoff_point_cap ?? null,
    rating_tolerance: event ? Number(event.rating_tolerance) : 0,
    play_up_limit: event?.play_up_limit != null ? String(Number(event.play_up_limit)) : '',
    require_dupr_id: event?.require_dupr_id ?? false,
    team_rating_max: event?.team_rating_max != null ? String(Number(event.team_rating_max)) : '',
    team_age_min: event?.team_age_min?.toString() ?? '',
    max_rounds: event?.max_rounds?.toString() ?? '',
    bracket_type: event?.bracket_type ?? ('single' as BracketType),
    third_place_match: event?.third_place_match ?? false,
    grand_final_reset: event?.grand_final_reset ?? true,
    confirm_seeds: event?.confirm_seeds ?? false,
    round_formats: event?.round_formats ?? ([] as RoundFormat[]),
    not_before: toZonedInput(event?.not_before, timeZone),
  });
  const { busy, error, run } = useAction();
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const hasPools = form.format !== 'single_elim';
  const hasBracket = form.format !== 'round_robin';
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
    rating_tolerance: form.skill_rule === 'open' ? 0 : form.rating_tolerance,
    play_up_limit: form.allow_play_up ? optionalNumber(form.play_up_limit) : null,
    require_dupr_id: form.require_dupr_id,
    team_rating_max: form.kind === 'doubles' ? optionalNumber(form.team_rating_max) : null,
    team_age_min: form.kind === 'doubles' ? optionalNumber(form.team_age_min) : null,
  };
  const suggested = suggestEventName(division);

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          // After the schedule is built, a new advance count rebuilds the bracket.
          if (scheduled && event && form.advance_per_pool !== event.advance_per_pool) {
            await setAdvancePerPool(event.id, form.advance_per_pool);
          }
          await saveEvent({
              id: event?.id,
              tournament_id: tournamentId,
              name: form.name || suggested,
              ...division,
              partner_required: form.partner_required,
              ...(scheduled
                ? {}
                : {
                    format: form.format,
                    pool_count: hasPools ? form.pool_count : 1,
                    advance_per_pool: form.advance_per_pool,
                    max_rounds: hasPools ? optionalNumber(form.max_rounds) : null,
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
            } as Partial<TournamentEvent> & { tournament_id: string });
        }, onDone);
      }}
    >
      <div className="flex flex-col gap-1">
        <Field label="Event name">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={suggested} />
        </Field>
        {form.name !== suggested && (
          <button type="button" className="self-start text-sm text-muted underline hover:text-text" onClick={() => set('name', suggested)}>
            Use “{suggested}”
          </button>
        )}
      </div>

      <Section title="Division">
        <Field label="Play">
          <Select value={form.kind} disabled={scheduled} onChange={(e) => set('kind', e.target.value as TournamentEvent['kind'])}>
            <option value="doubles">Doubles</option>
            <option value="singles">Singles</option>
          </Select>
        </Field>
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
            <Field label="Leeway over the top" hint="Lets players just over the limit in. Nobody plays down past this.">
              <Select value={form.rating_tolerance} onChange={(e) => set('rating_tolerance', Number(e.target.value))}>
                <option value={0}>None</option>
                <option value={0.1}>0.10</option>
                <option value={0.25}>0.25</option>
                <option value={0.5}>0.50</option>
              </Select>
            </Field>
            {form.allow_play_up && (
              <Field label="How far players may play up">
                <Select value={form.play_up_limit} onChange={(e) => set('play_up_limit', e.target.value)}>
                  <option value="">Any amount</option>
                  <option value="0.5">Up to 0.5</option>
                  <option value="1">Up to 1.0</option>
                  <option value="1.5">Up to 1.5</option>
                </Select>
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
          label="Every player must give a DUPR ID"
          checked={form.require_dupr_id}
          onChange={(v) => set('require_dupr_id', v)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min age">
            <Input type="number" min={0} placeholder="Any" value={form.min_age} onChange={(e) => set('min_age', e.target.value)} />
          </Field>
          <Field label="Max age">
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

      <Section title="Format">
        <Field label="Format" hint={scheduled ? 'Clear the schedule to change the format.' : undefined}>
          <Select value={form.format} disabled={scheduled} onChange={(e) => set('format', e.target.value as EventFormat)}>
            <option value="pools_to_bracket">Pools, then bracket</option>
            <option value="round_robin">Round robin only</option>
            <option value="single_elim">Bracket only</option>
          </Select>
        </Field>
        {hasPools && (
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
        {hasPools && (
          <Field label="Max rounds" hint="Optional. E.g. 8 teams can play 6 rounds instead of 7.">
            <Input
              type="number"
              min={1}
              disabled={scheduled}
              placeholder="Everyone plays everyone"
              value={form.max_rounds}
              onChange={(e) => set('max_rounds', e.target.value)}
            />
          </Field>
        )}
        {form.format === 'pools_to_bracket' && (
          <Field
            label="Advance per pool"
            hint={
              event?.playoffs_seeded_at
                ? 'The bracket is seeded, so this is set.'
                : scheduled
                  ? 'Changing it rebuilds the bracket. Possible until pool play ends.'
                  : undefined
            }
          >
            <Input
              type="number"
              min={1}
              disabled={!!event?.playoffs_seeded_at}
              value={form.advance_per_pool}
              onChange={(e) => set('advance_per_pool', Number(e.target.value))}
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
            <Select value={form.bracket_type} disabled={scheduled} onChange={(e) => set('bracket_type', e.target.value as BracketType)}>
              <option value="single">Single elimination</option>
              <option value="double">Double elimination</option>
            </Select>
          </Field>
          {form.bracket_type === 'single' ? (
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
          <Check
            label="Hold the bracket so I can review and swap seeds before it starts"
            checked={form.confirm_seeds}
            onChange={(v) => set('confirm_seeds', v)}
          />
        </Section>
      )}

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
        {hasBracket && (
          <RoundFormatsEditor
            bracketType={form.bracket_type}
            bronze={form.bracket_type === 'single' && form.third_place_match}
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

      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {event ? 'Save event' : 'Add event'}
        </Button>
      </div>
    </form>
  );
}

function Check({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`flex items-center gap-2 self-end pb-2 text-sm ${disabled ? 'opacity-60' : ''}`}>
      <input
        type="checkbox"
        className="h-5 w-5 shrink-0 accent-[var(--accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

const roundKeys = (type: BracketType, bronze: boolean): [RoundKey, string][] =>
  type === 'double'
    ? [
        ['winners', 'Winners bracket'],
        ['losers', 'Losers bracket'],
        ['grand_final', 'Grand final'],
      ]
    : [
        ['earlier', 'Early rounds'],
        ['quarterfinal', 'Quarterfinals'],
        ['semifinal', 'Semifinals'],
        ['final', 'Final'],
        ...(bronze ? ([['bronze', 'Bronze']] as [RoundKey, string][]) : []),
      ];

/** A game format per bracket round; rounds left on "Default" use the bracket format. */
function RoundFormatsEditor({
  bracketType,
  bronze,
  value,
  fallback,
  onChange,
}: {
  bracketType: BracketType;
  bronze: boolean;
  value: RoundFormat[];
  fallback: { games_to: number; best_of: number; point_cap: number | null };
  onChange: (v: RoundFormat[]) => void;
}) {
  const keys = roundKeys(bracketType, bronze);
  const get = (key: RoundKey) => value.find((f) => f.key === key);
  const put = (key: RoundKey, f: RoundFormat | null) => onChange([...value.filter((x) => x.key !== key), ...(f ? [f] : [])]);
  return (
    <div className="flex flex-col gap-2 sm:col-span-2">
      <span className="text-sm font-medium">Format by round</span>
      <div className="overflow-hidden rounded-lg border border-border">
        {keys.map(([key, label]) => {
          const f = get(key);
          const current: RoundFormat = f ?? { key, ...fallback };
          return (
            <div
              key={key}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-0 max-sm:grid-cols-2"
            >
              <span className="font-medium max-sm:col-span-2">
                {label} <span className="font-normal text-muted">· {shortFormat(current)}</span>
              </span>
              <Select
                aria-label={`${label} games to`}
                className="h-9"
                value={f ? current.games_to : ''}
                onChange={(e) => put(key, e.target.value === '' ? null : { ...current, games_to: Number(e.target.value) })}
              >
                <option value="">Default</option>
                {[11, 15, 21].map((n) => (
                  <option key={n} value={n}>
                    to {n}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={`${label} match length`}
                className="h-9"
                value={f ? current.best_of : ''}
                onChange={(e) => put(key, e.target.value === '' ? null : { ...current, best_of: Number(e.target.value) })}
              >
                <option value="">Default</option>
                <option value={1}>1 game</option>
                <option value={3}>Best of 3</option>
                <option value={5}>Best of 5</option>
              </Select>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted">Texts tell players their round’s format, e.g. “Best of 3 games to 15, win by 2.”</p>
    </div>
  );
}

function EventCard({
  event,
  timeZone,
  teams,
  matches,
  onChanged,
}: {
  event: TournamentEvent;
  timeZone: string;
  teams: Team[];
  matches: MatchDetails[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const scheduled = matches.length > 0;
  const started = matches.some((m) => m.status !== 'waiting' && m.status !== 'queued');
  const nextSeed = Math.max(0, ...teams.map((t) => t.seed ?? 0)) + 1;

  if (editing) {
    return (
      <Card className="p-4">
        <EventForm
          tournamentId={event.tournament_id}
          timeZone={timeZone}
          event={event}
          scheduled={scheduled}
          onDone={() => (setEditing(false), onChanged())}
          onCancel={() => setEditing(false)}
        />
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xl">{event.name}</h3>
          <p className="text-sm">{describeDivision(event)}</p>
          <p className="text-sm text-muted">
            {formatSummary(event)} · {shortFormat(event)}
            {event.third_place_match ? ' · bronze match' : ''}
            {event.confirm_seeds ? ' · seeds reviewed' : ''} · {teams.length} teams
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {scheduled ? (
            <Badge tone="live">{matches.length} matches scheduled</Badge>
          ) : (
            <Badge>Not scheduled</Badge>
          )}
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <h4 className="mb-2 text-sm font-medium">Teams (in seed order)</h4>
          {teams.length === 0 ? (
            <p className="text-sm text-muted">No teams yet.</p>
          ) : (
            <ol className="flex max-h-72 flex-col overflow-y-auto rounded-lg border border-border text-sm">
              {[...teams]
                .sort((a, b) => (a.seed ?? 999) - (b.seed ?? 999))
                .map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5 last:border-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="tnum w-5 text-right text-xs text-muted">{t.seed}</span>
                      <span className="truncate">{t.name}</span>
                      {t.pool && <span className="text-xs text-muted">{poolName(t.pool)}</span>}
                    </span>
                    {!scheduled && (
                      <button
                        className="text-xs text-muted hover:text-late"
                        disabled={busy}
                        onClick={() => run(() => deleteTeam(t.id), onChanged)}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
            </ol>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">{scheduled ? 'Add alternates' : 'Add teams'}</h4>
          {scheduled && (
            <p className="text-xs text-muted">
              The schedule is built, so new teams aren’t in it. Swap one in for a dropped team on the Players page.
            </p>
          )}
          <Textarea
            rows={scheduled ? 3 : 6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'One team per line, best seed first:\nPat Davis / Sam Lee\nJo Park / Ana Cho'}
          />
          <Button disabled={busy || !text.trim()} onClick={() => run(() => addTeamsFromText(event.id, text, nextSeed), () => (setText(''), onChanged()))}>
            {scheduled ? 'Add alternates' : 'Add teams'}
          </Button>
        </div>
      </div>

      <ErrorText>{error}</ErrorText>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
        {!scheduled ? (
          <Button variant="primary" disabled={busy || teams.length < 2} onClick={() => run(() => generateMatches(event.id), onChanged)}>
            Build schedule
          </Button>
        ) : (
          <Button
            disabled={busy || started}
            title={started ? 'Matches have already been played' : undefined}
            onClick={() => confirm('Delete this event’s schedule so you can change teams or format?') && run(() => clearMatches(event.id), onChanged)}
          >
            Clear schedule
          </Button>
        )}
        {!scheduled && (
          <Button
            variant="ghost"
            className="ml-auto text-late"
            disabled={busy}
            onClick={() => confirm(`Delete ${event.name} and its teams?`) && run(() => deleteEvent(event.id), onChanged)}
          >
            Delete event
          </Button>
        )}
      </div>
    </Card>
  );
}
