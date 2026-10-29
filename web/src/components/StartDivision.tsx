'use client';

import { Icon } from '@/components/Icon';
import { Button, Card, ErrorText } from '@/components/ui';
import { startEvent } from '@/lib/api';
import { formatTime, toZonedInput } from '@/lib/format';
import { useAction, useNow } from '@/lib/hooks';
import { dayHeading } from './DivisionStatus';

/**
 * The director's "Start division" button, with what happens to teams that
 * aren't checked in yet (see start_event).
 */
export function StartDivision({
  eventId,
  eventName,
  teams,
  teamsReady,
  graceMinutes,
  scheduledFor = null,
  timeZone,
  onStarted,
}: {
  eventId: string;
  eventName: string;
  teams: number;
  teamsReady: number;
  /** tournaments.checkin_grace_minutes: null = nobody forfeits automatically. */
  graceMinutes: number | null;
  /** events.not_before: starting before it is fine, and play begins right away. */
  scheduledFor?: string | null;
  timeZone: string;
  onStarted: () => void;
}) {
  const { busy, error, run } = useAction();
  const now = useNow(60_000);
  const early =
    scheduledFor && new Date(scheduledFor).getTime() > now
      ? `It’s scheduled for ${dayHeading(toZonedInput(scheduledFor, timeZone).slice(0, 10))}, ${formatTime(scheduledFor, timeZone)}; starting now puts its matches on court right away.`
      : '';
  const missing = teams - teamsReady;
  const late =
    missing === 0
      ? ''
      : `The ${missing === 1 ? 'team' : `${missing} teams`} not here ${missing === 1 ? 'sits' : 'sit'} out round 1 where pool play has a sit-out, and get${missing === 1 ? 's' : ''} a text. ` +
        (graceMinutes === null
          ? 'Nobody forfeits automatically.'
          : `${missing === 1 ? 'It has' : 'They have'} ${graceMinutes} minutes to check in or ${missing === 1 ? 'it forfeits its' : 'they forfeit their'} matches.`);
  return (
    <Card className="flex flex-col gap-3 border-2 border-called p-4">
      <div>
        <p className="font-semibold">{eventName} hasn’t started</p>
        <p className="text-muted">
          No matches go on court until you start it. {teamsReady} of {teams} teams are checked in. {late}
        </p>
        {early && <p className="mt-1 text-sm text-called">{early}</p>}
      </div>
      <Button
        variant="primary"
        className="self-start"
        disabled={busy}
        onClick={() => {
          if (confirm(`Start ${eventName} now?${early ? `\n\n${early}` : ''}${late ? `\n\n${late}` : ''}`)) run(() => startEvent(eventId), onStarted);
        }}
      >
        <Icon name="play" /> {busy ? 'Starting…' : 'Start division'}
      </Button>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
