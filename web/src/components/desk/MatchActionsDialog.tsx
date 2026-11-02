'use client';

import { useState } from 'react';
import { assignMatchToCourt, forfeitMatch, holdMatch, moveMatchToCourt, requeueMatch, setCourtPaused } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { CourtBoardRow, MatchDetails } from '@/lib/types';
import { Button, Check, ErrorText, Modal, Select } from '../ui';

/** Director actions for the match on a court: move/swap, send back to the queue, forfeit, pause. */
export function MatchActionsDialog({
  court,
  courts,
  admin = true,
  onClose,
  onDone,
}: {
  court: CourtBoardRow | null;
  courts: CourtBoardRow[];
  /** Court monitors only get "send back to the queue". */
  admin?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Modal open={!!court} onClose={onClose} title={court ? `${court.court_name}: ${court.label}` : ''}>
      {court && <Actions key={court.match_id} court={court} courts={courts} admin={admin} onClose={onClose} onDone={onDone} />}
    </Modal>
  );
}

/** Director actions for a match still in the queue: send it out, hold it, forfeit. */
export function QueuedMatchDialog({
  match,
  courts,
  onScore,
  onClose,
  onDone,
}: {
  match: MatchDetails | null;
  courts: CourtBoardRow[];
  /** Enter a score from a paper sheet. */
  onScore: (m: MatchDetails) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Modal open={!!match} onClose={onClose} title={match ? match.label ?? 'Match' : ''}>
      {match && <QueuedActions key={match.id} match={match} courts={courts} onScore={onScore} onClose={onClose} onDone={onDone} />}
    </Modal>
  );
}

function QueuedActions({
  match: m,
  courts,
  onScore,
  onClose,
  onDone,
}: {
  match: MatchDetails;
  courts: CourtBoardRow[];
  onScore: (m: MatchDetails) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [target, setTarget] = useState('');
  const { busy, error, run } = useAction();
  const done = () => {
    onDone();
    onClose();
  };
  const open = courts.filter((c) => !c.match_id && !c.out_of_service);
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm">
        <span className="font-medium">{m.team1_name}</span> vs <span className="font-medium">{m.team2_name}</span>
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Already played?</h3>
        <Button variant="primary" onClick={() => onScore(m)}>
          Enter the score
        </Button>
        <p className="text-xs text-muted">For a match played from a paper scoresheet, without going on a court here.</p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Send to a court</h3>
        <p className="text-xs text-muted">Goes out now, ahead of the queue.</p>
        {open.length === 0 ? (
          <p className="text-sm text-muted">No courts are open right now.</p>
        ) : (
          <div className="flex gap-2">
            <Select className="flex-1" aria-label="Court" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a court…</option>
              {open.map((c) => (
                <option key={c.court_id} value={c.court_id}>
                  {c.court_name}
                </option>
              ))}
            </Select>
            <Button disabled={!target || busy} onClick={() => run(() => assignMatchToCourt(m.id, target), done)}>
              Send
            </Button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">{m.on_hold ? 'On hold' : 'Hold'}</h3>
        <Button disabled={busy} onClick={() => run(() => holdMatch(m.id, !m.on_hold), done)}>
          {m.on_hold ? 'Release it' : 'Keep it off courts until I release it'}
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Forfeit</h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" disabled={busy} onClick={() => run(() => forfeitMatch(m.id, m.team1_id!), done)}>
            {m.team1_name} win by forfeit
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => run(() => forfeitMatch(m.id, m.team2_id!), done)}>
            {m.team2_name} win by forfeit
          </Button>
        </div>
      </section>

      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function Actions({
  court,
  courts,
  admin,
  onClose,
  onDone,
}: {
  court: CourtBoardRow;
  courts: CourtBoardRow[];
  admin: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [target, setTarget] = useState('');
  const [absent, setAbsent] = useState<string>('none');
  const [hold, setHold] = useState(false);
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

      <section className={`flex flex-col gap-2 ${admin ? '' : 'hidden'}`}>
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
          It keeps its place in line, and goes back out as soon as a court is free unless you hold it. A team marked missing is
          checked out until they check in again.
        </p>
        <Select value={absent} onChange={(e) => setAbsent(e.target.value)}>
          <option value="none">Everyone is here, just pull it off the court</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} didn’t show
            </option>
          ))}
        </Select>
        <Check label="Hold it until I release it from the queue" checked={hold} onChange={setHold} />
        <Button disabled={busy} onClick={() => run(() => requeueMatch(matchId, absent === 'none' ? null : absent, hold), done)}>
          Send back to queue
        </Button>
      </section>

      <section className={`flex flex-col gap-2 ${admin ? '' : 'hidden'}`}>
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

      <section className={`flex flex-col gap-2 ${admin ? '' : 'hidden'}`}>
        <h3 className="text-lg">Court problem</h3>
        <Button disabled={busy} onClick={() => run(() => setCourtPaused(court.court_id, true), done)}>
          Pause {court.court_name} (this match goes back to the queue)
        </Button>
      </section>

      <ErrorText>{error}</ErrorText>
    </div>
  );
}
