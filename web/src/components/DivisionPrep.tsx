'use client';

import { Button, Card, ErrorText } from '@/components/ui';
import { clearMatches, generateMatches } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { MatchDetails, Team, TournamentEvent } from '@/lib/types';

/**
 * Before a division starts, for directors: the two setup stages.
 *  1. Teams: teams and format can change; the schedule is only a preview.
 *  2. Order of play: the schedule is built (generate_matches) from the teams
 *     entered then, and the director can reorder its matches before starting.
 *     Unlocking (clear_matches) goes back to stage 1.
 * Starting the division (StartDivision) works from either stage.
 */
export function DivisionPrep({
  event,
  teams,
  matches,
  onEditOrder,
  onChanged,
}: {
  event: TournamentEvent;
  /** Entered teams, not withdrawn. */
  teams: Team[];
  matches: Pick<MatchDetails, 'team1_id' | 'team2_id'>[];
  onEditOrder: () => void;
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  const built = matches.length > 0;

  if (!built) {
    return (
      <Card className="flex flex-col gap-3 p-4">
        <div>
          <p className="text-sm font-semibold tracking-widest text-muted uppercase">Step 1 of 3 · Teams</p>
          <p className="mt-1 font-semibold">Teams and format can still change</p>
          <p className="text-muted">
            The schedule below is a preview. When your teams are final, build the schedule to set the order of play. After the division starts you can still reorder any match that hasn’t gone on court.
          </p>
        </div>
        <Button
          variant="primary"
          className="self-start"
          disabled={busy || teams.length < 2}
          title={teams.length < 2 ? 'A division needs at least 2 teams' : undefined}
          onClick={() => run(() => generateMatches(event.id), onChanged)}
        >
          {busy ? 'Building…' : 'Teams are final: build schedule'}
        </Button>
        <ErrorText>{error}</ErrorText>
      </Card>
    );
  }

  // Teams entered after the build (e.g. late registrations) aren't in it.
  const inSchedule = new Set(matches.flatMap((m) => [m.team1_id, m.team2_id]));
  const missing = teams.filter((t) => (event.format === 'single_elim' ? !inSchedule.has(t.id) : t.pool === null));

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div>
        <p className="text-sm font-semibold tracking-widest text-muted uppercase">Step 2 of 3 · Order of play</p>
        <p className="mt-1 font-semibold">The schedule is built. Set the order of play.</p>
        <p className="text-muted">
          Once the division starts, matches go on court from the top of the order down. Use the arrows to move matches, or hold one to skip it for now. This isn’t final: during play you can keep reordering any match that hasn’t gone on court. Teams and format are locked while the schedule is built.
        </p>
      </div>
      {missing.length > 0 && (
        <p className="text-sm text-late">
          <strong>Not in the schedule:</strong> {missing.map((t) => t.name).join(', ')}.{' '}
          {missing.length === 1 ? 'This team was' : 'These teams were'} added after it was built. Unlock and build it again to
          include {missing.length === 1 ? 'them' : 'them all'}.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onEditOrder}>
          Edit order of play
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            confirm(
              'Unlock teams and format? The schedule is cleared, along with any changes to the order. Build it again when the teams are final.',
            ) && run(() => clearMatches(event.id), onChanged)
          }
        >
          Unlock teams and format
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
