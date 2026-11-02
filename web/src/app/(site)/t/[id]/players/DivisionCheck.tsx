'use client';

// Who's outside their division's rules, refreshing ratings to find out, and
// moving a team that no longer fits.
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, ErrorText, Modal } from '@/components/ui';
import { refreshDuprRatings, type RatingRefresh } from '@/lib/duprRefresh';
import { useAction } from '@/lib/hooks';
import type { EligibilityRow, EntryEligibilityRow, RatingChange, Tournament, TournamentEvent } from '@/lib/types';
import { MoveTeam } from './MoveTeam';

const shift = (label: string, from: number | null, to: number | null) => {
  if (Number(from) === Number(to) || to === null) return '';
  const text = (n: number) => Number(n).toFixed(2);
  if (from === null) return `${label} ${text(to)}`;
  const change = Number(to) - Number(from);
  return `${label} ${text(from)} → ${text(to)} (${change > 0 ? '+' : ''}${change.toFixed(2)})`;
};
const changeText = (c: RatingChange) =>
  [shift('doubles', c.doubles_from, c.doubles_to), shift('singles', c.singles_from, c.singles_to)].filter(Boolean).join(', ');

export function DivisionCheck({
  tournament,
  events,
  eligibility,
  entryProblems,
  onOpenPlayer,
  onChanged,
}: {
  tournament: Tournament;
  events: TournamentEvent[];
  eligibility: EligibilityRow[];
  entryProblems: EntryEligibilityRow[];
  onOpenPlayer: (playerId: string) => void;
  onChanged: () => void;
}) {
  const [refresh, setRefresh] = useState<RatingRefresh | null>(null);
  const [moving, setMoving] = useState<EligibilityRow | null>(null);
  const { busy, error, run } = useAction();
  const teams = eligibility.filter((t) => t.problems.length > 0);
  const count = teams.length + entryProblems.length;
  const eventName = (id: string) => events.find((e) => e.id === id)?.name ?? '';
  const refreshed =
    tournament.ratings_refreshed_at &&
    new Date(tournament.ratings_refreshed_at).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tournament.time_zone,
    });

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-xl">
            Division rules
            {count > 0 ? <Badge tone="late">{count} to check</Badge> : <Badge tone="live">Everyone fits</Badge>}
          </h2>
          <p className="text-sm text-muted">{refreshed ? `Ratings last refreshed ${refreshed}` : 'Ratings haven’t been refreshed yet'}</p>
        </div>
        <Button disabled={busy} onClick={() => run(async () => setRefresh(await refreshDuprRatings(tournament.id)), onChanged)}>
          {busy ? 'Refreshing…' : 'Refresh DUPR ratings'}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {refresh && <RefreshResult tournamentId={tournament.id} refresh={refresh} />}

      {count > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {teams.map((t) => (
            <li key={t.team_id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0 flex-1 basis-60">
                <p className="font-semibold">
                  {t.team_name} <span className="font-normal text-muted">in {eventName(t.event_id)}</span>
                </p>
                <ul className="text-sm text-late">
                  {t.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
              <Button size="sm" onClick={() => setMoving(t)}>
                Move
              </Button>
            </li>
          ))}
          {entryProblems.map((e) => (
            <li key={`${e.registration_id}:${e.event_id}`} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0 flex-1 basis-60">
                <p className="font-semibold">
                  {e.player_name} <span className="font-normal text-muted">in {e.event_name}, no team yet</span>
                </p>
                <p className="text-sm text-late">{e.problem}</p>
              </div>
              <Button size="sm" onClick={() => onOpenPlayer(e.player_id)}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!moving} onClose={() => setMoving(null)} title={moving ? `Move ${moving.team_name}` : ''}>
        {moving && (
          <div className="flex flex-col gap-3">
            <ul className="rounded-lg bg-late-soft px-3 py-2 text-sm text-late">
              {moving.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <MoveTeam
              key={moving.team_id}
              teamId={moving.team_id}
              teamName={moving.team_name}
              onDone={() => {
                setMoving(null);
                onChanged();
              }}
            />
          </div>
        )}
      </Modal>
    </Card>
  );
}

function RefreshResult({ tournamentId, refresh }: { tournamentId: string; refresh: RatingRefresh }) {
  if (!refresh.connected) {
    return (
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
        DUPR isn’t connected to this site yet, so nothing was refreshed. You can paste current ratings on the{' '}
        <Link href={`/t/${tournamentId}/dupr`} className="font-medium underline">
          DUPR page
        </Link>
        .
      </p>
    );
  }
  const changes = refresh.result?.changes ?? [];
  const notes: [string, string[]][] = [
    ['No DUPR ID', refresh.noDuprId],
    ['Haven’t connected their DUPR account', refresh.notFound],
    ['No rating on DUPR yet', refresh.noRating],
  ];
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
      {refresh.simulated && <p className="font-semibold">Test mode: these ratings are made up, not from DUPR.</p>}
      <p>
        Checked {refresh.result?.updated ?? 0} player{refresh.result?.updated === 1 ? '' : 's'}.{' '}
        {changes.length ? `${changes.length} changed:` : 'No ratings changed.'}
      </p>
      {changes.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {changes.map((c) => (
            <li key={c.player_id}>
              <span className="font-medium">{c.name}</span> <span className="tnum">{changeText(c)}</span>
            </li>
          ))}
        </ul>
      )}
      {notes
        .filter(([, names]) => names.length > 0)
        .map(([label, names]) => (
          <p key={label} className="text-called">
            {label}: {names.join(', ')}
          </p>
        ))}
    </div>
  );
}
