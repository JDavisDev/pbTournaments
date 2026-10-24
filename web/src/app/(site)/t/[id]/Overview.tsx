'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { CourtStatus } from '@/components/desk/CourtCard';
import { Card, Empty, Input, Spinner } from '@/components/ui';
import { getCourtBoard, getEvents, getMatches, getTeams } from '@/lib/api';
import { formatSummary, formatTime } from '@/lib/format';
import { useLiveTournament, useNow } from '@/lib/hooks';

async function load(id: string) {
  const [events, teams, matches, courts] = await Promise.all([getEvents(id), getTeams(id), getMatches(id), getCourtBoard(id)]);
  return { events, teams, matches, courts };
}

export function Overview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = useLiveTournament(id, () => load(id));
  const now = useNow();
  const [search, setSearch] = useState('');

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Spinner />;
  const { events, teams, matches, courts } = data;
  const found = search.length >= 2 ? teams.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())) : [];
  const eventName = (eventId: string) => events.find((e) => e.id === eventId)?.name ?? '';
  const activeCourts = courts.filter((c) => c.match_id);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-6">
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Find your matches</h2>
          <Input
            className="w-full"
            placeholder="Type a last name, e.g. Davis"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {found.length > 0 && (
            <ul className="mt-3 flex flex-col divide-y divide-border">
              {found.slice(0, 12).map((t) => (
                <li key={t.id}>
                  <Link href={`/t/${id}/teams/${t.id}`} className="flex justify-between py-2 hover:text-accent">
                    <span className="font-medium">{t.name}</span>
                    <span className="text-sm text-muted">{eventName(t.event_id)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {search.length >= 2 && found.length === 0 && <p className="mt-3 text-sm text-muted">No teams match.</p>}
        </Card>

        <section>
          <h2 className="mb-3 text-lg font-semibold">Events</h2>
          {events.length === 0 ? (
            <Empty>No events yet.</Empty>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {events.map((e) => {
                const ms = matches.filter((m) => m.event_id === e.id);
                const done = ms.filter((m) => m.status === 'completed').length;
                const pct = ms.length ? Math.round((done / ms.length) * 100) : 0;
                return (
                  <Link key={e.id} href={`/t/${id}/events/${e.id}`}>
                    <Card className="p-4 transition hover:border-accent">
                      <div className="font-semibold">{e.name}</div>
                      <div className="text-sm text-muted">
                        {formatSummary(e)} · {teams.filter((t) => t.event_id === e.id).length} teams
                        {e.not_before ? ` · starts ${formatTime(e.not_before)}` : ''}
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {ms.length ? `${done} of ${ms.length} matches played` : 'Schedule not built yet'}
                      </div>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <aside>
        <h2 className="mb-3 text-lg font-semibold">On court now</h2>
        {activeCourts.length === 0 ? (
          <Empty>Nothing on court right now.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {activeCourts.map((c) => (
              <Card key={c.court_id} className="p-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{c.court_name}</span>
                  <CourtStatus court={c} now={now} />
                </div>
                <p className="mt-1 text-sm">
                  {c.team1_name} <span className="text-muted">v</span> {c.team2_name}
                </p>
                <p className="text-xs text-muted">
                  {c.event_name} · {c.label}
                </p>
              </Card>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
