'use client';

import { correctScore, forfeitMatch, reopenMatch, reportScore } from '@/lib/api';
import { correctionNote } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { rulesOf, type ScoringRules } from '@/lib/scoring';
import type { MatchDetails } from '@/lib/types';
import { ScoreEntry } from '../ScoreEntry';
import { Button, ErrorText, Modal } from '../ui';

export interface ScoreTarget {
  matchId: string;
  team1: string;
  team2: string;
  rules: ScoringRules;
  games?: [number, number][] | null;
  mode: 'report' | 'correct';
  /** What saving does beyond the score, e.g. re-seeding the bracket. */
  note?: string;
  /** Correcting: the two teams, for the other ways to change the result. */
  teamIds?: [string, string];
  /** Reporting: opens the match's other actions (move court, back to queue, forfeit). */
  onMore?: () => void;
}

/** A finished match, opened to fix. `matches` are the tournament's, to say what fixing it affects. */
export function correctionTarget(m: MatchDetails, matches: MatchDetails[]): ScoreTarget {
  return {
    matchId: m.id,
    team1: m.team1_name,
    team2: m.team2_name,
    rules: rulesOf(m),
    games: m.games,
    mode: 'correct',
    note: correctionNote(m, matches),
    teamIds: m.team1_id && m.team2_id ? [m.team1_id, m.team2_id] : undefined,
  };
}

export function ScoreDialog({
  target,
  onClose,
  onDone,
}: {
  target: ScoreTarget | null;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Modal open={!!target} onClose={onClose} title={target?.mode === 'correct' ? 'Correct score' : 'Enter score'}>
      {target?.note && <p className="mb-4 rounded-lg bg-info-soft px-3 py-2 text-sm text-info">{target.note}</p>}
      {target && (
        <ScoreEntry
          key={target.matchId}
          team1={target.team1}
          team2={target.team2}
          rules={target.rules}
          initial={target.games}
          confirmLabel={target.mode === 'correct' ? 'Save correction' : 'Confirm score'}
          onCancel={onClose}
          onSubmit={async (games) => {
            await (target.mode === 'correct' ? correctScore : reportScore)(target.matchId, games);
            onDone();
            onClose();
          }}
        />
      )}
      {target?.onMore && (
        <Button variant="ghost" className="mt-4 w-full" onClick={target.onMore}>
          Move court, send back to the queue, or forfeit…
        </Button>
      )}
      {target?.teamIds && <OtherFixes key={target.matchId} target={target} teamIds={target.teamIds} onClose={onClose} onDone={onDone} />}
    </Modal>
  );
}

/** When the match didn't go the way a score can say: it was a forfeit, or it was never really played. */
function OtherFixes({
  target,
  teamIds,
  onClose,
  onDone,
}: {
  target: ScoreTarget;
  teamIds: [string, string];
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, error, run } = useAction();
  const done = () => {
    onDone();
    onClose();
  };
  return (
    <section className="mt-6 flex flex-col gap-2 border-t border-border pt-4">
      <h3 className="text-lg">No score to enter?</h3>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => run(() => forfeitMatch(target.matchId, teamIds[0]), done)}>
          {target.team1} win by forfeit
        </Button>
        <Button size="sm" disabled={busy} onClick={() => run(() => forfeitMatch(target.matchId, teamIds[1]), done)}>
          {target.team2} win by forfeit
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={() =>
            confirm('Undo this result? The match goes back in the queue to be played, and its teams come out of any later matches.') &&
            run(() => reopenMatch(target.matchId), done)
          }
        >
          Undo result and replay
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
