'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { Bracket } from '@/components/Bracket';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Icon } from '@/components/Icon';
import { QueuePanel } from '@/components/desk/QueuePanel';
import { MatchRow } from '@/components/MatchRow';
import { Podium } from '@/components/Podium';
import { StandingsTable } from '@/components/StandingsTable';
import { WatchChip } from '@/components/StreamEmbed';
import { Badge, Button, Card, Empty, ErrorText, Spinner } from '@/components/ui';
import {
  endPoolPlay,
  getCourtBoard,
  getEvents,
  getMatches,
  getQueue,
  getStandings,
  getTeams,
  getTournament,
  startBracket,
  swapBracketTeams,
} from '@/lib/api';
import { describeDivision } from '@/lib/eligibility';
import { formatSummary, isPlayable, podium, poolName, shortFormat } from '@/lib/format';
import { useAction, useLiveTournament, useNow, useStaffAccess } from '@/lib/hooks';
import type { MatchDetails, QueueRow } from '@/lib/types';

async function load(id: string) {
  const [tournament, events, teams, matches, standings, queue, courts] = await Promise.all([
    getTournament(id),
    getEvents(id),
    getTeams(id),
    getMatches(id),
    getStandings(id),
    getQueue(id),
    getCourtBoard(id),
  ]);
  return { tournament, events, teams, matches, standings, queue, courts };
}

type Tab = 'standings' | 'bracket' | 'matches' | 'queue';

/** A division: standings, bracket and matches for everyone; stats and stage controls for directors. */
export function EventView({ params }: { params: Promise<{ id: string; eventId: string }> }) {
  const { id, eventId } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => load(id));
  const now = useNow(30_000);
  const [tab, setTab] = useState<Tab | null>(null);
  const [arranging, setArranging] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const control = useAction();

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Spinner />;
  const event = data.events.find((e) => e.id === eventId);
  if (!event) return <Empty>Event not found.</Empty>;
  const isDirector = !!staff.data;

  const all = data.matches.filter((m) => m.event_id === eventId);
  const matches = all.filter(isPlayable);
  const teams = data.teams.filter((t) => t.event_id === eventId && !t.withdrawn_at);
  const teamName = (teamId: string) => data.teams.find((t) => t.id === teamId)?.name ?? '';
  const standings = data.standings.filter((s) => s.event_id === eventId);
  const pools = [...new Set(standings.map((s) => s.pool))].sort((a, b) => a - b);
  const bracket = all.filter((m) => m.stage === 'bracket');
  const poolMatches = all
    .filter((m) => m.stage === 'pool')
    .sort((a, b) => a.pool - b.pool || a.round - b.round || a.position - b.position);
  const queue = data.queue.filter((q) => q.event_id === eventId);
  const queueById = new Map(queue.map((q) => [q.match_id, q]));
  const advance = event.format === 'pools_to_bracket' ? event.advance_per_pool : 0;
  const onCourt = data.courts.filter((c) => c.event_id === eventId && c.match_id);

  // Where the division is.
  const poolLeft = poolMatches.filter((m) => m.status !== 'completed' && m.status !== 'cancelled');
  const poolUnstarted = poolLeft.filter((m) => m.status === 'waiting' || m.status === 'queued');
  const finished = matches.length > 0 && matches.every((m) => m.status === 'completed');
  // A finished single-pool round robin gives medals by final standings.
  const byRank = (rank: number) => standings.find((s) => s.pool_rank === rank)?.team_id ?? null;
  const medals =
    podium(bracket) ??
    (event.format === 'round_robin' && finished && pools.length === 1
      ? { gold: byRank(1), silver: byRank(2), bronze: [byRank(3)].filter((t): t is string => !!t) }
      : null);
  const bracketNotStarted = bracket.length > 0 && !bracket.some((m) => isPlayable(m) && (m.status === 'assigned' || m.status === 'in_progress' || m.status === 'completed'));
  const held = bracket.some((m) => m.on_hold && (m.status === 'waiting' || m.status === 'queued'));
  const seeded = event.format !== 'pools_to_bracket' || !!event.playoffs_seeded_at;
  const stage =
    all.length === 0
      ? 'Not scheduled'
      : medals || finished
        ? 'Complete'
        : poolLeft.length > 0
          ? 'Pool play'
          : held
            ? 'Seeds under review'
            : 'Bracket';

  const played = matches.filter((m) => m.status === 'completed').length;
  const lengths = matches
    .filter((m) => m.status === 'completed' && m.started_at && m.completed_at && !m.forfeit)
    .map((m) => (new Date(m.completed_at!).getTime() - new Date(m.started_at!).getTime()) / 60_000);
  const avgLength = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : null;
  const ready = queue.filter((q) => !q.blocked_reason).length;

  const tabs: [Tab, string][] = [
    ...(pools.length ? ([['standings', 'Standings']] as [Tab, string][]) : []),
    ...(bracket.length ? ([['bracket', 'Bracket']] as [Tab, string][]) : []),
    ['matches', `Matches ${matches.length ? `${played}/${matches.length}` : ''}`.trim()],
    ...(isDirector ? ([['queue', `Queue ${queue.length}`]] as [Tab, string][]) : []),
  ];
  const defaultTab: Tab = bracket.length && (poolLeft.length === 0 || !pools.length) ? 'bracket' : pools.length ? 'standings' : 'matches';
  const active = tab && tabs.some(([k]) => k === tab) ? tab : defaultTab;

  const pick = (teamId: string) => {
    if (!picked) return setPicked(teamId);
    if (picked === teamId) return setPicked(null);
    const [a, b] = [picked, teamId];
    setPicked(null);
    control.run(() => swapBracketTeams(eventId, a, b), reload);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={stage === 'Complete' ? 'neutral' : stage === 'Not scheduled' ? 'neutral' : stage === 'Seeds under review' ? 'called' : 'live'}>
              {stage}
            </Badge>
            {onCourt.length > 0 && <Badge tone="live">{onCourt.length} on court</Badge>}
          </div>
          <h2 className="mt-2 text-4xl sm:text-5xl">{event.name}</h2>
          <p className="text-muted">
            {describeDivision(event)} · {formatSummary(event)}
          </p>
        </div>
        {isDirector && (
          <Link href={`/t/${id}/setup`} className="text-sm font-medium text-muted underline hover:text-text">
            Division settings
          </Link>
        )}
      </div>

      <StageTrack event={event} pools={pools.length > 0} stage={stage} />

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Teams" value={teams.length} />
        <Tile label="Played" value={matches.length ? `${played}/${matches.length}` : '—'} bar={matches.length ? played / matches.length : 0} />
        <Tile label="On court" value={onCourt.length} tone="text-live" />
        <Tile label="Next up" value={ready} />
        <Tile label="Avg match" value={avgLength !== null ? `${avgLength}m` : '—'} />
        <Tile label={event.format === 'round_robin' ? 'Format' : 'Bracket'} value={formatShort(event, matches)} small />
      </dl>

      {medals && (
        <section>
          <h3 className="mb-3 text-3xl">Medals</h3>
          <Podium result={medals} teamName={teamName} tournamentId={id} />
        </section>
      )}

      {isDirector && !medals && (poolUnstarted.length > 0 || (bracketNotStarted && seeded) || held) && (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-sm font-semibold tracking-widest text-muted uppercase">Division controls</span>
            {poolUnstarted.length > 0 && (
              <Button
                size="sm"
                disabled={control.busy}
                onClick={() => {
                  const msg =
                    `End pool play now? ${poolUnstarted.length} unplayed pool match${poolUnstarted.length === 1 ? '' : 'es'} will be cancelled. ` +
                    `Standings use win percentage over the matches played.` +
                    (poolLeft.length > poolUnstarted.length ? ' Matches on court now finish first.' : '') +
                    (event.format === 'pools_to_bracket' ? ' The bracket is seeded once they do.' : '');
                  if (confirm(msg)) control.run(() => endPoolPlay(eventId), reload);
                }}
              >
                End pool play
              </Button>
            )}
            {bracketNotStarted && seeded && (
              <Button size="sm" variant={arranging ? 'primary' : 'secondary'} onClick={() => (setArranging(!arranging), setPicked(null))}>
                {arranging ? 'Done arranging' : 'Arrange seeds'}
              </Button>
            )}
            {held && (
              <Button size="sm" variant="primary" disabled={control.busy} onClick={() => control.run(() => startBracket(eventId), () => (setArranging(false), reload()))}>
                <Icon name="play" /> Start bracket
              </Button>
            )}
          </div>
          {held && !arranging && (
            <p className="text-sm text-called">The bracket is held so you can check the seeds. Arrange them if needed, then start it.</p>
          )}
          {arranging && (
            <p className="text-sm text-info">
              {picked ? `Now click the team to swap with ${teamName(picked)}.` : 'Click a team, then another, to swap their places in the bracket.'}
            </p>
          )}
          <ErrorText>{control.error}</ErrorText>
        </Card>
      )}

      {onCourt.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {onCourt.map((c) => (
            <div key={c.court_id} className="flex items-center gap-2 rounded-full bg-surface-2 py-1 pr-1 pl-3 text-sm">
              <span className="font-display font-bold uppercase">{c.court_name}</span>
              <span className="text-muted">
                {c.team1_name} v {c.team2_name}
              </span>
              {c.stream_url ? <WatchChip url={c.stream_url} /> : <span className="w-1" />}
            </div>
          ))}
        </div>
      )}

      {all.length === 0 ? (
        <Empty>The schedule for this event hasn’t been built yet.</Empty>
      ) : (
        <>
          <div className="flex gap-1 overflow-x-auto rounded-lg bg-surface-2 p-1" role="tablist">
            {tabs.map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={active === key}
                onClick={() => setTab(key)}
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap ${
                  active === key ? 'bg-surface shadow-sm' : 'text-muted hover:text-text'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {active === 'standings' && (
            <section>
              <div className="grid gap-4 lg:grid-cols-2">
                {pools.map((pool) => (
                  <div key={pool}>
                    {pools.length > 1 && <h4 className="mb-2 font-display text-xl font-bold uppercase">{poolName(pool)}</h4>}
                    <StandingsTable rows={standings.filter((s) => s.pool === pool)} tournamentId={id} advance={advance} />
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                {advance > 0 ? `Top ${advance} in each pool advance. ` : ''}
                Ranked by win percentage, then head-to-head, point differential and points scored.
              </p>
            </section>
          )}

          {active === 'bracket' && (
            <section>
              {event.format === 'pools_to_bracket' && !event.playoffs_seeded_at && (
                <p className="mb-3 text-sm text-muted">Seeds are filled in when pool play finishes.</p>
              )}
              <Bracket matches={bracket} picking={arranging ? { pickedTeamId: picked, onPick: pick } : undefined} />
            </section>
          )}

          {active === 'matches' && (
            <section className="grid gap-4 lg:grid-cols-2">
              {pools.map((pool) => (
                <MatchList
                  key={pool}
                  title={pools.length > 1 ? poolName(pool) : 'Pool play'}
                  matches={poolMatches.filter((m) => m.pool === pool && isPlayable(m))}
                  queueById={queueById}
                  timeZone={data.tournament.time_zone}
                />
              ))}
              {bracket.some(isPlayable) && (
                <MatchList
                  title="Bracket"
                  matches={bracket.filter(isPlayable).sort((a, b) => Number(a.queue_seq) - Number(b.queue_seq))}
                  queueById={queueById}
                  timeZone={data.tournament.time_zone}
                />
              )}
            </section>
          )}

          {active === 'queue' && isDirector && <QueuePanel queue={queue} staff now={now} onChanged={reload} />}
        </>
      )}
    </div>
  );
}

function MatchList({
  title,
  matches,
  queueById,
  timeZone,
}: {
  title: string;
  matches: MatchDetails[];
  queueById: Map<string, QueueRow>;
  timeZone: string;
}) {
  return (
    <div className="divide-y divide-border rounded-xl border border-border bg-surface">
      <h4 className="px-3 py-2 font-display text-lg font-bold uppercase">{title}</h4>
      {matches.map((m) => (
        <MatchRow key={m.id} match={m} queueRow={queueById.get(m.id)} timeZone={timeZone} />
      ))}
    </div>
  );
}

function formatShort(event: { format: string; bracket_type: string; games_to: number; best_of: number; point_cap: number | null }, matches: MatchDetails[]) {
  if (event.format === 'round_robin') return shortFormat(event);
  const final = matches.find((m) => m.round_key === 'final' || m.round_key === 'grand_final');
  return `${event.bracket_type === 'double' ? 'Double' : 'Single'} elim${final ? ` · final ${shortFormat(final)}` : ''}`;
}

function Tile({ label, value, tone = '', bar, small }: { label: string; value: number | string; tone?: string; bar?: number; small?: boolean }) {
  return (
    <div className="flex flex-col justify-between gap-1 rounded-2xl bg-surface-2 p-3">
      <dt className="text-xs font-semibold tracking-widest text-muted uppercase">{label}</dt>
      <dd className={`tnum font-display leading-none font-bold ${small ? 'text-lg' : 'text-4xl'} ${tone}`}>{value}</dd>
      {bar !== undefined && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
          <div className="h-full bg-brand transition-all" style={{ width: `${Math.round(bar * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

/** Pool play → bracket → medals, with the current step lit. */
function StageTrack({ event, pools, stage }: { event: { format: string; bracket_type: string }; pools: boolean; stage: string }) {
  const steps = [
    ...(pools || event.format !== 'single_elim' ? ['Pool play'] : []),
    ...(event.format !== 'round_robin' ? [event.bracket_type === 'double' ? 'Double-elim bracket' : 'Bracket'] : []),
    'Complete',
  ];
  const current =
    stage === 'Complete'
      ? steps.length - 1
      : stage === 'Pool play' || stage === 'Not scheduled'
        ? 0
        : steps.length - 2;
  return (
    <ol className="flex items-center gap-2 text-sm">
      {steps.map((s, i) => (
        <li key={s} className="flex flex-1 items-center gap-2">
          <span
            className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${
              i < current || stage === 'Complete' ? 'bg-brand text-white' : i === current ? 'bg-accent text-accent-text' : 'bg-surface-2 text-muted'
            }`}
          >
            {i < current || stage === 'Complete' ? <Icon name="check" className="h-4 w-4" /> : i + 1}
          </span>
          <span className={`whitespace-nowrap ${i === current ? 'font-semibold' : 'text-muted'}`}>{s}</span>
          {i < steps.length - 1 && <span className="h-px flex-1 bg-border" />}
        </li>
      ))}
    </ol>
  );
}
