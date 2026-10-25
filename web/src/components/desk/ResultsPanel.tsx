'use client';

import { formatScore, formatTime } from '@/lib/format';
import type { MatchDetails } from '@/lib/types';
import { Button, Empty } from '../ui';

export function ResultsPanel({
  matches,
  timeZone,
  staff,
  onCorrect,
}: {
  matches: MatchDetails[];
  timeZone: string;
  staff: boolean;
  onCorrect: (m: MatchDetails) => void;
}) {
  const done = matches
    .filter((m) => m.status === 'completed' && !m.is_bye)
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
    .slice(0, 60);
  if (done.length === 0) return <Empty>No results yet.</Empty>;

  return (
    <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
      {done.map((m) => {
        const won1 = m.winner_team_id === m.team1_id;
        return (
          <li key={m.id} className="flex items-start gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-muted">
                {formatTime(m.completed_at, timeZone)} · {m.event_name} · {m.label}
                {m.court_name ? ` · ${m.court_name}` : ''}
              </p>
              <p className="text-sm">
                <span className={won1 ? 'font-semibold' : 'text-muted'}>{m.team1_name}</span>
                <span className="text-muted"> v </span>
                <span className={!won1 ? 'font-semibold' : 'text-muted'}>{m.team2_name}</span>
              </p>
              <p className="tnum text-sm">{formatScore(m)}</p>
            </div>
            {staff && (
              <Button size="sm" variant="ghost" onClick={() => onCorrect(m)}>
                Fix
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
