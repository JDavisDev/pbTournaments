'use client';

import { Icon } from '../Icon';
import { holdMatch, moveInQueue } from '@/lib/api';
import { courtsLabel, minutesSince } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { QueueRow } from '@/lib/types';
import { MatchTags } from '../MatchTag';
import { Badge, Empty, ErrorText } from '../ui';

/**
 * A queued match is Next up (it goes on the next free court) or Scheduled
 * (waiting its turn: its players are on court or needed by a match above, or
 * its event hasn't started). A championship match can be waiting for a
 * championship court. Directors also see what they can act on.
 */
export function QueueStatus({ row, staff = false }: { row: QueueRow; staff?: boolean }) {
  if (!row.blocked_reason) return <Badge tone="live">Next up</Badge>;
  if (row.blocked_reason === 'waiting_for_championship_court') {
    return (
      <Badge tone="called">
        {row.waiting_for_court ? `Waiting for Main court (${row.waiting_for_court})` : 'Waiting for championship court'}
      </Badge>
    );
  }
  if (staff && row.blocked_reason === 'on_hold') return <Badge tone="called">On hold</Badge>;
  if (staff && row.blocked_reason === 'not_checked_in') return <Badge tone="late">Not checked in</Badge>;
  return <Badge tone="neutral">Scheduled</Badge>;
}

export function QueuePanel({
  queue,
  staff,
  now,
  onChanged,
}: {
  queue: QueueRow[];
  staff: boolean;
  now: number;
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  if (queue.length === 0) return <Empty>The queue is empty.</Empty>;

  const move = (row: QueueRow, before: string | null) => run(() => moveInQueue(row.match_id, before), onChanged);

  return (
    <div className="flex flex-col gap-2">
      <ErrorText>{error}</ErrorText>
      <ol className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
        {queue.map((row, i) => (
          <li key={row.match_id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-3 py-2.5">
            <span className="tnum mt-0.5 w-6 shrink-0 text-right text-sm font-semibold text-muted">{row.queue_rank}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <QueueStatus row={row} staff={staff} />
                {row.overdue && <Badge tone="late">Overdue</Badge>}
                <MatchTags stage={row.stage} roundKey={row.round_key} championship={row.championship} />
                <span className="truncate text-xs text-muted">
                  {row.event_name} · {row.label}
                  {row.court_names.length > 0 && ` · ${courtsLabel(row.court_names)}`}
                </span>
              </div>
              <p className="mt-1 text-sm leading-snug">
                <span className="font-medium">{row.team1_name}</span>
                <span className="text-muted"> v </span>
                <span className="font-medium">{row.team2_name}</span>
              </p>
              {row.waiting_since && !row.blocked_reason && (
                <p className="text-xs text-muted">Waiting {minutesSince(row.waiting_since, now)}m</p>
              )}
              {row.blocked_reason === 'waiting_for_championship_court' && (
                <p className="text-xs text-muted">
                  {row.wait_until
                    ? `Takes the first free court in ${Math.max(0, Math.ceil((new Date(row.wait_until).getTime() - now) / 60_000))} min`
                    : 'Waits for it however long it takes'}
                </p>
              )}
            </div>
            {staff && (
              <div className="flex shrink-0 items-center gap-0.5 max-sm:ml-9 max-sm:w-full max-sm:gap-2">
                <IconButton label="Move to top" disabled={busy || i === 0} onClick={() => move(row, queue[0].match_id)}>
                  <Icon name="top" />
                </IconButton>
                <IconButton label="Move up" disabled={busy || i === 0} onClick={() => move(row, queue[i - 1].match_id)}>
                  <Icon name="up" />
                </IconButton>
                <IconButton
                  label="Move down"
                  disabled={busy || i === queue.length - 1}
                  onClick={() => move(row, queue[i + 2]?.match_id ?? null)}
                >
                  <Icon name="down" />
                </IconButton>
                <IconButton
                  label={row.blocked_reason === 'on_hold' ? 'Release' : 'Hold'}
                  disabled={busy}
                  onClick={() => run(() => holdMatch(row.match_id, row.blocked_reason !== 'on_hold'), onChanged)}
                >
                  <Icon name={row.blocked_reason === 'on_hold' ? 'play' : 'pause'} />
                </IconButton>
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function IconButton({
  label,
  children,
  ...props
}: { label: string; children: React.ReactNode } & React.ComponentProps<'button'>) {
  return (
    <button
      title={label}
      aria-label={label}
      className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30 max-sm:h-9 max-sm:w-11 max-sm:border max-sm:border-border"
      {...props}
    >
      {children}
    </button>
  );
}
