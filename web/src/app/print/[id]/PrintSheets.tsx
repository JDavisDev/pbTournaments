'use client';

// Paper backup, printed ahead of time: a scoresheet per match for the courts,
// and the draw for the desk. Scores written down go in later from the division
// page, even for a match that never went on a court here.
import { useSearchParams } from 'next/navigation';
import { use, useState } from 'react';
import { Button, Check, Empty, Select, Spinner } from '@/components/ui';
import { getEvents, getMatches, getTeams, getTournament } from '@/lib/api';
import { formatDate, formatScore, isPlayable, poolName, venueLine } from '@/lib/format';
import { useLoad } from '@/lib/hooks';
import type { MatchDetails, Team, TournamentEvent } from '@/lib/types';

type Kind = 'scoresheets' | 'draws';

async function load(id: string) {
  const [tournament, events, matches, teams] = await Promise.all([getTournament(id), getEvents(id), getMatches(id), getTeams(id)]);
  return { tournament, events, matches, teams };
}

const inPlayOrder = (a: MatchDetails, b: MatchDetails) =>
  Number(a.stage === 'bracket') - Number(b.stage === 'bracket') || a.pool - b.pool || a.wave - b.wave || a.position - b.position;

export function PrintSheets({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const data = useLoad(() => load(id), [id]);
  const [event, setEvent] = useState(useSearchParams().get('event') ?? '');
  const [kind, setKind] = useState<Kind>('scoresheets');
  const [finished, setFinished] = useState(false);

  if (data.error) return <Empty>{data.error}</Empty>;
  if (!data.data) return <Spinner />;
  const { tournament: t, events, matches, teams } = data.data;
  const shown = events.filter((e) => !event || e.id === event);
  const inEvent = (e: TournamentEvent) => matches.filter((m) => m.event_id === e.id && isPlayable(m)).sort(inPlayOrder);
  const sheets = shown.flatMap(inEvent).filter((m) => finished || m.status !== 'completed');

  return (
    <div className="mx-auto max-w-5xl p-6 print:max-w-none print:p-0">
      <div className="mb-6 flex flex-wrap items-center gap-3 print:hidden">
        <Select aria-label="Division" className="min-w-48" value={event} onChange={(e) => setEvent(e.target.value)}>
          <option value="">All divisions</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
        <Select aria-label="What to print" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="scoresheets">Scoresheets</option>
          <option value="draws">Draws</option>
        </Select>
        {kind === 'scoresheets' && <Check label="Include finished matches" checked={finished} onChange={setFinished} />}
        <Button variant="primary" className="ml-auto" onClick={() => window.print()}>
          Print
        </Button>
      </div>

      {kind === 'scoresheets' ? (
        sheets.length === 0 ? (
          <Empty>No matches to print yet. A division’s matches appear once its schedule is built.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {sheets.map((m) => (
              <Scoresheet key={m.id} m={m} tournament={t.name} />
            ))}
          </div>
        )
      ) : (
        <div className="flex flex-col gap-8">
          <header>
            <h1 className="text-3xl">{t.name}</h1>
            <p>{[formatDate(t.starts_on), venueLine(t)].filter(Boolean).join(' · ')}</p>
          </header>
          {shown.map((e) => (
            <Draw key={e.id} event={e} matches={inEvent(e)} teams={teams.filter((x) => x.event_id === e.id && !x.withdrawn_at)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Scoresheet({ m, tournament }: { m: MatchDetails; tournament: string }) {
  const games = Array.from({ length: m.best_of }, (_, i) => i);
  return (
    <section className="break-inside-avoid rounded border border-black p-3 text-sm">
      <p className="text-xs">{tournament}</p>
      <h2 className="text-lg leading-tight">
        {m.event_name} · {m.label}
      </h2>
      <p className="mb-2 text-xs">{m.format_text}</p>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="border border-black px-2 py-1 text-left font-medium">Team</th>
            {games.map((g) => (
              <th key={g} className="w-14 border border-black px-1 py-1 font-medium">
                {m.best_of === 1 ? 'Score' : `G${g + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[m.team1_name, m.team2_name].map((name, slot) => (
            <tr key={slot}>
              <td className="h-10 border border-black px-2 py-1 font-semibold">{name}</td>
              {games.map((g) => (
                <td key={g} className="border border-black text-center">
                  {m.games?.[g]?.[slot] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 flex gap-4">
        <span className="flex-1 border-b border-black pb-1">Court</span>
        <span className="flex-[2] border-b border-black pb-1">Winner initials</span>
      </p>
    </section>
  );
}

function Draw({ event, matches, teams }: { event: TournamentEvent; matches: MatchDetails[]; teams: Team[] }) {
  const pools = [...new Set(teams.map((t) => t.pool).filter((p): p is number => p !== null))].sort((a, b) => a - b);
  const stages = [...new Set(matches.map((m) => (m.stage === 'pool' ? poolName(m.pool) : 'Bracket')))];
  return (
    <section>
      <h2 className="mb-2 text-2xl">{event.name}</h2>
      {matches.length === 0 && <p className="mb-2">The schedule isn’t built yet.</p>}
      {pools.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-8 text-sm">
          {pools.map((pool) => (
            <div key={pool} className="break-inside-avoid">
              <h3 className="font-semibold">{poolName(pool)}</h3>
              <ol className="list-decimal pl-5">
                {teams
                  .filter((t) => t.pool === pool)
                  .map((t) => (
                    <li key={t.id}>{t.name}</li>
                  ))}
              </ol>
            </div>
          ))}
        </div>
      )}
      {stages.map((stage) => (
        <div key={stage} className="mb-3">
          {stages.length > 1 && <h3 className="font-semibold">{stage}</h3>}
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {['Match', 'Team', 'Team', 'Score', 'Court'].map((h, i) => (
                  <th key={i} className="border border-black px-2 py-1 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matches
                .filter((m) => (m.stage === 'pool' ? poolName(m.pool) : 'Bracket') === stage)
                .map((m) => (
                  <tr key={m.id} className="break-inside-avoid">
                    <td className="border border-black px-2 py-1">{m.label}</td>
                    <td className="border border-black px-2 py-1">{m.team1_name}</td>
                    <td className="border border-black px-2 py-1">{m.team2_name}</td>
                    <td className="w-24 border border-black px-2 py-1">{m.status === 'completed' ? formatScore(m) : ''}</td>
                    <td className="w-16 border border-black px-2 py-1" />
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
      {event.pool_play === 'swiss' && <p className="text-sm">Swiss: later rounds are drawn as each round finishes.</p>}
    </section>
  );
}
