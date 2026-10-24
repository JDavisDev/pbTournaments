'use client';

import Link from 'next/link';
import { use } from 'react';
import { Bracket } from '@/components/Bracket';
import { ConnectNotice } from '@/components/ConnectNotice';
import { QueueStatus } from '@/components/desk/QueuePanel';
import { MatchRow } from '@/components/MatchRow';
import { StandingsTable } from '@/components/StandingsTable';
import { Card, Empty, Spinner } from '@/components/ui';
import { getEvents, getMatches, getQueue, getStandings, getTeams, getTournament } from '@/lib/api';
import { minutesSince, ordinal, poolName } from '@/lib/format';
import { useLiveTournament, useNow } from '@/lib/hooks';
import type { MatchDetails } from '@/lib/types';

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
    .filter((m) => m.team1_id === teamId || m.team2_id === teamId)
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
  const poolMatches = data.matches.filter((m) => m.event_id === event.id && m.stage === 'pool' && m.pool === team.pool);
  const rounds = [...new Set(poolMatches.map((m) => m.round))].sort((a, b) => a - b);
  const byes = rounds.filter((r) => !poolMatches.some((m) => m.round === r && (m.team1_id === teamId || m.team2_id === teamId)));

  const standings = data.standings.filter((s) => s.event_id === event.id && s.pool === team.pool);
  const myStanding = standings.find((s) => s.team_id === teamId);
  const bracket = data.matches.filter((m) => m.event_id === event.id && m.stage === 'bracket');
  const inBracket = bracket.some((m) => m.team1_id === teamId || m.team2_id === teamId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold">{team.name}</h2>
        <p className="text-muted">
          <Link href={`/t/${id}/events/${event.id}`} className="hover:underline">
            {event.name}
          </Link>
          {team.pool ? ` · ${poolName(team.pool)}` : ''}
          {team.seed ? ` · Seed ${team.seed}` : ''} · {wins}–{losses}
          {myStanding ? ` · ${ordinal(myStanding.pool_rank)} in pool` : ''}
        </p>
      </div>

      {onCourt ? (
        <Card className={`border-2 p-5 ${onCourt.status === 'in_progress' ? 'border-live bg-live-soft/40' : 'border-called bg-called-soft/40'}`}>
          <p className="text-sm font-medium text-muted">{onCourt.status === 'in_progress' ? 'Playing now' : 'You’re up!'}</p>
          <p className="mt-1 text-3xl font-bold">{onCourt.court_name}</p>
          <p className="mt-1">
            {onCourt.team1_name} <span className="text-muted">v</span> {onCourt.team2_name}
          </p>
          {onCourt.status === 'assigned' && (
            <p className="mt-1 text-sm text-called">Called {minutesSince(onCourt.assigned_at, now)} min ago. Head to the court.</p>
          )}
        </Card>
      ) : next && nextQueue ? (
        <Card className="p-5">
          <p className="text-sm font-medium text-muted">Next match</p>
          <p className="mt-1 text-2xl font-bold">#{nextQueue.queue_rank} in line</p>
          <p className="mt-1">
            {next.team1_name} <span className="text-muted">v</span> {next.team2_name}
            <span className="text-muted"> · {next.label}</span>
          </p>
          <div className="mt-2">
            <QueueStatus row={nextQueue} />
          </div>
          <p className="mt-2 text-sm text-muted">We’ll text you the court number when it’s your turn.</p>
        </Card>
      ) : (
        <Card className="p-5">
          <p className="text-muted">
            {mine.some((m) => m.status === 'waiting')
              ? 'Your next match depends on other results. Check back soon.'
              : mine.length && mine.every((m) => m.status === 'completed')
                ? 'All your matches are done.'
                : 'Your schedule hasn’t been built yet.'}
          </p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h3 className="mb-3 text-lg font-semibold">Schedule</h3>
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
            <h3 className="mb-3 text-lg font-semibold">{poolName(team.pool)} standings</h3>
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
          <h3 className="mb-3 text-lg font-semibold">Bracket</h3>
          <Bracket matches={bracket} highlightTeamId={teamId} />
        </section>
      )}
    </div>
  );
}
