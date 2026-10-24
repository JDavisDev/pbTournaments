'use client';

import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { CheckInPanel } from '@/components/desk/CheckInPanel';
import { CourtCard, courtState } from '@/components/desk/CourtCard';
import { MatchActionsDialog } from '@/components/desk/MatchActionsDialog';
import { QueuePanel } from '@/components/desk/QueuePanel';
import { ResultsPanel } from '@/components/desk/ResultsPanel';
import { ScoreDialog, type ScoreTarget } from '@/components/desk/ScoreDialog';
import { Button, Card, Empty, ErrorText, Spinner } from '@/components/ui';
import {
  assignCourtsNow,
  getCourtBoard,
  getEvents,
  getMatches,
  getQueue,
  getTeams,
  getTournament,
  isStaff,
  rebuildQueue,
  setAutoAssign,
  setCourtCount,
  setTournamentStatus,
} from '@/lib/api';
import { useAction, useLiveTournament, useLoad, useNow, useSession } from '@/lib/hooks';
import type { CourtBoardRow } from '@/lib/types';

type Tab = 'queue' | 'checkin' | 'results';

async function loadDesk(id: string) {
  const [tournament, courts, queue, matches, events, teams] = await Promise.all([
    getTournament(id),
    getCourtBoard(id),
    getQueue(id),
    getMatches(id),
    getEvents(id),
    getTeams(id),
  ]);
  return { tournament, courts, queue, matches, events, teams };
}

export function CourtDesk({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = useSession();
  const staff = useLoad(() => (session ? isStaff(id) : Promise.resolve(false)), [id, session?.user.id]);
  const { data, error, reload } = useLiveTournament(id, () => loadDesk(id), 15_000);
  const now = useNow(10_000);
  const [tab, setTab] = useState<Tab>('queue');
  const [score, setScore] = useState<ScoreTarget | null>(null);
  const [actions, setActions] = useState<CourtBoardRow | null>(null);
  const control = useAction();

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>The court desk is for this tournament’s directors. Sign in with a director account.</Empty>;

  const { tournament: t, courts, queue, matches, events, teams } = data;
  const states = courts.map((c) => courtState(c, now));
  const count = (s: string) => states.filter((x) => x === s).length;
  const ready = queue.filter((q) => !q.blocked_reason).length;
  const done = matches.filter((m) => m.status === 'completed').length;
  const notIn = teams.filter((x) => !x.checked_in_at && !x.withdrawn_at).length;
  const live = t.status === 'live';

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-3 p-3">
        <div className="flex items-center gap-2">
          {!live ? (
            <Button
              variant="primary"
              disabled={control.busy}
              onClick={() => control.run(() => setTournamentStatus(id, 'live'), reload)}
            >
              Go live
            </Button>
          ) : t.auto_assign ? (
            <Button disabled={control.busy} onClick={() => control.run(() => setAutoAssign(id, false), reload)}>
              ⏸ Pause assigning
            </Button>
          ) : (
            <Button variant="primary" disabled={control.busy} onClick={() => control.run(() => setAutoAssign(id, true), reload)}>
              ▶ Resume assigning
            </Button>
          )}
          {(!live || !t.auto_assign) && (
            <Button
              variant="ghost"
              disabled={control.busy}
              title="Send the top ready matches to open courts once"
              onClick={() => control.run(() => assignCourtsNow(id), reload)}
            >
              Fill open courts once
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">Courts</span>
          <Button
            size="sm"
            aria-label="Remove a court"
            disabled={control.busy || courts.length === 0}
            onClick={() => control.run(() => setCourtCount(id, courts.length - 1), reload)}
          >
            −
          </Button>
          <span className="tnum w-8 text-center text-lg font-semibold">{courts.length}</span>
          <Button
            size="sm"
            aria-label="Add a court"
            disabled={control.busy}
            onClick={() => control.run(() => setCourtCount(id, courts.length + 1), reload)}
          >
            +
          </Button>
        </div>

        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <Stat label="Playing" value={count('playing')} tone="text-live" />
          <Stat label="Called" value={count('called')} tone="text-called" />
          <Stat label="Late" value={count('late')} tone="text-late" />
          <Stat label="Open" value={count('open')} />
          <Stat label="Ready in queue" value={ready} />
          <Stat label="Not checked in" value={notIn} />
          <Stat label="Matches done" value={`${done}/${matches.length}`} />
        </dl>

        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={control.busy}
          onClick={() => {
            if (confirm('Put the queue back in schedule order? Your manual moves will be undone.')) {
              control.run(() => rebuildQueue(id), reload);
            }
          }}
        >
          Reset queue order
        </Button>
      </Card>
      <ErrorText>{control.error}</ErrorText>
      {live && !t.auto_assign && (
        <p className="rounded-lg bg-called-soft px-3 py-2 text-sm text-called">
          Assigning is paused. Courts won’t get new matches until you resume (or send matches by hand).
        </p>
      )}
      {!live && (
        <p className="rounded-lg bg-info-soft px-3 py-2 text-sm text-info">
          The tournament isn’t live yet, so nothing is sent to courts automatically. Go live when play starts.
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_26rem]">
        <section>
          {courts.length === 0 ? (
            <Empty>No courts. Use + to add some.</Empty>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
              {courts.map((c) => (
                <CourtCard
                  key={c.court_id}
                  court={c}
                  now={now}
                  queue={queue}
                  staff
                  onChanged={reload}
                  onMore={() => setActions(c)}
                  onScore={() =>
                    setScore({
                      matchId: c.match_id!,
                      team1: c.team1_name!,
                      team2: c.team2_name!,
                      eventId: c.event_id!,
                      stage: matches.find((m) => m.id === c.match_id)?.stage ?? 'pool',
                      mode: 'report',
                    })
                  }
                />
              ))}
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-3">
          <div className="flex gap-1 rounded-lg bg-surface-2 p-1">
            {(
              [
                ['queue', `Queue (${queue.length})`],
                ['checkin', `Check-in${notIn ? ` (${notIn})` : ''}`],
                ['results', 'Results'],
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${
                  tab === key ? 'bg-surface shadow-sm' : 'text-muted hover:text-text'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'queue' && <QueuePanel queue={queue} staff now={now} onChanged={reload} />}
          {tab === 'checkin' && <CheckInPanel teams={teams} events={events} onChanged={reload} />}
          {tab === 'results' && (
            <ResultsPanel
              matches={matches}
              timeZone={t.time_zone}
              staff
              onCorrect={(m) =>
                setScore({
                  matchId: m.id,
                  team1: m.team1_name,
                  team2: m.team2_name,
                  eventId: m.event_id,
                  stage: m.stage,
                  games: m.games,
                  mode: 'correct',
                })
              }
            />
          )}
        </aside>
      </div>

      <ScoreDialog target={score} events={events} onClose={() => setScore(null)} onDone={reload} />
      <MatchActionsDialog court={actions} courts={courts} onClose={() => setActions(null)} onDone={reload} />
    </div>
  );
}

function Stat({ label, value, tone = '' }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dd className={`tnum text-lg font-semibold ${tone}`}>{value}</dd>
      <dt className="text-muted">{label}</dt>
    </div>
  );
}
