'use client';

import { use } from 'react';
import { Bracket } from '@/components/Bracket';
import { ConnectNotice } from '@/components/ConnectNotice';
import { MatchRow } from '@/components/MatchRow';
import { StandingsTable } from '@/components/StandingsTable';
import { Empty, Spinner } from '@/components/ui';
import { getEvents, getMatches, getQueue, getStandings, getTournament } from '@/lib/api';
import { formatSummary, poolName } from '@/lib/format';
import { useLiveTournament } from '@/lib/hooks';

async function load(id: string) {
  const [tournament, events, matches, standings, queue] = await Promise.all([
    getTournament(id),
    getEvents(id),
    getMatches(id),
    getStandings(id),
    getQueue(id),
  ]);
  return { tournament, events, matches, standings, queue };
}

export function EventView({ params }: { params: Promise<{ id: string; eventId: string }> }) {
  const { id, eventId } = use(params);
  const { data, error } = useLiveTournament(id, () => load(id));

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Spinner />;
  const event = data.events.find((e) => e.id === eventId);
  if (!event) return <Empty>Event not found.</Empty>;

  const matches = data.matches.filter((m) => m.event_id === eventId);
  const standings = data.standings.filter((s) => s.event_id === eventId);
  const pools = [...new Set(standings.map((s) => s.pool))].sort((a, b) => a - b);
  const bracket = matches.filter((m) => m.stage === 'bracket');
  const poolMatches = matches.filter((m) => m.stage === 'pool').sort((a, b) => a.pool - b.pool || a.round - b.round || a.position - b.position);
  const queueById = new Map(data.queue.map((q) => [q.match_id, q]));
  const advance = event.format === 'pools_to_bracket' ? event.advance_per_pool : 0;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-semibold">{event.name}</h2>
        <p className="text-muted">{formatSummary(event)}</p>
      </div>

      {matches.length === 0 && <Empty>The schedule for this event hasn’t been built yet.</Empty>}

      {pools.length > 0 && (
        <section>
          <h3 className="mb-3 text-lg font-semibold">Standings</h3>
          <div className="grid gap-4 lg:grid-cols-2">
            {pools.map((pool) => (
              <div key={pool}>
                {pools.length > 1 && <h4 className="mb-2 font-medium">{poolName(pool)}</h4>}
                <StandingsTable rows={standings.filter((s) => s.pool === pool)} tournamentId={id} advance={advance} />
              </div>
            ))}
          </div>
          {advance > 0 && (
            <p className="mt-2 text-xs text-muted">
              Top {advance} in each pool advance. Ties break on head-to-head, then point differential, then points scored.
            </p>
          )}
        </section>
      )}

      {bracket.length > 0 && (
        <section>
          <h3 className="mb-3 text-lg font-semibold">Bracket</h3>
          {event.format === 'pools_to_bracket' && !event.playoffs_seeded_at && (
            <p className="mb-3 text-sm text-muted">Seeds are filled in when pool play finishes.</p>
          )}
          <Bracket matches={bracket} />
        </section>
      )}

      {poolMatches.length > 0 && (
        <section>
          <h3 className="mb-3 text-lg font-semibold">Pool matches</h3>
          <div className="grid gap-4 lg:grid-cols-2">
            {pools.map((pool) => (
              <div key={pool} className="divide-y divide-border rounded-xl border border-border bg-surface">
                {pools.length > 1 && <h4 className="px-3 py-2 text-sm font-semibold">{poolName(pool)}</h4>}
                {poolMatches
                  .filter((m) => m.pool === pool)
                  .map((m) => (
                    <MatchRow key={m.id} match={m} queueRow={queueById.get(m.id)} timeZone={data.tournament.time_zone} />
                  ))}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
