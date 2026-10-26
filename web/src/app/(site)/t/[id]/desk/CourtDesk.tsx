'use client';

import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Icon } from '@/components/Icon';
import { CheckInPanel } from '@/components/desk/CheckInPanel';
import { CourtCard, courtState } from '@/components/desk/CourtCard';
import { MatchActionsDialog } from '@/components/desk/MatchActionsDialog';
import { QueuePanel } from '@/components/desk/QueuePanel';
import { ResultsPanel } from '@/components/desk/ResultsPanel';
import { ScoreDialog, type ScoreTarget } from '@/components/desk/ScoreDialog';
import { Button, Card, Empty, ErrorText, Select, Spinner } from '@/components/ui';
import {
  assignCourtsNow,
  getChampionshipHolds,
  getCourtBoard,
  getEvents,
  getMatches,
  getQueue,
  getTeams,
  getTournament,
  rebuildQueue,
  setAutoAssign,
  setCourtCount,
  setTournamentStatus,
  updateTournament,
} from '@/lib/api';
import { DemoClock } from '@/components/DemoTools';
import { championshipModes, isPlayable } from '@/lib/format';
import { rulesOf } from '@/lib/scoring';
import { useAction, useLiveTournament, useNow, useStaffAccess } from '@/lib/hooks';
import type { ChampionshipMode, CourtBoardRow } from '@/lib/types';

type Tab = 'courts' | 'queue' | 'checkin' | 'results';

async function loadDesk(id: string) {
  const [tournament, courts, queue, matches, events, teams, holds] = await Promise.all([
    getTournament(id),
    getCourtBoard(id),
    getQueue(id),
    getMatches(id),
    getEvents(id),
    getTeams(id),
    getChampionshipHolds(id),
  ]);
  return { tournament, courts, queue, matches, events, teams, holds };
}

export function CourtDesk({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => loadDesk(id), 15_000);
  const now = useNow(10_000);
  const [tab, setTab] = useState<Tab>('courts');
  // Wide screens always show courts, so the sidebar shows the queue instead.
  const sideTab = tab === 'courts' ? 'queue' : tab;
  const [score, setScore] = useState<ScoreTarget | null>(null);
  const [actions, setActions] = useState<CourtBoardRow | null>(null);
  const control = useAction();

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.monitor === undefined) return <Spinner />;
  if (!staff.monitor) return <Empty>The court desk is for this tournament’s directors and court monitors.</Empty>;
  // Court monitors run the courts (scores, check-in, no-shows); admins also
  // control the day: going live, courts, the queue order, moves and forfeits.
  const admin = !!staff.data;

  const { tournament: t, courts, queue, matches, events, teams, holds } = data;
  const states = courts.map((c) => courtState(c));
  const count = (s: string) => states.filter((x) => x === s).length;
  const ready = queue.filter((q) => !q.blocked_reason).length;
  // Court sections in force: divisions with matches still to play hold their courts.
  const unfinished = new Set(matches.filter((m) => ['waiting', 'queued', 'assigned', 'in_progress'].includes(m.status)).map((m) => m.event_id));
  // Championship courts kept free for a championship match about to be ready.
  const keptFor = (courtId: string) => [
    ...events.filter((e) => unfinished.has(e.id) && e.court_ids.includes(courtId)).map((e) => e.name),
    ...holds.filter((h) => h.court_id === courtId).map((h) => `${h.event_name} ${h.label}`),
  ];
  const playable = matches.filter(isPlayable);
  const done = playable.filter((m) => m.status === 'completed').length;
  const notIn = teams.filter((x) => !x.checked_in_at && !x.withdrawn_at).length;
  const live = t.status === 'live';

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-3 p-3">
        {!admin && <span className="font-semibold">Court monitor</span>}
        <div className={`flex items-center gap-2 ${admin ? '' : 'hidden'}`}>
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
              <Icon name="pause" /> Pause assigning
            </Button>
          ) : (
            <Button variant="primary" disabled={control.busy} onClick={() => control.run(() => setAutoAssign(id, true), reload)}>
              <Icon name="play" /> Resume assigning
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

        <div className={`flex items-center gap-2 ${admin ? '' : 'hidden'}`}>
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

        {admin && courts.some((c) => c.championship_rank) && (
          <label className="flex items-center gap-2">
            <span className="text-sm text-muted">Championship courts</span>
            <Select
              aria-label="When the championship courts are busy"
              value={t.championship_mode}
              disabled={control.busy}
              onChange={(e) =>
                control.run(async () => {
                  await updateTournament(id, { championship_mode: e.target.value as ChampionshipMode });
                  // Apply it now rather than at the next score.
                  if (live && t.auto_assign) await assignCourtsNow(id);
                }, reload)
              }
            >
              {championshipModes.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </label>
        )}

        <dl className="grid w-full grid-cols-4 gap-2 text-sm sm:flex sm:w-auto sm:flex-wrap sm:gap-x-5 sm:gap-y-1">
          <Stat label="On court" value={count('playing')} tone="text-live" />
          <Stat label="Open" value={count('open')} />
          <Stat label="Next up" value={ready} />
          <Stat label="Not checked in" value={notIn} />
          <Stat label="Matches done" value={`${done}/${playable.length}`} />
        </dl>

        <Button
          variant="ghost"
          size="sm"
          className={`ml-auto ${admin ? '' : 'hidden'}`}
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
      {t.is_demo && admin && <DemoClock tournamentId={id} now={now} timeZone={t.time_zone} onChanged={reload} />}
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

      {/* Phones and tablets: one view at a time. */}
      <div className="sticky top-0 z-20 -mx-4 bg-bg/95 px-4 py-2 backdrop-blur xl:hidden">
        <TabBar
          active={tab}
          onChange={setTab}
          tabs={[
            ['courts', `Courts`],
            ['queue', `Queue ${queue.length}`],
            ['checkin', notIn ? `Check-in ${notIn}` : 'Check-in'],
            ['results', 'Results'],
          ]}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_26rem]">
        <section className={tab === 'courts' ? '' : 'max-xl:hidden'}>
          {courts.length === 0 ? (
            <Empty>No courts. Use + to add some.</Empty>
          ) : (
            <div className="grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]">
              {courts.map((c) => (
                <CourtCard
                  key={c.court_id}
                  court={c}
                  now={now}
                  queue={queue}
                  staff
                  admin={admin}
                  keptFor={keptFor(c.court_id)}
                  onChanged={reload}
                  onMore={() => setActions(c)}
                  onScore={() =>
                    setScore({
                      matchId: c.match_id!,
                      team1: c.team1_name!,
                      team2: c.team2_name!,
                      rules: rulesOf(c),
                      mode: 'report',
                    })
                  }
                />
              ))}
            </div>
          )}
        </section>

        <aside className={`flex flex-col gap-3 ${tab === 'courts' ? 'max-xl:hidden' : ''}`}>
          <div className="max-xl:hidden">
            <TabBar
              active={sideTab}
              onChange={setTab}
              tabs={[
                ['queue', `Queue (${queue.length})`],
                ['checkin', `Check-in${notIn ? ` (${notIn})` : ''}`],
                ['results', 'Results'],
              ]}
            />
          </div>
          {sideTab === 'queue' && <QueuePanel queue={queue} staff={admin} now={now} onChanged={reload} />}
          {sideTab === 'checkin' && <CheckInPanel teams={teams} events={events} onChanged={reload} />}
          {sideTab === 'results' && (
            <ResultsPanel
              matches={matches}
              timeZone={t.time_zone}
              staff={admin}
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
        </aside>
      </div>

      <ScoreDialog target={score} onClose={() => setScore(null)} onDone={reload} />
      <MatchActionsDialog court={actions} courts={courts} admin={admin} onClose={() => setActions(null)} onDone={reload} />
    </div>
  );
}

function Stat({ label, value, tone = '' }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="flex flex-col items-center sm:flex-row sm:items-baseline sm:gap-1.5">
      <dd className={`tnum font-display text-3xl leading-none font-bold ${tone}`}>{value}</dd>
      <dt className="text-center text-xs leading-tight text-muted sm:text-sm">{label}</dt>
    </div>
  );
}

function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: [Tab, string][];
  active: Tab;
  onChange: (tab: Tab) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-surface-2 p-1" role="tablist">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          role="tab"
          aria-selected={active === key}
          onClick={() => onChange(key)}
          className={`flex-1 rounded-md px-2 py-2 text-sm font-medium whitespace-nowrap ${
            active === key ? 'bg-surface shadow-sm' : 'text-muted hover:text-text'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
