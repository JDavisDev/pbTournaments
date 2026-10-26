'use client';

import Link from 'next/link';
import { use, useMemo, type ReactNode } from 'react';
import { Bracket } from '@/components/Bracket';
import { ConnectNotice } from '@/components/ConnectNotice';
import { DemoInbox } from '@/components/DemoTools';
import { Expandable } from '@/components/Expandable';
import { QueueStatus } from '@/components/desk/QueuePanel';
import { MatchRow } from '@/components/MatchRow';
import { StandingsTable } from '@/components/StandingsTable';
import { Icon } from '@/components/Icon';
import { CourtSign, FormatLine, MatchSteps, useMyTeam, useScoreCode } from '@/components/MatchDay';
import { ScoreEntry } from '@/components/ScoreEntry';
import { StreamEmbed } from '@/components/StreamEmbed';
import { Button, Card, Empty, Spinner } from '@/components/ui';
import {
  getCourtBoard,
  getEvents,
  getMatches,
  getQueue,
  getStandings,
  getTeams,
  getTournament,
  reportScore,
  reportScoreByCode,
} from '@/lib/api';
import { isPlayable, minutesSince, ordinal, poolName } from '@/lib/format';
import { useLiveTournament, useNow, useStaffAccess } from '@/lib/hooks';
import { rulesOf } from '@/lib/scoring';
import { estimateWait, formatWaitRange } from '@/lib/waitTime';
import type { MatchDetails, QueueRow, Team } from '@/lib/types';

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

const statusOrder: Record<MatchDetails['status'], number> = {
  in_progress: 0,
  assigned: 0,
  queued: 1,
  waiting: 2,
  completed: 3,
  cancelled: 4,
};

export function TeamView({ params }: { params: Promise<{ id: string; teamId: string }> }) {
  const { id, teamId } = use(params);
  const { data, error } = useLiveTournament(id, () => load(id));
  const now = useNow();

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Spinner />;
  const team = data.teams.find((t) => t.id === teamId);
  if (!team) return <Empty>Team not found.</Empty>;
  const event = data.events.find((e) => e.id === team.event_id)!;
  const tz = data.tournament.time_zone;

  const queueById = new Map(data.queue.map((q) => [q.match_id, q]));
  // Live first, then upcoming in queue order, then results (latest first).
  const mine = data.matches
    .filter((m) => (m.team1_id === teamId || m.team2_id === teamId) && isPlayable(m))
    .sort(
      (a, b) =>
        statusOrder[a.status] - statusOrder[b.status] ||
        (a.status === 'completed'
          ? (b.completed_at ?? '').localeCompare(a.completed_at ?? '')
          : Number(a.queue_seq) - Number(b.queue_seq)),
    );
  const onCourt = mine.find((m) => m.status === 'assigned' || m.status === 'in_progress');
  const next = mine.find((m) => m.status === 'queued');
  const nextQueue = next ? queueById.get(next.id) : undefined;
  const wins = mine.filter((m) => m.status === 'completed' && m.winner_team_id === teamId).length;
  const losses = mine.filter((m) => m.status === 'completed' && m.winner_team_id !== teamId).length;

  // Byes: pool rounds this team sits out.
  const poolMatches = data.matches.filter(
    (m) => m.event_id === event.id && m.stage === 'pool' && m.pool === team.pool && isPlayable(m),
  );
  const rounds = [...new Set(poolMatches.map((m) => m.round))].sort((a, b) => a - b);
  const byes = rounds.filter((r) => !poolMatches.some((m) => m.round === r && (m.team1_id === teamId || m.team2_id === teamId)));

  const standings = data.standings.filter((s) => s.event_id === event.id && s.pool === team.pool);
  const myStanding = standings.find((s) => s.team_id === teamId);
  const bracket = data.matches.filter((m) => m.event_id === event.id && m.stage === 'bracket');
  const myBracket = bracket.filter((m) => m.team1_id === teamId || m.team2_id === teamId);
  const inBracket = myBracket.length > 0;
  const nextBracket = myBracket.find((m) => m.status !== 'completed' && m.status !== 'cancelled');
  const played = mine.filter((m) => m.status === 'completed').length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-4xl">{team.name}</h2>
        <p className="text-muted">
          <Link href={`/t/${id}/events/${event.id}`} className="hover:underline">
            {event.name}
          </Link>
          {team.pool ? ` · ${poolName(team.pool)}` : ''}
          {team.seed ? ` · Seed ${team.seed}` : ''} · {wins}–{losses}
          {myStanding ? ` · ${ordinal(myStanding.pool_rank)} in pool` : ''}
        </p>
      </div>

      <MatchDayPanel
        tournamentId={id}
        team={team}
        mine={mine}
        onCourt={onCourt}
        next={next}
        nextQueue={nextQueue}
        wait={
          // Only while courts are being filled: paused, nobody can say.
          next && nextQueue && data.tournament.status === 'live' && data.tournament.auto_assign ? (
            <EstimatedWait data={data} matchId={next.id} now={now} />
          ) : undefined
        }
        now={now}
      />

      <Expandable
        id="my-schedule"
        title="Your schedule"
        summary={mine.length ? `${played} of ${mine.length} played` : 'No matches yet'}
        defaultOpen
      >
        {byes.length > 0 && (
          <p className="mb-2 text-sm text-muted">
            Bye in round{byes.length > 1 ? 's' : ''} {byes.join(', ')}.
          </p>
        )}
        {mine.length === 0 ? (
          <Empty>No matches yet.</Empty>
        ) : (
          <div className="-mx-1 divide-y divide-border">
            {mine.map((m) => (
              <MatchRow key={m.id} match={m} queueRow={queueById.get(m.id)} timeZone={tz} perspectiveTeamId={teamId} />
            ))}
          </div>
        )}
      </Expandable>

      {standings.length > 0 && (
        <Expandable
          id="pool-standings"
          title={`${poolName(team.pool) || 'Pool'} standings`}
          summary={myStanding ? `You’re ${ordinal(myStanding.pool_rank)} of ${standings.length}` : `${standings.length} teams`}
        >
          <StandingsTable
            rows={standings}
            tournamentId={id}
            advance={event.format === 'pools_to_bracket' ? event.advance_per_pool : 0}
            highlightTeamId={teamId}
          />
        </Expandable>
      )}

      {bracket.length > 0 && (inBracket || event.format === 'single_elim') && (
        <Expandable
          id="bracket"
          title="Bracket"
          summary={nextBracket ? `Your next: ${nextBracket.label}` : inBracket ? 'Your bracket matches are done' : 'The full draw'}
        >
          <Bracket matches={bracket} highlightTeamId={teamId} />
        </Expandable>
      )}
      {data.tournament.is_demo && <DemoInbox tournamentId={id} teamId={teamId} timeZone={tz} />}
    </div>
  );
}

/** "Estimated wait: about 25 minutes" for a queued match (see lib/waitTime). */
function EstimatedWait({ data, matchId, now }: { data: Awaited<ReturnType<typeof load>>; matchId: string; now: number }) {
  const minute = Math.floor(now / 60_000);
  const wait = useMemo(
    () =>
      estimateWait(
        {
          now: minute * 60_000,
          slotMinutes: data.tournament.match_slot_minutes,
          events: data.events,
          courts: data.courts,
          matches: data.matches,
          queue: data.queue,
        },
        matchId,
      ),
    [data, matchId, minute],
  );
  if (!wait) return null;
  return <p className="text-2xl font-semibold">Estimated wait: {formatWaitRange(wait)}</p>;
}

/** What this team should do right now, in the five match-day steps. */
function MatchDayPanel({
  tournamentId,
  team,
  mine,
  onCourt,
  next,
  nextQueue,
  wait,
  now,
}: {
  tournamentId: string;
  team: Team;
  mine: MatchDetails[];
  onCourt?: MatchDetails;
  next?: MatchDetails;
  nextQueue?: QueueRow;
  /** The estimated wait line, when it can be estimated. */
  wait?: ReactNode;
  now: number;
}) {
  const [myTeam, setMyTeam] = useMyTeam(tournamentId);
  const scoreCode = useScoreCode(onCourt?.id);
  const staff = useStaffAccess(tournamentId);
  // Scores go in right here: with the code from the player's text link (it
  // proves they're in the match), or as tournament staff.
  const enterScore =
    onCourt && scoreCode
      ? (games: [number, number][]) => reportScoreByCode(scoreCode, games)
      : onCourt && staff.role
        ? (games: [number, number][]) => reportScore(onCourt.id, games)
        : null;
  const allDone = mine.length > 0 && mine.every((m) => m.status === 'completed');
  const step = allDone ? 4 : onCourt ? 2 : !team.checked_in_at ? 0 : 1;
  const capitalized = (text: string) => text.replace(/^./, (c) => c.toUpperCase());

  return (
    <section className="flex flex-col gap-4" aria-label="Your match day">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-3xl">Match day</h3>
        {myTeam === team.id ? (
          <Button size="sm" variant="ghost" onClick={() => setMyTeam(null)}>
            <Icon name="check" /> Saved as my team
          </Button>
        ) : (
          <Button size="sm" onClick={() => setMyTeam(team.id)}>
            This is my team
          </Button>
        )}
      </div>

      {mine.length > 0 && (
        <MatchSteps
          current={step}
          hints={{
            0: team.checked_in_at ? undefined : 'At the front desk. Both players check in.',
            1: nextQueue ? `You’re number ${nextQueue.queue_rank} in line. We’ll text you the court.` : undefined,
            2: onCourt ? `Go to ${onCourt.court_name} now and play. ${capitalized(onCourt.format_text)}.` : undefined,
          }}
        />
      )}

      {onCourt ? (
        <Card className="flex flex-col gap-4 p-5 text-center">
          <p className="text-lg font-semibold">Your match is on</p>
          <CourtSign name={onCourt.court_name ?? ''} />
          <p className="text-xl">
            <span className="font-semibold">{onCourt.team1_name}</span> <span className="text-muted">vs</span>{' '}
            <span className="font-semibold">{onCourt.team2_name}</span>
          </p>
          <FormatLine text={onCourt.format_text} />
          <p className="text-called">
            Called {minutesSince(onCourt.assigned_at, now)} min ago. Head to the court and start; enter the score
            {enterScore ? ' below' : ''} when you finish.
          </p>
          {enterScore ? (
            <div className="border-t border-border pt-4 text-left">
              <h4 className="text-2xl">Enter the score</h4>
              <p className="mb-3 text-muted">When you finish. Only one player needs to do this.</p>
              <ScoreEntry
                key={onCourt.id}
                team1={onCourt.team1_name ?? ''}
                team2={onCourt.team2_name ?? ''}
                rules={rulesOf(onCourt)}
                onSubmit={enterScore}
              />
            </div>
          ) : (
            <p className="rounded-xl bg-surface-2 px-4 py-3 text-left">
              <b>To enter the score:</b> tap the link in the text we sent you, or tell the front desk.
            </p>
          )}
          {onCourt.court_stream_url && <StreamEmbed url={onCourt.court_stream_url} title={`${onCourt.court_name} live`} />}
        </Card>
      ) : next ? (
        <Card className="flex flex-col gap-2 p-5">
          <p className="text-lg font-semibold">Your next match</p>
          {nextQueue && (
            <p className="font-display text-6xl leading-none font-extrabold uppercase">
              {nextQueue.queue_rank === 1 ? 'You’re next' : `#${nextQueue.queue_rank} in line`}
            </p>
          )}
          {wait}
          <p className="text-xl">
            {next.team1_name} <span className="text-muted">vs</span> {next.team2_name}
          </p>
          <p className="text-muted">{next.label}</p>
          <div className="flex flex-wrap items-center gap-3">
            <FormatLine text={next.format_text} />
            {nextQueue && <QueueStatus row={nextQueue} />}
          </div>
          <p className="text-muted">Stay nearby. We’ll text you the court number when it’s your turn.</p>
        </Card>
      ) : (
        <Card className="p-5">
          <p className="text-lg">
            {mine.some((m) => m.status === 'waiting')
              ? 'Your next match depends on other results. Check back soon.'
              : allDone
                ? 'All your matches are done. Thanks for playing!'
                : 'Your schedule hasn’t been built yet.'}
          </p>
        </Card>
      )}
    </section>
  );
}
