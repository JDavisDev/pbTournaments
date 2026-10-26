'use client';

import Link from 'next/link';
import { use } from 'react';
import { Bracket } from '@/components/Bracket';
import { ConnectNotice } from '@/components/ConnectNotice';
import { DemoInbox } from '@/components/DemoTools';
import { QueueStatus } from '@/components/desk/QueuePanel';
import { MatchRow } from '@/components/MatchRow';
import { StandingsTable } from '@/components/StandingsTable';
import { Icon } from '@/components/Icon';
import { CourtSign, FormatLine, MatchSteps, useMyTeam, useScoreCode } from '@/components/MatchDay';
import { StreamEmbed } from '@/components/StreamEmbed';
import { Button, Card, Empty, LinkButton, Spinner } from '@/components/ui';
import { getEvents, getMatches, getQueue, getStandings, getTeams, getTournament } from '@/lib/api';
import { isPlayable, minutesSince, ordinal, poolName } from '@/lib/format';
import { useLiveTournament, useNow } from '@/lib/hooks';
import type { MatchDetails, QueueRow, Team } from '@/lib/types';

async function load(id: string) {
  const [tournament, events, teams, matches, standings, queue] = await Promise.all([
    getTournament(id),
    getEvents(id),
    getTeams(id),
    getMatches(id),
    getStandings(id),
    getQueue(id),
  ]);
  return { tournament, events, teams, matches, standings, queue };
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
  const inBracket = bracket.some((m) => m.team1_id === teamId || m.team2_id === teamId);

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

      <MatchDayPanel tournamentId={id} team={team} mine={mine} onCourt={onCourt} next={next} nextQueue={nextQueue} now={now} />
      {data.tournament.is_demo && <DemoInbox tournamentId={id} teamId={teamId} timeZone={tz} />}

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h3 className="mb-3 text-3xl">Schedule</h3>
          {byes.length > 0 && (
            <p className="mb-2 text-sm text-muted">
              Bye in round{byes.length > 1 ? 's' : ''} {byes.join(', ')}.
            </p>
          )}
          {mine.length === 0 ? (
            <Empty>No matches yet.</Empty>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border bg-surface">
              {mine.map((m) => (
                <MatchRow key={m.id} match={m} queueRow={queueById.get(m.id)} timeZone={tz} perspectiveTeamId={teamId} />
              ))}
            </div>
          )}
        </section>

        {standings.length > 0 && (
          <section>
            <h3 className="mb-3 text-3xl">{poolName(team.pool)} standings</h3>
            <StandingsTable
              rows={standings}
              tournamentId={id}
              advance={event.format === 'pools_to_bracket' ? event.advance_per_pool : 0}
              highlightTeamId={teamId}
            />
          </section>
        )}
      </div>

      {bracket.length > 0 && (inBracket || event.format === 'single_elim') && (
        <section>
          <h3 className="mb-3 text-3xl">Bracket</h3>
          <Bracket matches={bracket} highlightTeamId={teamId} />
        </section>
      )}
    </div>
  );
}

/** What this team should do right now, in the five match-day steps. */
function MatchDayPanel({
  tournamentId,
  team,
  mine,
  onCourt,
  next,
  nextQueue,
  now,
}: {
  tournamentId: string;
  team: Team;
  mine: MatchDetails[];
  onCourt?: MatchDetails;
  next?: MatchDetails;
  nextQueue?: QueueRow;
  now: number;
}) {
  const [myTeam, setMyTeam] = useMyTeam(tournamentId);
  const scoreCode = useScoreCode(onCourt?.id);
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
            Called {minutesSince(onCourt.assigned_at, now)} min ago. Head to the court and start; enter the score when you finish.
          </p>
          {scoreCode ? (
            <LinkButton variant="primary" href={`/s/${scoreCode}`} className="h-14 text-lg">
              Enter the score <Icon name="arrow" />
            </LinkButton>
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
