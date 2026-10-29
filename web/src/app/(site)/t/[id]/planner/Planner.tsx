'use client';

// Plan the day before it happens: set each division's start time, format and
// how long its matches take, see every match laid onto the courts, and catch
// divisions that would wait for courts or run past closing. Saving writes the
// start times, match lengths and formats to the divisions; the queue uses them
// on the day.
import { Fragment, use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Badge, Button, Card, Check, Empty, ErrorText, Field, Input, Select, Spinner } from '@/components/ui';
import {
  getCourtBoard,
  getEvents,
  getMatches,
  getTeams,
  getTournament,
  rebuildQueue,
  saveEvent,
  setBracketSize,
  updateTournament,
} from '@/lib/api';
import { advanceRule, bracketSeeds, formatSummary, formatTime, fromZonedInput, toZonedInput } from '@/lib/format';
import { useAction, useLiveTournament, useStaffAccess } from '@/lib/hooks';
import { type Plan, type PlanDivision, planDay, suggestMinutes } from '@/lib/planner';
import type { BracketType, EventFormat, PoolPlay, RoundKey, Tournament, TournamentEvent } from '@/lib/types';

async function load(id: string) {
  const [tournament, events, teams, courts, matches] = await Promise.all([
    getTournament(id),
    getEvents(id),
    getTeams(id),
    getCourtBoard(id),
    getMatches(id),
  ]);
  return { tournament, events, teams, courts, matches };
}

const MIN = 60_000;
// Dark enough for white text in light and dark themes.
const COLORS = ['#1d6b44', '#2450c4', '#b25a00', '#7b3fc4', '#b0175a', '#00727d', '#6d4c41', '#4b5563', '#8a6d00', '#3949ab'];

interface Draft {
  start: string;
  teams: string;
  poolMinutes: string;
  bracketMinutes: string;
  goldMinutes: string;
  bronzeMinutes: string;
  format: EventFormat;
  poolPlay: PoolPlay;
  pools: string;
  maxRounds: string;
  bracketSize: string;
  bracketType: BracketType;
  thirdPlace: boolean;
  gfReset: boolean;
}

/** The format fields of a division, as Setup saves them. */
function formatOf(d: Draft) {
  const hasPools = d.format !== 'single_elim';
  const swiss = hasPools && d.poolPlay === 'swiss';
  // Swiss rounds play as one group.
  const pools = hasPools && !swiss ? Math.max(1, Math.floor(Number(d.pools)) || 1) : 1;
  const size = Math.max(2, Math.floor(Number(d.bracketSize)) || 2);
  const rounds = Math.floor(Number(d.maxRounds));
  return {
    format: d.format,
    pool_play: hasPools ? d.poolPlay : ('round_robin' as PoolPlay),
    pool_count: pools,
    advance_per_pool: Math.max(1, Math.floor(size / pools)),
    bracket_size: d.format === 'pools_to_bracket' ? size : null,
    max_rounds: hasPools && rounds > 0 ? rounds : null,
    bracket_type: d.bracketType,
    third_place_match: d.bracketType === 'single' && d.thirdPlace,
    grand_final_reset: d.bracketType === 'double' && d.gfReset,
  };
}
type Format = ReturnType<typeof formatOf>;

/** Whether a division has a gold match (a final) and a bronze match. */
function medalMatches(f: Format) {
  const bracket = f.format !== 'round_robin';
  return {
    gold: bracket,
    bronze: bracket && (f.bracket_type === 'medal' || f.third_place_match),
  };
}

function initialDraft(e: TournamentEvent, t: Tournament, teamCount: number): Draft {
  return {
    start: e.not_before ? toZonedInput(e.not_before, t.time_zone) : `${t.starts_on}T08:00`,
    teams: String(teamCount || e.max_teams || 8),
    poolMinutes: String(e.pool_match_minutes ?? suggestMinutes(e.games_to, e.best_of)),
    bracketMinutes: String(
      e.bracket_match_minutes ?? suggestMinutes(e.playoff_games_to ?? e.games_to, e.playoff_best_of ?? e.best_of),
    ),
    // From the medal rounds' own formats when they have one (e.g. gold best of 3).
    goldMinutes: String(e.gold_match_minutes ?? roundMinutes(e, e.bracket_type === 'double' ? 'grand_final' : 'final')),
    bronzeMinutes: String(e.bronze_match_minutes ?? roundMinutes(e, 'bronze')),
    format: e.format,
    poolPlay: e.pool_play,
    pools: String(e.pool_count),
    maxRounds: e.max_rounds?.toString() ?? '',
    bracketSize: String(bracketSeeds(e)),
    bracketType: e.bracket_type,
    thirdPlace: e.third_place_match,
    gfReset: e.grand_final_reset,
  };
}

/** Suggested minutes for a bracket round: its own format, else the bracket's. */
function roundMinutes(e: TournamentEvent, key: RoundKey) {
  const f = e.round_formats.find((r) => r.key === key);
  return suggestMinutes(f?.games_to ?? e.playoff_games_to ?? e.games_to, f?.best_of ?? e.playoff_best_of ?? e.best_of);
}

export function Planner({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => load(id), 60_000);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [settings, setSettings] = useState<{ courts: string; closes: string } | null>(null);
  const [day, setDay] = useState<string | null>(null);
  // The division whose format settings are open.
  const [open, setOpen] = useState<string | null>(null);
  const save = useAction();
  const [saved, setSaved] = useState(false);

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>The planner is for this tournament’s directors.</Empty>;

  const { tournament: t, events, teams, courts, matches } = data;
  if (events.length === 0) return <Empty>Add divisions in Settings first, then plan the day here.</Empty>;

  const activeTeams = (eventId: string) => teams.filter((x) => x.event_id === eventId && !x.withdrawn_at).length;
  const draftOf = (e: TournamentEvent) => drafts[e.id] ?? initialDraft(e, t, activeTeams(e.id));
  const s = settings ?? {
    courts: String(courts.filter((c) => !c.out_of_service).length || 1),
    closes: '21:00',
  };
  const setDraft = (e: TournamentEvent, patch: Partial<Draft>) => {
    setSaved(false);
    setDrafts((d) => ({ ...d, [e.id]: { ...draftOf(e), ...patch } }));
  };

  // Court numbers as the planner counts them: courts in use, in order.
  const courtNumber = new Map(courts.filter((c) => !c.out_of_service).map((c, i) => [c.court_id, i + 1]));
  // Once a division's schedule is built, its format is set (as in Setup).
  const scheduledEvent = (eventId: string) => matches.some((m) => m.event_id === eventId);
  const divisions: PlanDivision[] = events.map((e) => {
    const d = draftOf(e);
    const f = formatOf(d);
    const teamCount = Math.max(0, Number(d.teams) || 0);
    return {
      id: e.id,
      name: e.name,
      // A half-typed date falls back to the tournament day at 8:00.
      start: fromZonedInput(d.start, t.time_zone) || fromZonedInput(`${t.starts_on}T08:00`, t.time_zone),
      teams: teamCount,
      format: f.format,
      poolCount: f.pool_count,
      advancePerPool: f.advance_per_pool,
      // A bracket can't hold more teams than the division has.
      bracketSize: f.bracket_size === null ? null : Math.min(f.bracket_size, teamCount),
      swiss: f.pool_play === 'swiss',
      maxRounds: f.max_rounds,
      bracketType: f.bracket_type,
      thirdPlace: f.third_place_match,
      gfReset: f.grand_final_reset,
      poolMinutes: Math.max(5, Number(d.poolMinutes) || 15),
      bracketMinutes: Math.max(5, Number(d.bracketMinutes) || 20),
      goldMinutes: Math.max(5, Number(d.goldMinutes) || 20),
      bronzeMinutes: Math.max(5, Number(d.bronzeMinutes) || 20),
      courts: e.court_ids.flatMap((id) => courtNumber.get(id) ?? []),
    };
  });
  const plan = planDay(divisions, { courts: Math.max(1, Number(s.courts) || 1) });
  const color = new Map(events.map((e, i) => [e.id, COLORS[i % COLORS.length]]));
  const dayKey = (ms: number) => toZonedInput(ms, t.time_zone).slice(0, 10);
  const days = [...new Set(plan.matches.map((m) => dayKey(m.start)))].sort();
  const shownDay = day && days.includes(day) ? day : days[0];
  const closesAt = (ms: number) => fromZonedInput(`${dayKey(ms)}T${s.closes || '23:59'}`, t.time_zone);

  const busyMinutes = plan.matches.reduce((sum, m) => sum + (m.end - m.start) / MIN, 0);
  const span = (plan.end - plan.start) / MIN;
  const usage = span > 0 ? Math.round((busyMinutes / (span * Math.max(1, Number(s.courts) || 1))) * 100) : 0;
  const changed = Object.keys(drafts).length > 0;
  const scheduled = matches.length > 0;

  async function saveAll() {
    for (const e of events) {
      const d = drafts[e.id];
      if (!d) continue;
      const f = formatOf(d);
      const scheduledHere = scheduledEvent(e.id);
      // After the schedule is built, only the bracket size can change, until the bracket is seeded.
      if (scheduledHere && e.format === 'pools_to_bracket' && !e.playoffs_seeded_at && f.bracket_size !== bracketSeeds(e)) {
        await setBracketSize(e.id, f.bracket_size!);
      }
      await saveEvent({
        ...(scheduledHere ? {} : f),
        id: e.id,
        tournament_id: e.tournament_id,
        not_before: new Date(fromZonedInput(d.start, t.time_zone)).toISOString(),
        pool_match_minutes: Math.max(5, Number(d.poolMinutes) || 15),
        bracket_match_minutes: Math.max(5, Number(d.bracketMinutes) || 20),
        gold_match_minutes: Math.max(5, Number(d.goldMinutes) || 20),
        bronze_match_minutes: Math.max(5, Number(d.bronzeMinutes) || 20),
      });
    }
    // Queue order comes from start times and match lengths.
    if (scheduled) await rebuildQueue(id);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-4xl">Planner</h2>
          <p className="max-w-prose text-muted">
            Set when each division starts and how long its matches take, and try formats with Format. Every match is laid
            onto the courts the way the queue will run them, so you can see when divisions finish and whether anyone waits
            for a court.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Field label="Courts">
            <Input className="w-20" type="number" min={1} value={s.courts} onChange={(e) => setSettings({ ...s, courts: e.target.value })} />
          </Field>
          <Field label="Closes">
            <Input className="w-32" type="time" value={s.closes} onChange={(e) => setSettings({ ...s, closes: e.target.value })} />
          </Field>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Matches" value={plan.matches.filter((m) => !m.optional).length} />
        <Tile label="First match" value={formatTime(new Date(plan.start).toISOString(), t.time_zone)} />
        <Tile
          label="Last match ends"
          value={formatTime(new Date(plan.end).toISOString(), t.time_zone)}
          tone={plan.end > closesAt(plan.end) ? 'text-late' : ''}
        />
        <Tile label="Courts busy" value={`${usage}%`} />
      </dl>

      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="tnum w-full min-w-[70rem] text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left text-xs text-muted">
              <th className="px-3 py-2 font-semibold">Division</th>
              <th className="px-2 py-2 font-semibold">Starts</th>
              <th className="px-2 py-2 font-semibold">Teams</th>
              <th className="px-2 py-2 font-semibold" title="Minutes per pool match, changeover included">Pool min</th>
              <th className="px-2 py-2 font-semibold" title="Minutes per bracket match, changeover included">Bracket min</th>
              <th className="px-2 py-2 font-semibold" title="Minutes for the gold match (the final), changeover included">Gold min</th>
              <th className="px-2 py-2 font-semibold" title="Minutes for the bronze match, changeover included">Bronze min</th>
              <th className="px-2 py-2 text-right font-semibold">Matches</th>
              <th className="px-2 py-2 font-semibold">First match</th>
              <th className="px-2 py-2 font-semibold">Pools done</th>
              <th className="px-3 py-2 font-semibold">Done by</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const d = draftOf(e);
              const f = formatOf(d);
              const p = plan.divisions.find((x) => x.id === e.id)!;
              const late = p.end !== null && p.end > closesAt(p.end);
              const isOpen = open === e.id;
              return (
                <Fragment key={e.id}>
                  <tr className={`border-b border-border ${isOpen ? 'bg-surface-2' : ''}`}>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2 font-semibold">
                        <span className="h-3.5 w-3.5 shrink-0 rounded-sm" style={{ background: color.get(e.id) }} aria-hidden />
                        {e.name}
                      </span>
                      <span className="mt-1 flex items-center gap-2">
                        <span className="text-xs text-muted">{formatSummary(f)}</span>
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-controls={`format-${e.id}`}
                          onClick={() => setOpen(isOpen ? null : e.id)}
                          className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-xs font-medium hover:border-text"
                        >
                          {isOpen ? 'Close' : 'Format'}
                        </button>
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <Input type="datetime-local" className="h-10 w-52" value={d.start} onChange={(ev) => setDraft(e, { start: ev.target.value })} />
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        type="number"
                        min={2}
                        className="h-10 w-20"
                        value={d.teams}
                        title={activeTeams(e.id) ? `${activeTeams(e.id)} entered` : 'Expected teams'}
                        onChange={(ev) => setDraft(e, { teams: ev.target.value })}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <Input type="number" min={5} className="h-10 w-20" value={d.poolMinutes} disabled={f.format === 'single_elim'} onChange={(ev) => setDraft(e, { poolMinutes: ev.target.value })} />
                    </td>
                    <td className="px-2 py-2">
                      <Input type="number" min={5} className="h-10 w-20" value={d.bracketMinutes} disabled={f.format === 'round_robin'} onChange={(ev) => setDraft(e, { bracketMinutes: ev.target.value })} />
                    </td>
                    <td className="px-2 py-2">
                      <Input type="number" min={5} className="h-10 w-20" aria-label={`${e.name} gold match minutes`} value={medalMatches(f).gold ? d.goldMinutes : ''} placeholder="—" disabled={!medalMatches(f).gold} onChange={(ev) => setDraft(e, { goldMinutes: ev.target.value })} />
                    </td>
                    <td className="px-2 py-2">
                      <Input type="number" min={5} className="h-10 w-20" aria-label={`${e.name} bronze match minutes`} value={medalMatches(f).bronze ? d.bronzeMinutes : ''} placeholder="—" disabled={!medalMatches(f).bronze} onChange={(ev) => setDraft(e, { bronzeMinutes: ev.target.value })} />
                    </td>
                    <td className="px-2 py-2 text-right">{p.matches}</td>
                    <td className="px-2 py-2">
                      {p.firstStart ? formatTime(new Date(p.firstStart).toISOString(), t.time_zone) : '—'}
                      {p.startDelayMinutes > 10 && (
                        <span className="mt-0.5 block">
                          <Badge tone="called">Waits {p.startDelayMinutes} min</Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2">{p.poolsEnd ? formatTime(new Date(p.poolsEnd).toISOString(), t.time_zone) : '—'}</td>
                    <td className={`px-3 py-2 font-semibold ${late ? 'text-late' : ''}`}>
                      {p.end ? formatTime(new Date(p.end).toISOString(), t.time_zone) : '—'}
                      {late && <span className="block text-xs font-normal">after closing</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr id={`format-${e.id}`} className="border-b border-border bg-surface-2">
                      <td colSpan={11} className="px-3 pb-4">
                        <FormatSettings
                          draft={d}
                          teams={Math.max(0, Number(d.teams) || 0)}
                          scheduled={scheduledEvent(e.id)}
                          seeded={!!e.playoffs_seeded_at}
                          plan={plan}
                          divisionId={e.id}
                          timeZone={t.time_zone}
                          onChange={(patch) => setDraft(e, patch)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={!changed || save.busy}
          onClick={() => {
            if (scheduled && !confirm('Saving puts the queue back in schedule order with these times. Any matches you moved by hand go back to their places. Save?')) return;
            save.run(saveAll, () => (setDrafts({}), setSaved(true), reload()));
          }}
        >
          Save to divisions
        </Button>
        {changed && (
          <Button variant="ghost" onClick={() => setDrafts({})}>
            Undo changes
          </Button>
        )}
        {saved && <span className="text-live">Saved. The queue now uses these times.</span>}
        <ErrorText>{save.error}</ErrorText>
      </div>

      <PublishTimes tournament={t} events={events} unsaved={changed} onChanged={reload} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-3xl">Courts</h3>
          {days.length > 1 && (
            <div className="flex gap-1 rounded-lg bg-surface-2 p-1" role="tablist">
              {days.map((dk) => (
                <button
                  key={dk}
                  role="tab"
                  aria-selected={dk === shownDay}
                  onClick={() => setDay(dk)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${dk === shownDay ? 'bg-surface shadow-sm' : 'text-muted'}`}
                >
                  {new Date(`${dk}T12:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </button>
              ))}
            </div>
          )}
        </div>
        {shownDay && (
          <Timeline
            plan={plan}
            day={shownDay}
            dayKey={dayKey}
            courts={Math.max(1, Number(s.courts) || 1)}
            color={color}
            timeZone={t.time_zone}
            closes={closesAt(fromZonedInput(`${shownDay}T12:00`, t.time_zone))}
            events={events}
          />
        )}
        <p className="text-sm text-muted">
          A plan, not a promise: players entered in two divisions, no-shows and long games add waits. Bracket times assume
          pool play ends on schedule; a striped block is a final that may not be needed.
        </p>
      </section>
    </div>
  );
}

/** "A3" for Pool A round 3, "SF1", "QF2", "W1", "L3", "GF"…: fits a 15-minute block. */
function shortLabel(label: string) {
  return label
    .replace(/^Pool (\w) · Round (\d+)$/, '$1$2')
    .replace(/^Round (\d+)$/, 'R$1')
    .replace(/^Semifinal (\d+)$/, 'SF$1')
    .replace(/^Quarterfinal (\d+)$/, 'QF$1')
    .replace(/^Round of \d+ #(\d+)$/, 'E$1')
    .replace(/^Winners R(\d+) #\d+$/, 'W$1')
    .replace(/^Losers R(\d+) #\d+$/, 'L$1')
    .replace(/^Winners Final$/, 'WF')
    .replace(/^Losers Final$/, 'LF')
    .replace(/^Grand Final \(if needed\)$/, 'GF2')
    .replace(/^Grand Final$/, 'GF');
}

/**
 * Division start times stay hidden from players until the director publishes
 * them, usually close to the tournament once the plan is final.
 */
function PublishTimes({
  tournament: t,
  events,
  unsaved,
  onChanged,
}: {
  tournament: { id: string; time_zone: string; times_published_at: string | null };
  events: TournamentEvent[];
  unsaved: boolean;
  onChanged: () => void;
}) {
  const action = useAction();
  const published = !!t.times_published_at;
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: t.time_zone });
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-3xl">Start times players see</h3>
        <Badge tone={published ? 'live' : 'neutral'}>
          {published ? `Published ${day(t.times_published_at!)}` : 'Not published: hidden from players'}
        </Badge>
      </div>
      <p className="text-sm text-muted">
        These are the saved start times. Players see them on the tournament page and sign-up form once you publish.
        {published ? ' Changes you save show to players right away.' : ''}
      </p>
      <ul className="grid gap-1 sm:grid-cols-2">
        {events.map((e) => (
          <li key={e.id} className="flex justify-between gap-3 rounded-lg bg-surface px-3 py-2">
            <span className="font-medium">{e.name}</span>
            <span className="tnum">{e.not_before ? `${day(e.not_before)} · ${formatTime(e.not_before, t.time_zone)}` : 'Not set'}</span>
          </li>
        ))}
      </ul>
      {unsaved && <p className="text-sm text-called">You have unsaved changes above. Save them first to publish those times.</p>}
      <div className="flex flex-wrap gap-2">
        {published ? (
          <Button disabled={action.busy} onClick={() => action.run(() => updateTournament(t.id, { times_published_at: null }), onChanged)}>
            Hide from players
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={action.busy || events.some((e) => !e.not_before)}
            onClick={() =>
              confirm('Show these start times to players?') &&
              action.run(() => updateTournament(t.id, { times_published_at: new Date().toISOString() }), onChanged)
            }
          >
            Publish start times
          </Button>
        )}
        {!published && events.some((e) => !e.not_before) && (
          <span className="self-center text-sm text-muted">Every division needs a saved start time first.</span>
        )}
      </div>
      <ErrorText>{action.error}</ErrorText>
    </Card>
  );
}

/**
 * A division's format, for trying options against the plan: the timeline and
 * finish times update as it changes. Set once the schedule is built, except
 * the bracket size until the bracket is seeded (as in Setup).
 */
function FormatSettings({
  draft: d,
  teams,
  scheduled,
  seeded,
  plan,
  divisionId,
  timeZone,
  onChange,
}: {
  draft: Draft;
  teams: number;
  scheduled: boolean;
  seeded: boolean;
  plan: Plan;
  divisionId: string;
  timeZone: string;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const f = formatOf(d);
  const hasPools = f.format !== 'single_elim';
  const hasBracket = f.format !== 'round_robin';
  const swiss = f.pool_play === 'swiss';
  const time = (ms: number) => formatTime(new Date(ms).toISOString(), timeZone);
  const stage = (s: 'pool' | 'bracket') => {
    const ms = plan.matches.filter((m) => m.divisionId === divisionId && m.stage === s && !m.optional);
    return ms.length ? `${ms.length} matches, done by ${time(Math.max(...ms.map((m) => m.end)))}` : null;
  };
  const smallest = Math.floor(teams / f.pool_count);
  const pools =
    f.pool_count === 1
      ? `One pool of ${teams}`
      : `${f.pool_count} pools of ${teams % f.pool_count ? `${smallest}–${smallest + 1}` : smallest}`;
  const poolPlay = stage('pool');
  const bracket = stage('bracket');
  const problems = [
    hasPools && !swiss && smallest < 2 && 'Some pools would have fewer than 2 teams.',
    hasPools && swiss && !f.max_rounds && 'Set how many Swiss rounds.',
    f.bracket_size !== null && f.bracket_size > teams && `Only ${teams} teams: the bracket is planned with ${teams}.`,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-3">
      {scheduled && (
        <p className="text-sm text-muted">
          The schedule is built, so the format is set{f.format === 'pools_to_bracket' && !seeded ? ' (the bracket size can still change)' : ''}. Clear
          the schedule in Settings to change it.
        </p>
      )}
      <div className="flex flex-wrap items-start gap-3">
        <Field label="Format">
          <Select
            className="h-10"
            value={d.format}
            disabled={scheduled}
            onChange={(ev) => {
              const format = ev.target.value as EventFormat;
              // Medal matches only follow pool play.
              onChange({ format, bracketType: format !== 'pools_to_bracket' && d.bracketType === 'medal' ? 'single' : d.bracketType });
            }}
          >
            <option value="pools_to_bracket">Pool play, then bracket</option>
            <option value="round_robin">Pool play only</option>
            <option value="single_elim">Bracket only</option>
          </Select>
        </Field>
        {hasPools && (
          <Field label="Pool play">
            <Select
              className="h-10"
              value={d.poolPlay}
              disabled={scheduled}
              onChange={(ev) => {
                const poolPlay = ev.target.value as PoolPlay;
                // Swiss needs a round count; a round robin goes back to everyone playing everyone.
                onChange({ poolPlay, maxRounds: poolPlay === 'swiss' ? d.maxRounds || '4' : '' });
              }}
            >
              <option value="round_robin">Round robin</option>
              <option value="swiss">Swiss rounds</option>
            </Select>
          </Field>
        )}
        {hasPools && !swiss && (
          <Field label="Pools">
            <Input type="number" min={1} max={26} className="h-10 w-20" value={d.pools} disabled={scheduled} onChange={(ev) => onChange({ pools: ev.target.value })} />
          </Field>
        )}
        {hasPools && (
          <Field label={swiss ? 'Swiss rounds' : 'Max rounds'}>
            <Input
              type="number"
              min={1}
              className="h-10 w-28"
              placeholder={swiss ? 'e.g. 4' : 'All'}
              value={d.maxRounds}
              disabled={scheduled}
              onChange={(ev) => onChange({ maxRounds: ev.target.value })}
            />
          </Field>
        )}
        {f.format === 'pools_to_bracket' && (
          <Field label="Teams in the bracket">
            <Input type="number" min={2} className="h-10 w-20" value={d.bracketSize} disabled={seeded} onChange={(ev) => onChange({ bracketSize: ev.target.value })} />
          </Field>
        )}
        {hasBracket && (
          <Field label="Elimination">
            <Select
              className="h-10"
              value={d.bracketType}
              disabled={scheduled}
              onChange={(ev) => {
                const bracketType = ev.target.value as BracketType;
                // Medal matches are 1 v 2 for gold and 3 v 4 for bronze.
                onChange({ bracketType, bracketSize: bracketType === 'medal' && d.bracketSize !== '2' ? '4' : d.bracketSize });
              }}
            >
              <option value="single">Single elimination</option>
              <option value="double">Double elimination</option>
              {f.format === 'pools_to_bracket' && <option value="medal">Straight to medal matches</option>}
            </Select>
          </Field>
        )}
        {hasBracket && d.bracketType === 'single' && (
          <Check label="Bronze match" checked={d.thirdPlace} disabled={scheduled} onChange={(thirdPlace) => onChange({ thirdPlace })} />
        )}
        {hasBracket && d.bracketType === 'double' && (
          <Check label="Reset final" checked={d.gfReset} disabled={scheduled} onChange={(gfReset) => onChange({ gfReset })} />
        )}
      </div>
      <p className="text-sm">
        {[
          `${teams} teams`,
          hasPools && (swiss ? `${f.max_rounds ?? '?'} Swiss rounds` : pools),
          poolPlay && `Pool play: ${poolPlay}`,
          f.format === 'pools_to_bracket' && f.bracket_type !== 'medal' && advanceRule(f.pool_count, Math.min(f.bracket_size!, teams)).replace(/\.$/, ''),
          bracket && `Bracket: ${bracket}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {problems.map((p) => (
        <p key={p as string} className="text-sm text-late">
          {p}
        </p>
      ))}
    </div>
  );
}

function Tile({ label, value, tone = '' }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-2xl bg-surface-2 p-3">
      <dt className="text-xs font-semibold tracking-widest text-muted uppercase">{label}</dt>
      <dd className={`tnum mt-1 font-display text-3xl leading-none font-bold ${tone}`}>{value}</dd>
    </div>
  );
}

/** One row per court; each match a block, colored by division. */
function Timeline({
  plan,
  day,
  dayKey,
  courts,
  color,
  timeZone,
  closes,
  events,
}: {
  plan: Plan;
  day: string;
  dayKey: (ms: number) => string;
  courts: number;
  color: Map<string, string>;
  timeZone: string;
  closes: number;
  events: TournamentEvent[];
}) {
  const ms = plan.matches.filter((m) => dayKey(m.start) === day);
  if (ms.length === 0) return <Empty>No matches this day.</Empty>;
  const hour = 60 * MIN;
  const from = Math.floor(Math.min(...ms.map((m) => m.start)) / hour) * hour;
  const to = Math.ceil(Math.max(...ms.map((m) => m.end), from + hour) / hour) * hour;
  const ppm = 3; // pixels per minute
  const width = ((to - from) / MIN) * ppm;
  const x = (t: number) => ((t - from) / MIN) * ppm;
  const name = new Map(events.map((e) => [e.id, e.name]));
  const ticks = Array.from({ length: (to - from) / (30 * MIN) + 1 }, (_, i) => from + i * 30 * MIN);

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-sm">
        {events.map((e) => (
          <span key={e.id} className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm" style={{ background: color.get(e.id) }} aria-hidden />
            {e.name}
          </span>
        ))}
      </div>
      <div className="flex">
        <div className="shrink-0 border-r border-border bg-surface-2">
          <div className="h-8" />
          {Array.from({ length: courts }, (_, i) => (
            <div key={i} className="flex h-11 items-center px-3 font-display text-lg font-bold whitespace-nowrap uppercase">
              Court {i + 1}
            </div>
          ))}
        </div>
        <div className="overflow-x-auto">
          <div className="relative" style={{ width }}>
            <div className="relative h-8 border-b border-border">
              {ticks.map((t) => (
                <span
                  key={t}
                  className={`absolute top-1.5 text-xs whitespace-nowrap text-muted ${t === from ? 'pl-1' : '-translate-x-1/2'}`}
                  style={{ left: x(t) }}
                >
                  {(t - from) % hour === 0 ? formatTime(new Date(t).toISOString(), timeZone) : ''}
                </span>
              ))}
            </div>
            {ticks.map((t) => (
              <span
                key={`line-${t}`}
                className={`absolute top-8 bottom-0 w-px ${(t - from) % hour === 0 ? 'bg-border' : 'bg-border/50'}`}
                style={{ left: x(t) }}
                aria-hidden
              />
            ))}
            {closes > from && closes < to && (
              <span className="absolute top-8 bottom-0 w-0.5 bg-late" style={{ left: x(closes) }} title="Closing time" aria-hidden />
            )}
            {Array.from({ length: courts }, (_, i) => (
              <div key={i} className="relative h-11 border-b border-border/60 last:border-0">
                {ms
                  .filter((m) => m.court === i + 1)
                  .map((m) => {
                    const w = x(m.end) - x(m.start) - 2;
                    return (
                      <div
                        key={m.id}
                        className="absolute top-1 bottom-1 overflow-hidden rounded-md px-1.5 text-xs leading-9 font-semibold whitespace-nowrap text-white"
                        style={{
                          left: x(m.start) + 1,
                          width: w,
                          background: m.optional
                            ? `repeating-linear-gradient(135deg, ${color.get(m.divisionId)}, ${color.get(m.divisionId)} 6px, transparent 6px, transparent 10px)`
                            : color.get(m.divisionId),
                          color: m.optional ? 'var(--text)' : undefined,
                        }}
                        title={`${name.get(m.divisionId)} · ${m.label} · ${formatTime(new Date(m.start).toISOString(), timeZone)}–${formatTime(new Date(m.end).toISOString(), timeZone)}`}
                      >
                        {w > 22 ? shortLabel(m.label) : ''}
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
