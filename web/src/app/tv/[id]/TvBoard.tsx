'use client';

import { use } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { courtState, type CourtState } from '@/components/desk/CourtCard';
import { getCourtBoard, getMatches, getQueue, getTournament } from '@/lib/api';
import { formatScore, formatTime, minutesSince } from '@/lib/format';
import { useLiveTournament, useNow } from '@/lib/hooks';

async function load(id: string) {
  const [tournament, courts, queue, matches] = await Promise.all([
    getTournament(id),
    getCourtBoard(id),
    getQueue(id),
    getMatches(id),
  ]);
  return { tournament, courts, queue, matches };
}

const tile: Record<CourtState, string> = {
  paused: 'border-border opacity-50',
  open: 'border-border',
  called: 'border-called bg-called-soft',
  late: 'border-late bg-late-soft',
  playing: 'border-live bg-live-soft',
};

const caption: Record<CourtState, string> = {
  paused: 'Closed',
  open: 'Open',
  called: 'Report to court',
  late: 'Report to court now',
  playing: 'Playing',
};

export function TvBoard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = useLiveTournament(id, () => load(id), 10_000);
  const now = useNow(5_000);

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <p className="p-10 text-2xl text-muted">{error}</p>;
  if (!data) return null;
  const { tournament: t, courts, queue, matches } = data;
  const upNext = queue.slice(0, 10);
  const recent = matches
    .filter((m) => m.status === 'completed')
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
    .slice(0, 6);
  const cols = courts.length > 12 ? 'grid-cols-4' : courts.length > 6 ? 'grid-cols-3' : 'grid-cols-2';

  return (
    <div className="flex h-screen flex-col gap-4 p-5">
      <header className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">{t.name}</h1>
        <div className="tnum text-3xl font-semibold text-muted">{formatTime(new Date(now).toISOString(), t.time_zone)}</div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_24rem] gap-5">
        <div className={`grid min-h-0 auto-rows-fr gap-3 ${cols}`}>
          {courts.map((c) => {
            const state = courtState(c, now);
            return (
              <div key={c.court_id} className={`flex min-h-0 flex-col rounded-2xl border-2 p-4 ${tile[state]}`}>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-bold">{c.court_name}</span>
                  <span
                    className={`text-sm font-semibold uppercase ${
                      state === 'playing' ? 'text-live' : state === 'late' ? 'text-late' : state === 'called' ? 'text-called' : 'text-muted'
                    }`}
                  >
                    {caption[state]}
                    {state === 'playing' && ` · ${minutesSince(c.started_at, now)}m`}
                  </span>
                </div>
                {c.match_id && (
                  <div className="mt-2 flex flex-1 flex-col justify-center">
                    <p className="text-xl leading-tight font-semibold">{c.team1_name}</p>
                    <p className="text-sm text-muted">vs</p>
                    <p className="text-xl leading-tight font-semibold">{c.team2_name}</p>
                    <p className="mt-2 truncate text-sm text-muted">
                      {c.event_name} · {c.label}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <aside className="flex min-h-0 flex-col gap-5">
          <section className="min-h-0 flex-1 overflow-hidden">
            <h2 className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase">Up next</h2>
            <ol className="flex flex-col gap-2">
              {upNext.map((q) => (
                <li
                  key={q.match_id}
                  className={`rounded-xl border px-3 py-2 ${q.blocked_reason ? 'border-border' : 'border-accent bg-accent-soft'}`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="tnum font-bold text-muted">{q.queue_rank}</span>
                    <span className="truncate text-xs text-muted">
                      {q.event_name} · {q.label}
                    </span>
                  </div>
                  <p className="leading-snug font-medium">
                    {q.team1_name} <span className="text-muted">v</span> {q.team2_name}
                  </p>
                </li>
              ))}
              {upNext.length === 0 && <li className="text-muted">Queue is empty</li>}
            </ol>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase">Just finished</h2>
            <ul className="flex flex-col gap-1.5">
              {recent.map((m) => (
                <li key={m.id} className="text-sm">
                  <span className={m.winner_team_id === m.team1_id ? 'font-semibold' : 'text-muted'}>{m.team1_name}</span>
                  <span className="text-muted"> v </span>
                  <span className={m.winner_team_id === m.team2_id ? 'font-semibold' : 'text-muted'}>{m.team2_name}</span>
                  <span className="tnum ml-2">{formatScore(m)}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
