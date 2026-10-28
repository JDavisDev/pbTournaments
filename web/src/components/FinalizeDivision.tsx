'use client';

// After the last match: the director reviews the division's results, fixes
// any score, and marks them final. Final results lock and can go to DUPR.
import { useState } from 'react';
import { DivisionDupr } from '@/components/DivisionDupr';
import { Icon } from '@/components/Icon';
import { ResultsPanel } from '@/components/desk/ResultsPanel';
import { ScoreDialog, type ScoreTarget } from '@/components/desk/ScoreDialog';
import { Button, Card, ErrorText } from '@/components/ui';
import { finalizeEvent, getDuprResults, reopenEvent } from '@/lib/api';
import { formatDate, formatTime, toZonedInput } from '@/lib/format';
import { useAction, useLoad } from '@/lib/hooks';
import { rulesOf } from '@/lib/scoring';
import type { MatchDetails, Tournament, TournamentEvent } from '@/lib/types';

export function FinalizeDivision({
  tournament,
  event,
  matches,
  onChanged,
}: {
  tournament: Tournament;
  event: TournamentEvent;
  matches: MatchDetails[];
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  const [score, setScore] = useState<ScoreTarget | null>(null);
  const [reviewing, setReviewing] = useState(false);

  if (event.finalized_at) {
    const at = event.finalized_at;
    return (
      <section className="flex flex-col gap-3">
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p>
            <Icon name="check" className="mr-1 inline h-5 w-5 text-live" />
            <strong>Results are final</strong>
            <span className="text-muted">
              {' '}
              since {formatDate(toZonedInput(at, tournament.time_zone).slice(0, 10))}, {formatTime(at, tournament.time_zone)}.
              Scores are locked.
            </span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              confirm(`Reopen ${event.name} to change a result? Finalize it again when you’re done.`) &&
              run(() => reopenEvent(event.id), onChanged)
            }
          >
            Reopen
          </Button>
        </Card>
        <ErrorText>{error}</ErrorText>
        {event.dupr_rated && <DuprForDivision tournament={tournament} event={event} />}
      </section>
    );
  }

  return (
    <Card className="flex flex-col gap-3 border-2 border-info p-4">
      <div>
        <p className="font-semibold">Every match is played. Review the results, then make them final.</p>
        <p className="text-muted">
          Check the scores and fix any that are wrong. Final results are locked
          {event.dupr_rated ? ' and can be sent to DUPR' : ''}.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => run(() => finalizeEvent(event.id), onChanged)}>
          <Icon name="check" /> Results are right: finalize
        </Button>
        <Button variant="ghost" onClick={() => setReviewing(!reviewing)}>
          {reviewing ? 'Hide scores' : 'Review scores'}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {reviewing && (
        <ResultsPanel
          matches={matches}
          timeZone={tournament.time_zone}
          staff
          onCorrect={(m) =>
            setScore({
              matchId: m.id,
              team1: m.team1_name,
              team2: m.team2_name,
              rules: rulesOf(m),
              games: m.games,
              mode: 'correct',
            })
          }
        />
      )}
      <ScoreDialog target={score} onClose={() => setScore(null)} onDone={onChanged} />
    </Card>
  );
}

function DuprForDivision({ tournament, event }: { tournament: Tournament; event: TournamentEvent }) {
  const results = useLoad(() => getDuprResults(tournament.id), [tournament.id, event.finalized_at]);
  if (!results.data) return null;
  return (
    <DivisionDupr
      tournament={tournament}
      event={event}
      rows={results.data.filter((r) => r.event_id === event.id)}
      showName={false}
      onChanged={results.reload}
    />
  );
}
