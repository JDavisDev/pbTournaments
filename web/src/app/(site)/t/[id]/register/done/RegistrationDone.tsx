'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Card, Empty, Spinner } from '@/components/ui';
import { getRegistration } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { RegistrationView } from '@/lib/types';

/** After checkout. Stripe's webhook can land a moment after the redirect, so this polls until paid. */
export function RegistrationDone() {
  const id = useSearchParams().get('r');
  const [reg, setReg] = useState<RegistrationView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let stop = false;
    let tries = 0;
    const load = () =>
      getRegistration(id)
        .then((r) => {
          if (stop) return;
          setReg(r);
          if (r?.status === 'pending' && ++tries < 20) setTimeout(load, 1500);
        })
        .catch((e: Error) => setError(e.message));
    load();
    return () => {
      stop = true;
    };
  }, [id]);

  if (!id) return <Empty>Missing registration.</Empty>;
  if (error) return <Empty>{error}</Empty>;
  if (reg === undefined) return <Spinner />;
  if (reg === null) return <Empty>Registration not found.</Empty>;

  const paid = reg.status === 'paid';
  return (
    <Card className="mx-auto max-w-xl p-6">
      {paid ? (
        <>
          <p className="text-sm font-medium text-accent">You’re registered</p>
          <h2 className="mt-1 text-4xl">See you on court, {reg.player_name.split(' ')[0]}!</h2>
          <p className="mt-1 text-muted">
            {reg.tournament_name} · paid {formatMoney(reg.amount_cents)} · registered as {reg.email}
          </p>
        </>
      ) : (
        <>
          <h2 className="text-4xl">Confirming your payment…</h2>
          <p className="mt-1 text-muted">This usually takes a few seconds.</p>
        </>
      )}

      <ul className="mt-5 flex flex-col divide-y divide-border rounded-xl border border-border">
        {reg.entries.map((e) => (
          <li key={e.event_id} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div>
              <p className="font-medium">{e.event_name}</p>
              <p className="text-sm text-muted">
                {e.team_name
                  ? `Team ${e.team_name}`
                  : e.partner_name
                    ? `Waiting for ${e.partner_name} to register`
                    : 'Entered'}
              </p>
            </div>
            {e.team_id ? <Badge tone="live">Team set</Badge> : <Badge>Pending partner</Badge>}
          </li>
        ))}
      </ul>
      {paid && reg.entries.some((e) => !e.team_id && e.partner_name) && (
        <p className="mt-3 text-sm text-muted">
          Your team is set once your partner registers with your email as their partner. The desk can also pair you.
        </p>
      )}
      <Link href={`/t/${reg.tournament_id}`} className="mt-5 inline-block text-accent hover:underline">
        Back to the tournament
      </Link>
    </Card>
  );
}
