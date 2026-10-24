'use client';

import { useState } from 'react';
import { assignMatchToCourt, confirmOnCourt, setCourtPaused } from '@/lib/api';
import { minutesSince } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { CourtBoardRow, QueueRow } from '@/lib/types';
import { Badge, Button, ErrorText, Select } from '../ui';

export type CourtState = 'paused' | 'open' | 'called' | 'late' | 'playing';

export function courtState(c: CourtBoardRow, now: number): CourtState {
  if (!c.match_id) return c.out_of_service ? 'paused' : 'open';
  if (c.match_status === 'in_progress') return 'playing';
  return c.no_show_deadline && now > new Date(c.no_show_deadline).getTime() ? 'late' : 'called';
}

const frame: Record<CourtState, string> = {
  paused: 'border-border bg-surface-2 opacity-70',
  open: 'border-dashed border-border bg-surface',
  called: 'border-called bg-called-soft/40',
  late: 'border-late bg-late-soft/60',
  playing: 'border-live bg-live-soft/40',
};

export function CourtStatus({ court, now }: { court: CourtBoardRow; now: number }) {
  const state = courtState(court, now);
  if (state === 'paused') return <Badge>Paused</Badge>;
  if (state === 'open') return <Badge>Open</Badge>;
  if (state === 'playing') return <Badge tone="live">Playing · {minutesSince(court.started_at, now)}m</Badge>;
  if (state === 'late') return <Badge tone="late">No-show? {minutesSince(court.assigned_at, now)}m</Badge>;
  return <Badge tone="called">Called · {minutesSince(court.assigned_at, now)}m</Badge>;
}

export function CourtCard({
  court,
  now,
  queue,
  staff,
  onScore,
  onMore,
  onChanged,
}: {
  court: CourtBoardRow;
  now: number;
  queue: QueueRow[];
  staff: boolean;
  onScore: () => void;
  onMore: () => void;
  onChanged: () => void;
}) {
  const state = courtState(court, now);
  const { busy, error, run } = useAction();
  const [pick, setPick] = useState('');
  // Matches that can go here now: everything except ones whose players are on court.
  const sendable = queue.filter((q) => q.blocked_reason !== 'player_on_court');

  return (
    <div className={`flex min-h-44 flex-col rounded-xl border-2 p-3 ${frame[state]}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">{court.court_name}</h3>
        <CourtStatus court={court} now={now} />
      </div>

      {court.match_id ? (
        <div className="mt-2 flex-1">
          <p className="truncate text-xs text-muted">
            {court.event_name} · {court.label}
          </p>
          <p className="mt-1 leading-tight font-medium">{court.team1_name}</p>
          <p className="text-xs text-muted">vs</p>
          <p className="leading-tight font-medium">{court.team2_name}</p>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          {state === 'paused' ? 'Not in use' : 'Waiting for the next match'}
        </div>
      )}

      {staff && (
        <div className="mt-3 flex flex-col gap-2">
          {court.match_id ? (
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="primary" onClick={onScore}>
                Score
              </Button>
              {court.match_status === 'assigned' && (
                <Button size="sm" disabled={busy} onClick={() => run(() => confirmOnCourt(court.match_id!), onChanged)}>
                  Players here
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onMore}>
                More…
              </Button>
            </div>
          ) : state === 'paused' ? (
            <Button size="sm" disabled={busy} onClick={() => run(() => setCourtPaused(court.court_id, false), onChanged)}>
              Resume court
            </Button>
          ) : (
            <div className="flex gap-1.5">
              <Select
                className="h-8 min-w-0 flex-1 text-sm"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                aria-label={`Send a match to ${court.court_name}`}
              >
                <option value="">Send a match…</option>
                {sendable.map((q) => (
                  <option key={q.match_id} value={q.match_id}>
                    #{q.queue_rank} {q.team1_name} v {q.team2_name}
                  </option>
                ))}
              </Select>
              {pick ? (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => run(() => assignMatchToCourt(pick, court.court_id), () => (setPick(''), onChanged()))}
                >
                  Send
                </Button>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => run(() => setCourtPaused(court.court_id, true), onChanged)}>
                  Pause
                </Button>
              )}
            </div>
          )}
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </div>
  );
}
