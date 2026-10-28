'use client';

// One division's results for DUPR: who's missing a DUPR ID, and the file for
// DUPR's club CSV import. Only final divisions have results here.
import Link from 'next/link';
import { Badge, Button, Card, ErrorText } from '@/components/ui';
import { markDuprExported } from '@/lib/api';
import { downloadText, duprCsv } from '@/lib/dupr';
import { useAction } from '@/lib/hooks';
import type { DuprResultRow, Tournament, TournamentEvent } from '@/lib/types';

const slug = (s: string) => s.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

export function DivisionDupr({
  tournament: t,
  event,
  rows,
  showName = true,
  onChanged,
}: {
  tournament: Tournament;
  event: Pick<TournamentEvent, 'id' | 'name'>;
  /** dupr_results() for this division. */
  rows: DuprResultRow[];
  showName?: boolean;
  onChanged: () => void;
}) {
  const action = useAction();
  const ready = rows.filter((r) => r.missing_ids.length === 0);
  const toSend = ready.filter((r) => !r.exported_at);
  const sent = rows.filter((r) => r.exported_at).length;
  const missing = [...new Set(rows.flatMap((r) => r.missing_ids))].sort();

  async function download(list: DuprResultRow[]) {
    if (list.length === 0) return;
    downloadText(`${slug(t.name)}-${slug(event.name)}-dupr.csv`, duprCsv(list));
    if (confirm(`Mark these ${list.length} matches as sent to DUPR? Do this once the upload in DUPR worked.`)) {
      await action.run(() => markDuprExported(t.id, list.map((r) => r.match_id)), onChanged);
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {showName ? <h3 className="text-2xl">{event.name}</h3> : <h3 className="text-xl">Results to DUPR</h3>}
          <p className="text-sm text-muted">
            {rows.length === 0
              ? 'No matches to send (forfeits and byes are left out).'
              : `${rows.length} played · ${sent} sent${missing.length ? ` · ${rows.length - ready.length} waiting on DUPR IDs` : ''}`}
          </p>
        </div>
        {rows.length > 0 && (
          <div className="flex items-center gap-2">
            {sent === rows.length ? (
              <Badge tone="live">All sent</Badge>
            ) : (
              <Button variant="primary" disabled={action.busy || toSend.length === 0} onClick={() => download(toSend)}>
                Download {toSend.length} for DUPR
              </Button>
            )}
            {sent > 0 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={action.busy}
                onClick={() =>
                  confirm(`Clear the “sent” mark on ${event.name}’s matches?`) &&
                  action.run(() => markDuprExported(t.id, rows.map((r) => r.match_id), false), onChanged)
                }
              >
                Clear sent
              </Button>
            )}
          </div>
        )}
      </div>
      {missing.length > 0 && (
        <p className="rounded-lg bg-called-soft px-3 py-2 text-sm text-called">
          No DUPR ID: {missing.join(', ')}. Add them on the{' '}
          <Link href={`/t/${t.id}/players`} className="font-semibold underline">
            Players
          </Link>{' '}
          page.
        </p>
      )}
      {!t.location && (
        <p className="text-sm text-muted">
          DUPR needs the venue:{' '}
          <Link href={`/t/${t.id}/setup`} className="underline">
            add it in Settings
          </Link>
          .
        </p>
      )}
      <ErrorText>{action.error}</ErrorText>
    </Card>
  );
}
