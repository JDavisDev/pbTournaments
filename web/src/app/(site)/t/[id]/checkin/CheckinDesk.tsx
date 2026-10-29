'use client';

// The front desk before play: players check in as they arrive, and each
// division shows how close it is to ready.
import Link from 'next/link';
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Icon } from '@/components/Icon';
import { dayHeading, divisionDay } from '@/components/DivisionStatus';
import { StartDivision } from '@/components/StartDivision';
import { Badge, Button, Empty, ErrorText, Input, Spinner } from '@/components/ui';
import { checkInPlayer, getCheckinRoster, getDivisionCheckin, getTournament } from '@/lib/api';
import { formatTime, toZonedInput } from '@/lib/format';
import { useAction, useLiveTournament, useNow, useStaffAccess } from '@/lib/hooks';
import type { DivisionCheckin } from '@/lib/types';

async function load(id: string) {
  const [players, divisions, tournament] = await Promise.all([getCheckinRoster(id), getDivisionCheckin(id), getTournament(id)]);
  return { players, divisions, tournament, timeZone: tournament.time_zone, graceMinutes: tournament.checkin_grace_minutes };
}

type Show = 'waiting' | 'here' | 'all';

export function CheckinDesk({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => load(id));
  const [search, setSearch] = useState('');
  const [division, setDivision] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('waiting');
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const action = useAction();
  const now = useNow(60_000);

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.monitor === undefined) return <Spinner />;
  if (!staff.monitor) return <Empty>The check-in desk is for this tournament’s directors and court monitors.</Empty>;

  // One day at a time: today's divisions, or the next day that has some.
  const dayOf = new Map(data.divisions.map((d) => [d.event_id, divisionDay(d, data.tournament)]));
  const days = [...new Set(dayOf.values())].sort();
  const today = toZonedInput(new Date(now).toISOString(), data.timeZone).slice(0, 10);
  const day = pickedDay && days.includes(pickedDay) ? pickedDay : (days.find((d) => d >= today) ?? days.at(-1) ?? today);
  const divisions = data.divisions.filter((d) => dayOf.get(d.event_id) === day);
  const onDay = new Set(divisions.map((d) => d.event_id));
  const players = data.players.filter((p) => p.teams.some((t) => onDay.has(t.event_id)));
  const totalIn = players.filter((p) => p.checked_in_at).length;
  const selected = divisions.find((d) => d.event_id === division);
  const query = search.trim().toLowerCase();
  // A search looks across every day; otherwise the list is the day's (or the division's) players.
  const list = (query ? data.players : players)
    .filter((p) => !selected || p.teams.some((t) => t.event_id === selected.event_id))
    .filter((p) => (query ? `${p.first_name} ${p.last_name} ${p.teams.map((t) => t.team_name).join(' ')}`.toLowerCase().includes(query) : true))
    .filter((p) => query || show === 'all' || (show === 'here' ? p.checked_in_at : !p.checked_in_at));

  return (
    <div className="flex flex-col gap-6">
      <section>
        {days.length > 1 && (
          <div className="mb-4 flex gap-1 overflow-x-auto rounded-full bg-surface-2 p-1" role="tablist" aria-label="Day">
            {days.map((d) => (
              <button
                key={d}
                role="tab"
                aria-selected={d === day}
                onClick={() => (setPickedDay(d), setDivision(null))}
                className={`flex-1 rounded-full px-4 py-2 font-medium whitespace-nowrap ${d === day ? 'bg-accent text-accent-text' : 'text-muted'}`}
              >
                {d === today ? 'Today' : dayHeading(d)}
              </button>
            ))}
          </div>
        )}
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-3xl">{days.length > 1 ? `${day === today ? 'Today’s divisions' : dayHeading(day)}` : 'Divisions'}</h2>
          <p className="tnum text-muted">
            <span className="font-display text-2xl font-bold text-text">{totalIn}</span> of {players.length} players here
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {divisions.map((d) => (
            <DivisionCard
              timeZone={data.timeZone}
              key={d.event_id}
              d={d}
              active={division === d.event_id}
              onClick={() => setDivision(division === d.event_id ? null : d.event_id)}
            />
          ))}
        </div>
        {selected && !selected.started_at && staff.data && (
          <div className="mt-3">
            <StartDivision
              eventId={selected.event_id}
              eventName={selected.event_name}
              teams={selected.teams}
              teamsReady={selected.teams_ready}
              graceMinutes={data.graceMinutes}
              scheduledFor={selected.not_before}
              timeZone={data.timeZone}
              onStarted={reload}
            />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="sticky top-0 z-10 -mx-4 flex flex-col gap-2 bg-bg/95 px-4 py-2 backdrop-blur sm:flex-row sm:items-center">
          <Input
            className="h-12 flex-1 text-lg"
            placeholder="Search a name…"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex gap-1 rounded-full bg-surface-2 p-1">
            {(
              [
                ['waiting', 'Not here'],
                ['here', 'Here'],
                ['all', 'All'],
              ] as [Show, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setShow(key)}
                className={`rounded-full px-4 py-2 text-sm font-medium ${show === key ? 'bg-accent text-accent-text' : 'text-muted'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {selected && (
          <p className="text-sm text-muted">
            Showing {selected.event_name}.{' '}
            <Link href={`/t/${id}/events/${selected.event_id}`} className="underline">
              Open the division
            </Link>{' '}
            ·{' '}
            <button className="underline" onClick={() => setDivision(null)}>
              Show all of {day === today ? 'today' : dayHeading(day)}
            </button>
          </p>
        )}
        <ErrorText>{action.error}</ErrorText>
        {list.length === 0 ? (
          <Empty>{query ? 'No one by that name.' : show === 'waiting' ? 'Everyone is here.' : 'No one yet.'}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
            {list.map((p) => (
              <li key={p.player_id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="font-display text-2xl leading-tight font-bold uppercase">
                    {p.first_name} {p.last_name}
                  </p>
                  <p className="truncate text-sm text-muted">
                    {p.teams.map((t) => `${t.event_name} (${t.team_name})`).join(' · ')}
                  </p>
                </div>
                {p.checked_in_at ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="hidden items-center gap-1 text-sm text-live sm:inline-flex"><Icon name="check" className="h-4 w-4" /> {formatTime(p.checked_in_at, data.timeZone)}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.busy}
                      onClick={() => action.run(() => checkInPlayer(id, p.player_id, false), reload)}
                    >
                      Undo
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="primary"
                    className="h-12 shrink-0 px-7"
                    disabled={action.busy}
                    onClick={() => action.run(() => checkInPlayer(id, p.player_id), reload)}
                  >
                    Check in
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DivisionCard({
  d,
  active,
  timeZone,
  onClick,
}: {
  d: DivisionCheckin;
  active: boolean;
  timeZone: string;
  onClick: () => void;
}) {
  const pct = d.players ? Math.round((d.players_in / d.players) * 100) : 0;
  const ready = d.teams > 0 && d.teams_ready === d.teams;
  return (
    <button
      onClick={onClick}
      className={`rounded-2xl p-4 text-left transition ${active ? 'bg-accent text-accent-text' : 'bg-surface-2 hover:bg-accent-soft'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xl">{d.event_name}</h3>
        {d.started_at ? (
          <Badge tone="live">
            <span className="mr-1.5 h-2.5 w-2.5 rounded-full bg-current" aria-hidden />
            Started {formatTime(d.started_at, timeZone)}
          </Badge>
        ) : ready ? (
          <Badge tone="live">Ready to start</Badge>
        ) : d.teams === 0 ? (
          <Badge>No teams</Badge>
        ) : (
          <Badge tone="called">Waiting on {d.teams - d.teams_ready}</Badge>
        )}
      </div>
      <p className="tnum mt-2">
        <span className="font-display text-4xl font-extrabold">{d.players_in}</span>
        <span className={active ? 'opacity-70' : 'text-muted'}> / {d.players} players</span>
      </p>
      <div className={`mt-2 h-1.5 overflow-hidden rounded-full ${active ? 'bg-accent-text/20' : 'bg-border'}`}>
        <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
      <p className={`mt-2 text-sm ${active ? 'opacity-80' : 'text-muted'}`}>
        {d.teams_ready} of {d.teams} teams ready
        {d.started_at ? '' : d.not_before ? ` · starts ${formatTime(d.not_before, timeZone)}` : ' · not started'}
        {d.no_shows > 0 ? ` · ${d.no_shows} missed check-in` : ''}
      </p>
    </button>
  );
}
