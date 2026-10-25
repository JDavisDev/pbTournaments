'use client';

import { Icon } from '../Icon';
import { useState } from 'react';
import { checkInTeam } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Team, TournamentEvent } from '@/lib/types';
import { Button, Empty, ErrorText, Input } from '../ui';

export function CheckInPanel({
  teams,
  events,
  onChanged,
}: {
  teams: Team[];
  events: TournamentEvent[];
  onChanged: () => void;
}) {
  const [search, setSearch] = useState('');
  const { busy, error, run } = useAction();
  const active = teams.filter((t) => !t.withdrawn_at);
  const waiting = active.filter((t) => !t.checked_in_at).length;
  const filtered = active
    .filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(!!a.checked_in_at) - Number(!!b.checked_in_at) || a.name.localeCompare(b.name));
  const eventName = (id: string) => events.find((e) => e.id === id)?.name ?? '';

  if (active.length === 0) return <Empty>No teams yet. Add them in Setup.</Empty>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          placeholder="Search teams"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="text-sm whitespace-nowrap text-muted">{waiting} not in</span>
      </div>
      <ErrorText>{error}</ErrorText>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
        {filtered.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{t.name}</p>
              <p className="truncate text-xs text-muted">{eventName(t.event_id)}</p>
            </div>
            {t.checked_in_at ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => checkInTeam(t.id, false), onChanged)}>
                <Icon name="check" className="h-4 w-4" /> In · undo
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => checkInTeam(t.id), onChanged)}>
                Check in
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
