import { formatScore, formatTime } from '@/lib/format';
import type { MatchDetails, QueueRow } from '@/lib/types';
import { QueueStatus } from './desk/QueuePanel';
import { Badge } from './ui';

/** One match with whatever matters for its state: score, court, or place in line. */
export function MatchRow({
  match: m,
  queueRow,
  timeZone,
  perspectiveTeamId,
  showEvent = false,
}: {
  match: MatchDetails;
  queueRow?: QueueRow;
  timeZone: string;
  perspectiveTeamId?: string;
  showEvent?: boolean;
}) {
  const won = perspectiveTeamId && m.winner_team_id ? m.winner_team_id === perspectiveTeamId : null;
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-xs text-muted">
          {showEvent ? `${m.event_name} · ` : ''}
          {m.label}
        </p>
        <p className="text-sm">
          <span className={m.winner_team_id === m.team1_id ? 'font-semibold' : ''}>{m.team1_name}</span>
          <span className="text-muted"> v </span>
          <span className={m.winner_team_id === m.team2_id ? 'font-semibold' : ''}>{m.team2_name}</span>
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-right">
        {m.status === 'completed' ? (
          <>
            {won !== null && <Badge tone={won ? 'live' : 'neutral'}>{won ? 'Won' : 'Lost'}</Badge>}
            <span className="tnum text-sm">{formatScore(m)}</span>
            <span className="text-xs text-muted">{formatTime(m.completed_at, timeZone)}</span>
          </>
        ) : m.status === 'in_progress' ? (
          <Badge tone="live">Playing · {m.court_name}</Badge>
        ) : m.status === 'assigned' ? (
          <Badge tone="called">Go to {m.court_name}</Badge>
        ) : queueRow ? (
          <>
            <span className="text-xs text-muted">#{queueRow.queue_rank} in line</span>
            <QueueStatus row={queueRow} />
          </>
        ) : (
          <Badge>Waiting on earlier results</Badge>
        )}
      </div>
    </div>
  );
}
