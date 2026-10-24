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
  getEvents,
  getMatches,
  getTeams,
  getTournament,
  isStaff,
  saveEvent,
  setTournamentStatus,
  updateTournament,
} from '@/lib/api';
import { formatSummary, poolName } from '@/lib/format';
import { useAction, useLiveTournament, useLoad, useSession } from '@/lib/hooks';
import type { EventFormat, MatchDetails, Team, Tournament, TournamentEvent, TournamentStatus } from '@/lib/types';

async function load(id: string) {
  const [tournament, events, teams, matches] = await Promise.all([getTournament(id), getEvents(id), getTeams(id), getMatches(id)]);
  return { tournament, events, teams, matches };
}

export function Setup({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = useSession();
  const staff = useLoad(() => (session ? isStaff(id) : Promise.resolve(false)), [id, session?.user.id]);
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
          <h2 className="text-lg font-semibold">Events</h2>
          {!adding && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add event
            </Button>
          )}
        </div>
        {adding && (
          <Card className="p-4">
            <EventForm tournamentId={id} onDone={() => (setAdding(false), reload())} onCancel={() => setAdding(false)} />
          </Card>
        )}
        {data.events.length === 0 && !adding && <Empty>Add your first event, e.g. “Men’s Doubles 3.5”.</Empty>}
        {data.events.map((e) => (
          <EventCard
            key={e.id}
            event={e}
            teams={data.teams.filter((t) => t.event_id === e.id)}
            matches={data.matches.filter((m) => m.event_id === e.id)}
            onChanged={reload}
          />
        ))}
      </section>

      <aside className="flex flex-col gap-4">
        <StatusCard tournament={data.tournament} onChanged={reload} />
        <SettingsCard key={data.tournament.id} tournament={data.tournament} onChanged={reload} />
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
      <h2 className="mb-3 font-semibold">Status</h2>
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
      <h2 className="mb-3 font-semibold">Settings</h2>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          run(() => updateTournament(tournament.id, form), () => (setSaved(true), onChanged()));
        }}
      >
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Date">
          <Input type="date" value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} />
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

const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function EventForm({
  tournamentId,
  event,
  onDone,
  onCancel,
}: {
  tournamentId: string;
  event?: TournamentEvent;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    name: event?.name ?? '',
    format: event?.format ?? ('pools_to_bracket' as EventFormat),
    pool_count: event?.pool_count ?? 2,
    advance_per_pool: event?.advance_per_pool ?? 2,
    games_to: event?.games_to ?? 11,
    best_of: event?.best_of ?? 1,
    playoff_games_to: event?.playoff_games_to ?? null,
    playoff_best_of: event?.playoff_best_of ?? null,
    not_before: toLocalInput(event?.not_before ?? null),
  });
  const { busy, error, run } = useAction();
  const hasPools = form.format !== 'single_elim';
  const hasBracket = form.format !== 'round_robin';

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () =>
            saveEvent({
              id: event?.id,
              tournament_id: tournamentId,
              ...form,
              pool_count: hasPools ? form.pool_count : 1,
              not_before: form.not_before ? new Date(form.not_before).toISOString() : null,
            }),
          onDone,
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Event name">
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Mixed Doubles 3.5" />
        </Field>
        <Field label="Format">
          <Select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value as EventFormat })}>
            <option value="pools_to_bracket">Pools, then bracket</option>
            <option value="round_robin">Round robin only</option>
            <option value="single_elim">Bracket only</option>
          </Select>
        </Field>
        {hasPools && (
          <Field label="Pools" hint="Teams are snake-seeded into pools">
            <Input type="number" min={1} max={26} value={form.pool_count} onChange={(e) => setForm({ ...form, pool_count: Number(e.target.value) })} />
          </Field>
        )}
        {form.format === 'pools_to_bracket' && (
          <Field label="Advance per pool">
            <Input
              type="number"
              min={1}
              value={form.advance_per_pool}
              onChange={(e) => setForm({ ...form, advance_per_pool: Number(e.target.value) })}
            />
          </Field>
        )}
        <Field label={hasBracket && hasPools ? 'Pool games to' : 'Games to'}>
          <Select value={form.games_to} onChange={(e) => setForm({ ...form, games_to: Number(e.target.value) })}>
            {[11, 15, 21].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </Select>
        </Field>
        <Field label={hasBracket && hasPools ? 'Pool match' : 'Match'}>
          <Select value={form.best_of} onChange={(e) => setForm({ ...form, best_of: Number(e.target.value) })}>
            <option value={1}>1 game</option>
            <option value={3}>Best of 3</option>
          </Select>
        </Field>
        {hasBracket && hasPools && (
          <>
            <Field label="Bracket games to">
              <Select
                value={form.playoff_games_to ?? ''}
                onChange={(e) => setForm({ ...form, playoff_games_to: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Same as pools</option>
                {[11, 15, 21].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </Select>
            </Field>
            <Field label="Bracket match">
              <Select
                value={form.playoff_best_of ?? ''}
                onChange={(e) => setForm({ ...form, playoff_best_of: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Same as pools</option>
                <option value={1}>1 game</option>
                <option value={3}>Best of 3</option>
              </Select>
            </Field>
          </>
        )}
        <Field label="Start time" hint="Optional. Matches won’t be sent out before this.">
          <Input type="datetime-local" value={form.not_before} onChange={(e) => setForm({ ...form, not_before: e.target.value })} />
        </Field>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={busy || !form.name}>
          {event ? 'Save event' : 'Add event'}
        </Button>
      </div>
    </form>
  );
}

function EventCard({
  event,
  teams,
  matches,
  onChanged,
}: {
  event: TournamentEvent;
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
        <EventForm tournamentId={event.tournament_id} event={event} onDone={() => (setEditing(false), onChanged())} onCancel={() => setEditing(false)} />
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{event.name}</h3>
          <p className="text-sm text-muted">
            {formatSummary(event)} · games to {event.games_to}
            {event.best_of === 3 ? ', best of 3' : ''} · {teams.length} teams
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {scheduled ? (
            <Badge tone="live">{matches.length} matches scheduled</Badge>
          ) : (
            <Badge>Not scheduled</Badge>
          )}
          {!scheduled && (
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
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

        {!scheduled && (
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">Add teams</h4>
            <Textarea
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'One team per line, best seed first:\nPat Davis / Sam Lee\nJo Park / Ana Cho'}
            />
            <Button disabled={busy || !text.trim()} onClick={() => run(() => addTeamsFromText(event.id, text, nextSeed), () => (setText(''), onChanged()))}>
              Add teams
            </Button>
          </div>
        )}
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
