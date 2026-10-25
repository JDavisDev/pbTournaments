'use client';

// The front desk before play: players check in as they arrive, and each
// division shows how close it is to ready.
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Icon } from '@/components/Icon';
import { Badge, Button, Empty, ErrorText, Input, Spinner } from '@/components/ui';
import { checkInPlayer, getCheckinRoster, getDivisionCheckin } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { useAction, useLiveTournament, useStaffAccess } from '@/lib/hooks';
import type { DivisionCheckin } from '@/lib/types';

async function load(id: string) {
  const [players, divisions] = await Promise.all([getCheckinRoster(id), getDivisionCheckin(id)]);
  return { players, divisions };
}

type Show = 'waiting' | 'here' | 'all';

export function CheckinDesk({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => load(id));
  const [search, setSearch] = useState('');
  const [division, setDivision] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('waiting');
  const action = useAction();

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>The check-in desk is for this tournament’s directors.</Empty>;

  const totalIn = data.players.filter((p) => p.checked_in_at).length;
  const query = search.trim().toLowerCase();
  const list = data.players
    .filter((p) => !division || p.teams.some((t) => t.event_id === division))
    .filter((p) => (query ? `${p.first_name} ${p.last_name} ${p.teams.map((t) => t.team_name).join(' ')}`.toLowerCase().includes(query) : true))
    .filter((p) => query || show === 'all' || (show === 'here' ? p.checked_in_at : !p.checked_in_at));

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-3xl">Divisions</h2>
          <p className="tnum text-muted">
            <span className="font-display text-2xl font-bold text-text">{totalIn}</span> of {data.players.length} players here
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.divisions.map((d) => (
            <DivisionCard
              key={d.event_id}
              d={d}
              active={division === d.event_id}
              onClick={() => setDivision(division === d.event_id ? null : d.event_id)}
            />
          ))}
        </div>
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
        {division && (
          <p className="text-sm text-muted">
            Showing {data.divisions.find((d) => d.event_id === division)?.event_name}.{' '}
            <button className="underline" onClick={() => setDivision(null)}>
              Show all divisions
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
                    <span className="hidden items-center gap-1 text-sm text-live sm:inline-flex"><Icon name="check" className="h-4 w-4" /> {formatTime(p.checked_in_at)}</span>
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

function DivisionCard({ d, active, onClick }: { d: DivisionCheckin; active: boolean; onClick: () => void }) {
  const pct = d.players ? Math.round((d.players_in / d.players) * 100) : 0;
  const ready = d.teams > 0 && d.teams_ready === d.teams;
  return (
    <button
      onClick={onClick}
      className={`rounded-2xl p-4 text-left transition ${active ? 'bg-accent text-accent-text' : 'bg-surface-2 hover:bg-accent-soft'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xl">{d.event_name}</h3>
        {ready ? (
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
        {d.teams_ready} of {d.teams} teams ready{d.not_before ? ` · starts ${formatTime(d.not_before)}` : ''}
      </p>
    </button>
  );
}
