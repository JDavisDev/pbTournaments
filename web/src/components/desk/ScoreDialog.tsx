'use client';

import { correctScore, reportScore } from '@/lib/api';
import type { ScoringRules } from '@/lib/scoring';
import { ScoreEntry } from '../ScoreEntry';
import { Modal } from '../ui';

export interface ScoreTarget {
  matchId: string;
  team1: string;
  team2: string;
  rules: ScoringRules;
  games?: [number, number][] | null;
  mode: 'report' | 'correct';
  /** What saving does beyond the score, e.g. re-seeding the bracket. */
  note?: string;
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
    </Modal>
  );
}
