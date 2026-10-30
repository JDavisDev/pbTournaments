'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { Linked } from '@/components/Announcement';
import { ConnectNotice } from '@/components/ConnectNotice';
import { CourtStatus } from '@/components/desk/CourtCard';
import { DivisionStatus, dayHeading, divisionDay, divisionState } from '@/components/DivisionStatus';
import { Expandable } from '@/components/Expandable';
import { Icon } from '@/components/Icon';
import { useMyTeam } from '@/components/MatchDay';
import { Button, Empty, Input, LinkButton, Select, Spinner } from '@/components/ui';
import { getCourtBoard, getEvents, getMatches, getTeams, getTournament } from '@/lib/api';
import { describeDivision } from '@/lib/eligibility';
import { StreamEmbed, WatchChip } from '@/components/StreamEmbed';
import { formatTime, isPlayable, priceSummary, registrationOpen } from '@/lib/format';
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
  const days = [...new Set(events.map((e) => divisionDay(e, tournament)))].sort();
  // The side column: what's on court during play, and the director's notes.
  const showCourts = tournament.status === 'live' || activeCourts.length > 0;
  const aside = showCourts || !!tournament.details;
  const closes =
    tournament.registration_closes_at &&
    new Date(tournament.registration_closes_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tournament.time_zone });

  return (
    <div className={`grid gap-10 ${aside ? 'lg:grid-cols-[1fr_22rem]' : ''}`}>
      <div className="flex min-w-0 flex-col gap-10">
        {tournament.image_data && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={tournament.image_data} alt="" className="max-h-72 w-full rounded-2xl object-cover" />
        )}
        {tournament.stream_url && <StreamEmbed url={tournament.stream_url} title={`${tournament.name} live`} />}
        {registrationOpen(tournament) && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-surface-2 p-5">
            <div>
              <h2 className="text-2xl">Registration is open</h2>
              <p className="text-muted">
                {priceSummary(tournament)}
                {closes && <span className="font-semibold text-text"> · registration closes {closes}</span>}
              </p>
            </div>
            <LinkButton variant="primary" href={`/t/${tournament.id}/register`}>
              Register
            </LinkButton>
          </div>
        )}
        {tournament.is_demo && !myTeam && (
          <div className="flex flex-col gap-3 rounded-2xl bg-called-soft p-5">
            <div>
              <h2 className="text-2xl">Play as a team</h2>
              <p className="text-muted">Practice tournament: see the day the way a team’s players do, with their court, texts and score entry.</p>
            </div>
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
          </div>
        )}
        {myTeam && (
          <div className="flex flex-col gap-2">
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
            {tournament.is_demo && (
              <button type="button" className="self-start text-sm text-muted underline hover:text-text" onClick={() => setMyTeam(null)}>
                Play as a different team
              </button>
            )}
          </div>
        )}

        <section className="flex flex-col gap-3">
          <label htmlFor="find-team" className="font-display text-3xl leading-tight font-bold uppercase">
            Find your matches
          </label>
          <Input
            id="find-team"
            className="h-14 w-full max-w-xl text-lg"
            placeholder="Type your last name, e.g. Davis"
            autoComplete="family-name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {found.length > 0 && (
            <ul className="flex max-w-xl flex-col divide-y divide-border">
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
          {search.length >= 2 && found.length === 0 && <p className="text-sm text-muted">No teams match.</p>}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-3xl">Divisions</h2>
          {events.length === 0 ? (
            <Empty>No divisions yet.</Empty>
          ) : (
            days.map((day) => (
              <div key={day} className="flex flex-col gap-3">
                {days.length > 1 && <h3 className="text-xl">{dayHeading(day)}</h3>}
                <div className={`grid gap-3 sm:grid-cols-2 ${aside ? '' : 'xl:grid-cols-3'}`}>
                  {events
                    .filter((e) => divisionDay(e, tournament) === day)
                    .map((e) => {
                      const all = matches.filter((m) => m.event_id === e.id);
                      const ms = all.filter(isPlayable);
                      const done = ms.filter((m) => m.status === 'completed').length;
                      const pct = ms.length ? Math.round((done / ms.length) * 100) : 0;
                      return (
                        <Link
                          key={e.id}
                          href={`/t/${id}/events/${e.id}`}
                          className="flex flex-col gap-1 rounded-2xl border border-border p-4 transition hover:border-text"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <span className="text-lg font-semibold">{e.name}</span>
                            <DivisionStatus state={divisionState(e, all)} startedAt={e.started_at} timeZone={tournament.time_zone} />
                          </div>
                          <p className="text-sm text-muted">
                            {describeDivision(e)} · {teams.filter((t) => t.event_id === e.id).length} teams
                            {e.not_before && tournament.times_published_at && !e.started_at
                              ? ` · starts ${formatTime(e.not_before, tournament.time_zone)}`
                              : ''}
                          </p>
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                            <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
                          </div>
                          <p className="text-sm text-muted">{ms.length ? `${done} of ${ms.length} matches played` : 'Schedule builds when it starts'}</p>
                        </Link>
                      );
                    })}
                </div>
              </div>
            ))
          )}
        </section>

        {tournament.refund_policy?.trim() && (
          <Expandable id="refund-policy" title="Refund policy" summary="If you need to withdraw">
            <p className="whitespace-pre-wrap">{tournament.refund_policy}</p>
          </Expandable>
        )}
      </div>

      {aside && (
        <aside className="flex flex-col gap-10">
          {showCourts && (
            <section className="flex flex-col gap-3">
              <h2 className="text-2xl">On court now</h2>
              {activeCourts.length === 0 ? (
                <p className="text-muted">Nothing on court right now.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
                  {activeCourts.map((c) => (
                    <li key={c.court_id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{c.court_name}</span>
                        <span className="flex items-center gap-1.5">
                          {c.stream_url && <WatchChip url={c.stream_url} />}
                          <CourtStatus court={c} now={now} />
                        </span>
                      </div>
                      <p className="mt-0.5 text-sm">
                        {c.team1_name} <span className="text-muted">v</span> {c.team2_name}
                      </p>
                      <p className="text-sm text-muted">
                        {c.event_name} · {c.label}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {tournament.details && (
            <section className="flex flex-col gap-3">
              <h2 className="text-2xl">About</h2>
              <p className="whitespace-pre-wrap">
                <Linked text={tournament.details} />
              </p>
            </section>
          )}
        </aside>
      )}
    </div>
  );
}
