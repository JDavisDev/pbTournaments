'use client';

import { useState } from 'react';
import { correctScore, reportScore } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { TournamentEvent } from '@/lib/types';
import { Button, ErrorText, Input, Modal } from '../ui';

export interface ScoreTarget {
  matchId: string;
  team1: string;
  team2: string;
  stage: 'pool' | 'bracket';
  eventId: string;
  games?: [number, number][] | null;
  mode: 'report' | 'correct';
}

export function ScoreDialog({
  target,
  events,
  onClose,
  onDone,
}: {
  target: ScoreTarget | null;
  events: TournamentEvent[];
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Modal open={!!target} onClose={onClose} title={target?.mode === 'correct' ? 'Correct score' : 'Enter score'}>
      {target && (
        <ScoreForm key={target.matchId} target={target} events={events} onClose={onClose} onDone={onDone} />
      )}
    </Modal>
  );
}

function ScoreForm({
  target,
  events,
  onClose,
  onDone,
}: {
  target: ScoreTarget;
  events: TournamentEvent[];
  onClose: () => void;
  onDone: () => void;
}) {
  const event = events.find((e) => e.id === target.eventId);
  const bracket = target.stage === 'bracket';
  const gamesTo = (bracket && event?.playoff_games_to) || event?.games_to || 11;
  const bestOf = (bracket && event?.playoff_best_of) || event?.best_of || 1;
  const [rows, setRows] = useState<[string, string][]>(() =>
    Array.from({ length: bestOf }, (_, i) => {
      const g = target.games?.[i];
      return g ? [String(g[0]), String(g[1])] : ['', ''];
    }),
  );
  const { busy, error, run } = useAction();

  const set = (i: number, side: 0 | 1, value: string) =>
    setRows((r) => r.map((row, j) => (j === i ? ((side === 0 ? [value, row[1]] : [row[0], value]) as [string, string]) : row)));

  function submit() {
    const games = rows
      .filter(([a, b]) => a !== '' && b !== '')
      .map(([a, b]) => [Number(a), Number(b)] as [number, number]);
    const save = target.mode === 'correct' ? correctScore : reportScore;
    run(
      () => save(target.matchId, games),
      () => {
        onDone();
        onClose();
      },
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-muted">
        {bestOf === 1 ? 'One game' : `Best of ${bestOf}`} to {gamesTo}, win by 2.
      </p>
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-2">
        <span />
        <span className="w-16 truncate text-center text-xs font-medium text-muted" title={target.team1}>
          {target.team1}
        </span>
        <span className="w-16 truncate text-center text-xs font-medium text-muted" title={target.team2}>
          {target.team2}
        </span>
        {rows.map(([a, b], i) => (
          <div key={i} className="contents">
            <span className="text-sm">Game {i + 1}</span>
            <Input
              aria-label={`Game ${i + 1} ${target.team1}`}
              className="tnum w-16 text-center text-lg"
              inputMode="numeric"
              autoFocus={i === 0}
              value={a}
              onChange={(e) => set(i, 0, e.target.value.replace(/\D/g, ''))}
            />
            <Input
              aria-label={`Game ${i + 1} ${target.team2}`}
              className="tnum w-16 text-center text-lg"
              inputMode="numeric"
              value={b}
              onChange={(e) => set(i, 1, e.target.value.replace(/\D/g, ''))}
            />
          </div>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={busy || rows[0][0] === '' || rows[0][1] === ''}>
          {target.mode === 'correct' ? 'Save correction' : 'Save score'}
        </Button>
      </div>
    </form>
  );
}
