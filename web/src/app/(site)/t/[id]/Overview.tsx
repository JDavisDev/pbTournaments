'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { CourtStatus } from '@/components/desk/CourtCard';
import { DivisionStatus, dayHeading, divisionDay, divisionState } from '@/components/DivisionStatus';
import { Expandable } from '@/components/Expandable';
import { Icon } from '@/components/Icon';
import { useMyTeam } from '@/components/MatchDay';
import { Button, Card, Empty, Input, Select, Spinner } from '@/components/ui';
import { getCourtBoard, getEvents, getMatches, getTeams, getTournament } from '@/lib/api';
import { describeDivision } from '@/lib/eligibility';
import { StreamEmbed, WatchChip } from '@/components/StreamEmbed';
import { formatMoney, formatTime, isPlayable, registrationPrice } from '@/lib/format';
import { useLiveTournament, useNow } from '@/lib/hooks';

async function load(id: string) {
  const [tournament, events, teams, matches, courts] = await Promise.all([
    getTournament(id),
    getEvents(id),
    getTeams(id),
    getMatches(id),
    getCourtBoard(id),
  ]);
  return { tournament, events, teams, matches, courts };
}

export function Overview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = useLiveTournament(id, () => load(id));
  const now = useNow();
  const [search, setSearch] = useState('');
  const [myTeamId, setMyTeam] = useMyTeam(id);
  const [playAs, setPlayAs] = useState('');
  const router = useRouter();

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Spinner />;
  const { tournament, events, teams, matches, courts } = data;
  const found = search.length >= 2 ? teams.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())) : [];
  const eventName = (eventId: string) => events.find((e) => e.id === eventId)?.name ?? '';
  const activeCourts = courts.filter((c) => c.match_id);
  const myTeam = teams.find((t) => t.id === myTeamId);
  const myLive = myTeam && courts.find((c) => c.match_id && (c.team1_id === myTeam.id || c.team2_id === myTeam.id));

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-6">
        {tournament.image_data && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={tournament.image_data} alt="" className="max-h-72 w-full rounded-2xl object-cover" />
        )}
        {tournament.stream_url && <StreamEmbed url={tournament.stream_url} title={`${tournament.name} live`} />}
        {tournament.status === 'registration' && (
          <Card className="flex flex-wrap items-center justify-between gap-3 border-accent/50 bg-accent-soft/40 p-4">
            <div>
              <h2 className="text-xl">Registration is open</h2>
              <p className="text-sm text-muted">
                {formatMoney(registrationPrice(tournament, 1))} first event, {formatMoney(registrationPrice(tournament, 2) - registrationPrice(tournament, 1))} each extra
              </p>
              {tournament.registration_closes_at && (
                <p className="text-sm font-semibold">
                  Closes {new Date(tournament.registration_closes_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tournament.time_zone })}
                </p>
              )}
            </div>
            <Link href={`/t/${tournament.id}/register`} className="rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-text">
              Register
            </Link>
          </Card>
        )}
        {tournament.is_demo && !myTeam && (
          <Card className="flex flex-col gap-3 border-2 border-dashed border-called/60 p-5">
            <h2 className="text-3xl">Play as a team</h2>
            <p className="text-muted">
              Practice tournament: pick a team to see the day the way its players do, with their court, format, texts and
              score entry.
            </p>
            <div className="flex flex-wrap gap-2">
              <Select className="min-w-0 flex-1" value={playAs} onChange={(e) => setPlayAs(e.target.value)} aria-label="Team to play as">
                <option value="">Choose a team…</option>
                {events.map((e) => (
                  <optgroup key={e.id} label={e.name}>
                    {teams
                      .filter((t) => t.event_id === e.id && !t.withdrawn_at)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
              <Button
                variant="primary"
                disabled={!playAs}
                onClick={() => {
                  setMyTeam(playAs);
                  router.push(`/t/${id}/teams/${playAs}`);
                }}
              >
                Play as this team
              </Button>
            </div>
          </Card>
        )}
        {myTeam && (
          <Link
            href={`/t/${id}/teams/${myTeam.id}`}
            className={`flex items-center justify-between gap-4 rounded-2xl p-5 ${myLive ? 'bg-called text-white' : 'bg-accent text-accent-text'}`}
          >
            <span>
              <span className="block text-lg">Your team</span>
              <span className="block font-display text-4xl leading-none font-extrabold uppercase">{myTeam.name}</span>
              <span className="mt-1 block text-lg font-semibold">
                {myLive ? `Your match is on ${myLive.court_name} now` : 'See your match day'}
              </span>
            </span>
            <Icon name="arrow" className="h-8 w-8" />
          </Link>
        )}
        {myTeam && tournament.is_demo && (
          <button type="button" className="-mt-4 self-start text-sm text-muted underline hover:text-text" onClick={() => setMyTeam(null)}>
            Play as a different team
          </button>
        )}
        <Card className="p-5">
          <label htmlFor="find-team" className="mb-2 block font-display text-3xl font-bold uppercase">
            Find your matches
          </label>
          <Input
            id="find-team"
            className="h-14 w-full text-lg"
            placeholder="Type your last name, e.g. Davis"
            autoComplete="family-name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {found.length > 0 && (
            <ul className="mt-3 flex flex-col divide-y divide-border">
              {found.slice(0, 12).map((t) => (
                <li key={t.id}>
                  <Link href={`/t/${id}/teams/${t.id}`} className="flex min-h-12 items-center justify-between gap-3 py-2 hover:underline">
                    <span className="text-lg font-semibold">{t.name}</span>
                    <span className="text-right text-muted">{eventName(t.event_id)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {search.length >= 2 && found.length === 0 && <p className="mt-3 text-sm text-muted">No teams match.</p>}
        </Card>

        <Expandable id="all-divisions" title="All divisions" summary={`${events.length} division${events.length === 1 ? '' : 's'}`}>
          {events.length === 0 ? (
            <Empty>No events yet.</Empty>
          ) : (
            <div className="flex flex-col gap-5">
              {[...new Set(events.map((e) => divisionDay(e, tournament)))].sort().map((day, _, days) => (
                <div key={day}>
                  {days.length > 1 && <h3 className="mb-2 text-2xl">{dayHeading(day)}</h3>}
                  <div className="grid gap-3 sm:grid-cols-2">
                    {events
                      .filter((e) => divisionDay(e, tournament) === day)
                      .map((e) => {
                        const all = matches.filter((m) => m.event_id === e.id);
                        const ms = all.filter(isPlayable);
                        const done = ms.filter((m) => m.status === 'completed').length;
                        const pct = ms.length ? Math.round((done / ms.length) * 100) : 0;
                        return (
                          <Link key={e.id} href={`/t/${id}/events/${e.id}`}>
                            <Card className="p-4 transition hover:border-accent">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="font-semibold">{e.name}</div>
                                <DivisionStatus state={divisionState(e, all)} startedAt={e.started_at} timeZone={tournament.time_zone} />
                              </div>
                              <div className="text-sm text-muted">
                                {describeDivision(e)} · {teams.filter((t) => t.event_id === e.id).length} teams
                                {e.not_before && tournament.times_published_at && !e.started_at
                                  ? ` · starts ${formatTime(e.not_before, tournament.time_zone)}`
                                  : ''}
                              </div>
                              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
                                <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
                              </div>
                              <div className="mt-1 text-xs text-muted">
                                {ms.length ? `${done} of ${ms.length} matches played` : 'Schedule not built yet'}
                              </div>
                            </Card>
                          </Link>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Expandable>

        {tournament.refund_policy?.trim() && (
          <Expandable id="refund-policy" title="Refund policy" summary="If you need to withdraw">
            <p className="whitespace-pre-wrap">{tournament.refund_policy}</p>
          </Expandable>
        )}
      </div>

      <aside>
        <Expandable
          id="on-court-now"
          title="On court now"
          summary={activeCourts.length ? `${activeCourts.length} match${activeCourts.length === 1 ? '' : 'es'} on court` : 'Nothing on court'}
        >
          {activeCourts.length === 0 ? (
            <Empty>Nothing on court right now.</Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {activeCourts.map((c) => (
                <Card key={c.court_id} className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{c.court_name}</span>
                    <span className="flex items-center gap-1.5">
                      {c.stream_url && <WatchChip url={c.stream_url} />}
                      <CourtStatus court={c} now={now} />
                    </span>
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
        </Expandable>
      </aside>
    </div>
  );
}
