'use client';

// Stands in for Stripe Checkout while no Stripe key is set. Nothing is charged.
import { useSearchParams } from 'next/navigation';
import { Button, Card, Empty, ErrorText, Spinner } from '@/components/ui';
import { getRegistration } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAction, useLoad } from '@/lib/hooks';

export function TestCheckout() {
  const id = useSearchParams().get('r') ?? '';
  const reg = useLoad(() => getRegistration(id), [id]);
  const pay = useAction();

  if (reg.error) return <Empty>{reg.error}</Empty>;
  if (reg.data === undefined) return <Spinner />;
  if (!reg.data) return <Empty>Registration not found.</Empty>;
  const r = reg.data;

  const finish = (outcome: 'pay' | 'cancel') =>
    pay.run(async () => {
      const res = await fetch('/api/checkout/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ registrationId: id, outcome }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!body.url) throw new Error(body.error ?? 'Test checkout failed');
      window.location.href = body.url;
    });

  return (
    <Card className="mx-auto max-w-md p-6">
      <p className="inline-block rounded-full bg-called-soft px-2.5 py-0.5 text-xs font-semibold text-called">
        Test checkout · no real payment
      </p>
      <h2 className="mt-3 text-3xl">{r.tournament_name}</h2>
      <p className="text-muted">{r.player_name}</p>
      <ul className="mt-4 flex flex-col gap-1 text-sm">
        {r.entries.map((e) => (
          <li key={e.event_id}>{e.event_name}</li>
        ))}
      </ul>
      <div className="mt-4 flex items-baseline justify-between border-t border-border pt-4">
        <span className="text-muted">Total</span>
        <span className="tnum font-display text-5xl font-extrabold">{formatMoney(r.amount_cents)}</span>
      </div>
      <ErrorText>{pay.error}</ErrorText>
      <div className="mt-5 grid grid-cols-2 gap-2">
        <Button className="h-12" disabled={pay.busy} onClick={() => finish('cancel')}>
          Cancel
        </Button>
        <Button variant="primary" className="h-12" disabled={pay.busy || r.status !== 'pending'} onClick={() => finish('pay')}>
          {r.status === 'pending' ? `Pay ${formatMoney(r.amount_cents)}` : 'Already paid'}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        Add a Stripe test key (STRIPE_SECRET_KEY=sk_test_…) to use real Stripe Checkout in test mode instead.
      </p>
    </Card>
  );
}
