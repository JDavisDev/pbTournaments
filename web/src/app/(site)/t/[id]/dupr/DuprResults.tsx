'use client';

// Results to DUPR, division by division: each one goes once a director has
// reviewed its results and made them final (on the division's page). Also
// takes a pasted list of confirmed ratings.
import Link from 'next/link';
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { DivisionDupr } from '@/components/DivisionDupr';
import { DivisionStatus, divisionState } from '@/components/DivisionStatus';
import { Icon } from '@/components/Icon';
import { Button, Card, Empty, ErrorText, Spinner, Textarea } from '@/components/ui';
import { getDuprResults, getEvents, getMatches, getTournament, importDuprRatings } from '@/lib/api';
import { parseRatings } from '@/lib/dupr';
import { formatDate } from '@/lib/format';
import { useAction, useLiveTournament, useStaffAccess } from '@/lib/hooks';

async function load(id: string) {
  const [tournament, events, matches, results] = await Promise.all([
    getTournament(id),
    getEvents(id),
    getMatches(id),
    getDuprResults(id),
  ]);
  return { tournament, events, matches, results };
}

export function DuprResults({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => load(id));

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>DUPR results are for this tournament’s directors.</Empty>;

  const { tournament: t, events, matches, results } = data;
  const rated = events.filter((e) => e.dupr_rated);
  const final = rated.filter((e) => e.finalized_at);
  const missing = [...new Set(results.flatMap((r) => r.missing_ids))].sort();

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      <section className="flex flex-col gap-5">
        <div>
          <h2 className="text-4xl">Results to DUPR</h2>
          <p className="mt-1 max-w-prose text-muted">
            A division’s results can go to DUPR once you’ve reviewed them and made them final on its page. Download the file, then
            upload it in your DUPR club: <b>Matches</b> → <b>Add Matches</b> → <b>Import Matches via CSV</b>. Forfeits and byes
            are left out.
          </p>
        </div>

        <ol className="grid gap-2 sm:grid-cols-3">
          <Step n={1} done={rated.length > 0 && final.length === rated.length} title="Divisions final">
            {final.length} of {rated.length}
          </Step>
          <Step n={2} done={missing.length === 0} title="Every player has a DUPR ID">
            {missing.length ? `${missing.length} missing` : 'All set'}
          </Step>
          <Step n={3} done={!!t.location} title="Venue and scoring set">
            {t.location ? (
              `${t.dupr_score_type === 'RALLY' ? 'Rally' : 'Side-out'} · ${t.location}`
            ) : (
              <Link href={`/t/${id}/setup`} className="underline">
                Add the venue in Settings
              </Link>
            )}
          </Step>
        </ol>

        {rated.length === 0 ? (
          <Empty>No division’s results go to DUPR. Turn on “DUPR rated” for a division in Settings.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {rated.map((e) =>
              e.finalized_at ? (
                <DivisionDupr
                  key={e.id}
                  tournament={t}
                  event={e}
                  rows={results.filter((r) => r.event_id === e.id)}
                  onChanged={reload}
                />
              ) : (
                <Card key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div>
                    <h3 className="text-2xl">{e.name}</h3>
                    <div className="mt-1">
                      <DivisionStatus
                        state={divisionState(
                          e,
                          matches.filter((m) => m.event_id === e.id),
                        )}
                        startedAt={e.started_at}
                        timeZone={t.time_zone}
                      />
                    </div>
                  </div>
                  <Link href={`/t/${id}/events/${e.id}`} className="font-medium underline">
                    {divisionState(
                      e,
                      matches.filter((m) => m.event_id === e.id),
                    ) === 'finished'
                      ? 'Review and finalize'
                      : 'Open division'}
                  </Link>
                </Card>
              ),
            )}
          </div>
        )}
      </section>

      <aside className="flex flex-col gap-4">
        <RatingsImport tournamentId={id} onDone={reload} />
        <Card className="p-5 text-sm">
          <h2 className="mb-2 text-xl">About the file</h2>
          <p className="text-muted">
            It follows DUPR’s club import template: one row per match, team A is the first team listed, up to five games. Event
            name: “{t.name} - division”. Date: the day each match finished ({formatDate(t.starts_on)}).
          </p>
          <p className="mt-2 text-muted">
            If DUPR changes its template, download a fresh one from the import screen and compare the column names.
          </p>
        </Card>
      </aside>
    </div>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className={`flex gap-3 rounded-2xl p-3 ${done ? 'bg-live-soft' : 'bg-surface-2'}`}>
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full font-display text-lg font-bold ${
          done ? 'bg-live text-white' : 'bg-surface text-text'
        }`}
        aria-hidden
      >
        {done ? <Icon name="check" /> : n}
      </span>
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="text-sm text-muted">{children}</span>
      </span>
    </li>
  );
}

/** Paste confirmed ratings (e.g. copied from DUPR) to update players by DUPR ID. */
function RatingsImport({ tournamentId, onDone }: { tournamentId: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ updated: number; unknown: string[] } | null>(null);
  const { busy, error, run } = useAction();
  const rows = parseRatings(text);
  return (
    <Card className="flex flex-col gap-3 p-5">
      <h2 className="text-xl">Update ratings</h2>
      <p className="text-sm text-muted">
        Paste DUPR IDs with current ratings, one player per line: <span className="font-mono">7K2QXW 3.82 3.60</span> (doubles,
        then singles). Players are matched by DUPR ID and their ratings marked as checked.
      </p>
      <Textarea
        rows={6}
        className="font-mono text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'7K2QXW 3.82 3.60\nAB12CD 4.05'}
      />
      <Button
        disabled={busy || rows.length === 0}
        onClick={() =>
          run(async () => {
            setResult(await importDuprRatings(tournamentId, rows));
            setText('');
          }, onDone)
        }
      >
        Update {rows.length || ''} rating{rows.length === 1 ? '' : 's'}
      </Button>
      {result && (
        <p className="text-sm">
          Updated {result.updated} player{result.updated === 1 ? '' : 's'}.
          {result.unknown.length > 0 && (
            <span className="text-called"> Not in this tournament: {result.unknown.join(', ')}.</span>
          )}
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
