'use client';

// A cancelled tournament's refunds, at the top of its Overview for managers:
// everyone it owes, refunded to their card one at a time or all at once.
// Nothing goes back until a manager sends it. A refund another way (cash,
// check) is recorded on the Players page.
import Link from 'next/link';
import { useState } from 'react';
import { Button, ErrorText, Spinner } from '@/components/ui';
import { getRefundsDue, refundPlayerToCard } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAction, useLoad } from '@/lib/hooks';
import type { RefundDue, Tournament } from '@/lib/types';

/** What can go back to their card: all they're owed, up to what's left of their card payments. */
const toCard = (r: RefundDue) => Math.min(r.owed_cents, r.card_cents);

export function RefundsDue({ tournament: t }: { tournament: Tournament }) {
  const due = useLoad(() => getRefundsDue(t.id), [t.id]);
  const one = useAction();
  const all = useAction();
  const [sending, setSending] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  if (due.error) return <ErrorText>{due.error}</ErrorText>;
  if (!due.data) return <Spinner />;
  const rows = due.data;
  const total = rows.reduce((sum, r) => sum + r.owed_cents, 0);
  const byCard = rows.filter((r) => toCard(r) > 0);
  const busy = one.busy || all.busy;

  const refund = (r: RefundDue) => {
    if (!confirm(`Refund ${formatMoney(toCard(r))} to ${r.name}’s card? This sends the money back through Stripe and can’t be undone.`)) return;
    setSending(r.player_id);
    one.run(() => refundPlayerToCard(t.id, r.player_id, toCard(r), 0), () => (setSending(null), due.reload()));
  };

  // One at a time, so a failure part way says who's left.
  const refundAll = () => {
    const cards = byCard.reduce((sum, r) => sum + toCard(r), 0);
    if (!confirm(`Refund ${formatMoney(cards)} to ${byCard.length} players’ cards? This sends the money back through Stripe and can’t be undone.`)) return;
    all.run(async () => {
      const failed: string[] = [];
      for (const [i, r] of byCard.entries()) {
        setProgress(`Refunding ${i + 1} of ${byCard.length}…`);
        await refundPlayerToCard(t.id, r.player_id, toCard(r), 0).catch((e: Error) => failed.push(`${r.name}: ${e.message}`));
      }
      setProgress(null);
      due.reload();
      if (failed.length) throw new Error(`Not refunded: ${failed.join('; ')}`);
    });
  };

  return (
    <section className="flex flex-col gap-4 rounded-2xl border-2 border-late p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl">Refunds to send</h2>
          <p className="text-muted">
            {rows.length === 0
              ? 'Nobody is owed anything. Everyone who paid has been refunded.'
              : `${rows.length} ${rows.length === 1 ? 'player is' : 'players are'} owed ${formatMoney(total)}. Nothing goes back until you send it.`}
          </p>
        </div>
        {byCard.length > 1 && (
          <Button variant="primary" disabled={busy} onClick={refundAll}>
            {all.busy ? (progress ?? 'Refunding…') : 'Refund everyone to card'}
          </Button>
        )}
      </div>
      <ErrorText>{all.error ?? one.error}</ErrorText>
      {rows.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {rows.map((r) => (
            <li key={r.player_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span className="min-w-0">
                <span className="block font-semibold">{r.name}</span>
                <span className="block text-sm text-muted">
                  Owed {formatMoney(r.owed_cents)}
                  {r.email && ` · ${r.email}`}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {toCard(r) > 0 && (
                  <Button size="sm" disabled={busy} onClick={() => refund(r)}>
                    {sending === r.player_id && one.busy ? 'Refunding…' : `Refund ${formatMoney(toCard(r))} to card`}
                  </Button>
                )}
                <Link href={`/t/${t.id}/players?q=${encodeURIComponent(r.name)}`} className="text-sm text-muted underline hover:text-text">
                  {toCard(r) > 0 ? 'Other ways' : 'Record a cash or check refund'}
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted">
        Stripe’s card fee and Courtside’s fee on each payment aren’t returned; they stay with the tournament. A payment that comes in after
        cancelling shows under Finance to refund.
      </p>
    </section>
  );
}
