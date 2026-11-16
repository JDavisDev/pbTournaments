'use client';

// What Stripe reported about a tournament's payments (the stripe_notices
// migration): a payment that couldn't be applied, a refund made in Stripe's
// dashboard, or a dispute. On the Finance page and each player's details.
import { Badge, Button, ErrorText } from '@/components/ui';
import { resolveStripeNotice } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { StripeNotice } from '@/lib/types';

const titles: Record<StripeNotice['kind'], string> = {
  unmatched_payment: 'Payment not applied',
  outside_refund: 'Refunded in Stripe',
  dispute: 'Payment disputed',
};

function StatusBadge({ notice: n }: { notice: StripeNotice }) {
  if (n.kind === 'dispute') {
    if (n.status === 'won') return <Badge tone="live">Won</Badge>;
    if (n.status === 'lost') return <Badge tone="late">Lost</Badge>;
    return <Badge tone="late">Respond in Stripe</Badge>;
  }
  if (n.status === 'resolved') return <Badge>Done</Badge>;
  return <Badge tone={n.kind === 'unmatched_payment' ? 'called' : 'info'}>{n.kind === 'unmatched_payment' ? 'Needs you' : 'New'}</Badge>;
}

/** Notices needing the director come first (open payments and disputes), then the rest, newest first. */
export const needsDirector = (n: StripeNotice) => n.status === 'open';

export function StripeNoticeList({
  notices,
  showPlayer = true,
  onChanged,
}: {
  notices: StripeNotice[];
  showPlayer?: boolean;
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  const sorted = [...notices].sort((a, b) => Number(needsDirector(b)) - Number(needsDirector(a)));
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-border rounded-2xl bg-surface-2">
        {sorted.map((n) => (
          <li key={n.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0 flex-1 basis-64">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                {titles[n.kind]}: <span className="tnum">{formatMoney(n.amount_cents)}</span>
                <StatusBadge notice={n} />
              </p>
              <p className="text-sm text-muted">
                {showPlayer && n.player_name && <>{n.player_name} · </>}
                {new Date(n.created_at).toLocaleDateString()}
              </p>
              {n.detail && <p className="text-sm">{n.detail}</p>}
              {n.kind === 'unmatched_payment' && n.status === 'open' && (
                <p className="text-sm text-muted">The money is in your Stripe account. Refund it there, or sort it out with the player.</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {n.payment_intent_id && (
                <a
                  href={`https://dashboard.stripe.com/payments/${n.payment_intent_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-10 items-center rounded-full px-3 text-sm font-medium underline"
                >
                  Open in Stripe
                </a>
              )}
              {n.status === 'open' && n.kind !== 'dispute' && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => resolveStripeNotice(n.id), onChanged)}>
                  Dismiss
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
