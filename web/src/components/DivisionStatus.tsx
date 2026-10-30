import { Icon } from '@/components/Icon';
import { Badge } from '@/components/ui';
import { formatTime, isPlayable, toZonedInput } from '@/lib/format';
import type { MatchDetails, Tournament, TournamentEvent } from '@/lib/types';

export type DivisionState = 'not_started' | 'live' | 'finished' | 'final';

/**
 * Where a division is: started by a director (start_event, which builds its
 * schedule if it isn't built yet), finished once
 * every match is played, final once a director has reviewed the results
 * (finalize_event).
 */
export function divisionState(
  e: Pick<TournamentEvent, 'started_at' | 'finalized_at'>,
  matches: Pick<MatchDetails, 'status' | 'is_bye' | 'team1_bye' | 'team2_bye'>[],
): DivisionState {
  if (e.finalized_at) return 'final';
  if (!e.started_at) return 'not_started';
  const played = matches.filter(isPlayable);
  return played.length > 0 && played.every((m) => m.status === 'completed') ? 'finished' : 'live';
}

/** The day a division plays ('YYYY-MM-DD'): its start time's day, else the tournament's first day. */
export function divisionDay(e: Pick<TournamentEvent, 'not_before'>, t: Pick<Tournament, 'starts_on' | 'time_zone'>) {
  return e.not_before ? toZonedInput(e.not_before, t.time_zone).slice(0, 10) : t.starts_on;
}

/** "Saturday, Nov 7" */
export const dayHeading = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

/** The division's status at a glance: a symbol and a word. */
export function DivisionStatus({ state, startedAt, timeZone }: { state: DivisionState; startedAt?: string | null; timeZone?: string }) {
  if (state === 'live') {
    return (
      <Badge tone="live">
        <span className="mr-1.5 h-2.5 w-2.5 animate-pulse rounded-full bg-current" aria-hidden />
        Live{startedAt ? ` · started ${formatTime(startedAt, timeZone)}` : ''}
      </Badge>
    );
  }
  if (state === 'final') {
    return (
      <Badge>
        <Icon name="check" className="mr-1 h-4 w-4" />
        Final
      </Badge>
    );
  }
  if (state === 'finished') {
    return (
      <Badge tone="info">
        <Icon name="check" className="mr-1 h-4 w-4" />
        Finished
      </Badge>
    );
  }
  return (
    <Badge tone="called">
      <span className="mr-1.5 h-2.5 w-2.5 rounded-full border-2 border-current" aria-hidden />
      Not started
    </Badge>
  );
}
