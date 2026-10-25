'use client';

// After the tournament: send results to DUPR. Groups played matches by
// division, shows who is missing a DUPR ID, and downloads the file for DUPR's
// club CSV import. Also takes a pasted list of confirmed ratings.
import Link from 'next/link';
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Icon } from '@/components/Icon';
import { Badge, Button, Card, Empty, ErrorText, Spinner, Textarea } from '@/components/ui';
import { getDuprResults, getEvents, getTournament, importDuprRatings, markDuprExported } from '@/lib/api';
import { downloadText, duprCsv, parseRatings } from '@/lib/dupr';
import { formatDate } from '@/lib/format';
import { useAction, useLiveTournament, useStaffAccess } from '@/lib/hooks';
import type { DuprResultRow } from '@/lib/types';

async function load(id: string) {
  const [tournament, events, results] = await Promise.all([getTournament(id), getEvents(id), getDuprResults(id)]);
  return { tournament, events, results };
}

const slug = (s: string) => s.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

export function DuprResults({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => load(id));
  const action = useAction();
  const [onlyNew, setOnlyNew] = useState(true);

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>DUPR results are for this tournament’s directors.</Empty>;

  const { tournament: t, events, results } = data;
  const ready = (r: DuprResultRow) => r.missing_ids.length === 0;
  const pick = (rows: DuprResultRow[]) => rows.filter((r) => ready(r) && (!onlyNew || !r.exported_at));
  const missing = [...new Set(results.flatMap((r) => r.missing_ids))].sort();

  async function download(rows: DuprResultRow[], name: string) {
    if (rows.length === 0) return;
    downloadText(`${slug(t.name)}-${slug(name)}-dupr.csv`, duprCsv(rows));
    if (confirm(`Mark these ${rows.length} matches as sent to DUPR? Do this once the upload in DUPR worked.`)) {
      await action.run(() => markDuprExported(id, rows.map((r) => r.match_id)), reload);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      <section className="flex flex-col gap-5">
        <div>
          <h2 className="text-4xl">Results to DUPR</h2>
          <p className="mt-1 max-w-prose text-muted">
            Download each division’s played matches as a file for DUPR, then upload it in your DUPR club: <b>Matches</b> →{' '}
            <b>Add Matches</b> → <b>Import Matches via CSV</b>. Forfeits and byes are left out.
          </p>
        </div>

        <ol className="grid gap-2 sm:grid-cols-3">
          <Step n={1} done={missing.length === 0} title="Every player has a DUPR ID">
            {missing.length ? `${missing.length} missing` : 'All set'}
          </Step>
          <Step n={2} done={results.length > 0 && results.every((r) => !ready(r) || r.exported_at)} title="Download and upload">
            {results.filter((r) => ready(r) && !r.exported_at).length} matches to send
          </Step>
          <Step n={3} done={!!t.location} title="Venue and scoring set">
            {t.location ? `${t.dupr_score_type === 'RALLY' ? 'Rally' : 'Side-out'} · ${t.location}` : <Link href={`/t/${id}/setup`} className="underline">Add the venue in Setup</Link>}
          </Step>
        </ol>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
            Only matches not sent yet
          </label>
          <Button variant="primary" disabled={action.busy || pick(results).length === 0} onClick={() => download(pick(results), 'all')}>
            Download all ({pick(results).length})
          </Button>
        </div>
        <ErrorText>{action.error}</ErrorText>

        {results.length === 0 ? (
          <Empty>No matches played yet. Results show up here as scores come in.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {events.map((e) => {
              const rows = results.filter((r) => r.event_id === e.id);
              if (rows.length === 0) return null;
              const toSend = pick(rows);
              const blocked = rows.filter((r) => !ready(r));
              const sent = rows.filter((r) => r.exported_at).length;
              return (
                <Card key={e.id} className="flex flex-col gap-3 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-2xl">{e.name}</h3>
                      <p className="text-sm text-muted">
                        {rows.length} played · {sent} sent{blocked.length ? ` · ${blocked.length} waiting on DUPR IDs` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {sent === rows.length ? (
                        <Badge tone="live">All sent</Badge>
                      ) : (
                        <Button disabled={action.busy || toSend.length === 0} onClick={() => download(toSend, e.name)}>
                          Download {toSend.length}
                        </Button>
                      )}
                      {sent > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={action.busy}
                          onClick={() =>
                            confirm(`Clear the “sent” mark on ${e.name}’s matches?`) &&
                            action.run(() => markDuprExported(id, rows.map((r) => r.match_id), false), reload)
                          }
                        >
                          Clear sent
                        </Button>
                      )}
                    </div>
                  </div>
                  {blocked.length > 0 && (
                    <p className="rounded-lg bg-called-soft px-3 py-2 text-sm text-called">
                      No DUPR ID: {[...new Set(blocked.flatMap((r) => r.missing_ids))].join(', ')}. Add them on the{' '}
                      <Link href={`/t/${id}/players`} className="font-semibold underline">
                        Players
                      </Link>{' '}
                      page.
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <aside className="flex flex-col gap-4">
        <RatingsImport tournamentId={id} onDone={reload} />
        <Card className="p-5 text-sm">
          <h2 className="mb-2 text-xl">About the file</h2>
          <p className="text-muted">
            It follows DUPR’s club import template: one row per match, team A is the first team listed, up to five games.
            Event name: “{t.name} - division”. Date: the day each match finished ({formatDate(t.starts_on)}).
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
      <Textarea rows={6} className="font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder={'7K2QXW 3.82 3.60\nAB12CD 4.05'} />
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
          {result.unknown.length > 0 && <span className="text-called"> Not in this tournament: {result.unknown.join(', ')}.</span>}
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
