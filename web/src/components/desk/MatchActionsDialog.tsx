'use client';

import { useState } from 'react';
import { forfeitMatch, moveMatchToCourt, requeueMatch, setCourtPaused } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { CourtBoardRow } from '@/lib/types';
import { Button, ErrorText, Modal, Select } from '../ui';

/** Director actions for the match on a court: move/swap, send back to the queue, forfeit, pause. */
export function MatchActionsDialog({
  court,
  courts,
  onClose,
  onDone,
}: {
  court: CourtBoardRow | null;
  courts: CourtBoardRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Modal open={!!court} onClose={onClose} title={court ? `${court.court_name}: ${court.label}` : ''}>
      {court && <Actions key={court.match_id} court={court} courts={courts} onClose={onClose} onDone={onDone} />}
    </Modal>
  );
}

function Actions({
  court,
  courts,
  onClose,
  onDone,
}: {
  court: CourtBoardRow;
  courts: CourtBoardRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [target, setTarget] = useState('');
  const [absent, setAbsent] = useState<string>('none');
  const [winner, setWinner] = useState('');
  const { busy, error, run } = useAction();
  const done = () => {
    onDone();
    onClose();
  };
  const matchId = court.match_id!;
  const teams = [
    { id: court.team1_id!, name: court.team1_name! },
    { id: court.team2_id!, name: court.team2_name! },
  ];
  const others = courts.filter((c) => c.court_id !== court.court_id && (!c.out_of_service || c.match_id));

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm">
        <span className="font-medium">{court.team1_name}</span> vs <span className="font-medium">{court.team2_name}</span>
        <span className="text-muted"> · {court.event_name}</span>
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Move to another court</h3>
        <div className="flex gap-2">
          <Select className="flex-1" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a court…</option>
            {others.map((c) => (
              <option key={c.court_id} value={c.court_id}>
                {c.court_name}
                {c.match_id ? ` (swap with ${c.team1_name} v ${c.team2_name})` : ' (open)'}
              </option>
            ))}
          </Select>
          <Button disabled={!target || busy} onClick={() => run(() => moveMatchToCourt(matchId, target), done)}>
            Move
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Send back to the queue</h3>
        <p className="text-xs text-muted">
          It keeps its place in line. A team marked missing is checked out until they check in again.
        </p>
        <Select value={absent} onChange={(e) => setAbsent(e.target.value)}>
          <option value="none">Everyone is here, just pull it off the court</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} didn’t show
            </option>
          ))}
        </Select>
        <Button disabled={busy} onClick={() => run(() => requeueMatch(matchId, absent === 'none' ? null : absent), done)}>
          Send back to queue
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Forfeit</h3>
        <div className="flex gap-2">
          <Select className="flex-1" value={winner} onChange={(e) => setWinner(e.target.value)}>
            <option value="">Winner…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} wins by forfeit
              </option>
            ))}
          </Select>
          <Button variant="danger" disabled={!winner || busy} onClick={() => run(() => forfeitMatch(matchId, winner), done)}>
            Forfeit
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Court problem</h3>
        <Button disabled={busy} onClick={() => run(() => setCourtPaused(court.court_id, true), done)}>
          Pause {court.court_name} (this match goes back to the queue)
        </Button>
      </section>

      <ErrorText>{error}</ErrorText>
    </div>
  );
}
