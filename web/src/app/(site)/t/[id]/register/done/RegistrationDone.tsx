'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorText, Modal, Spinner } from '@/components/ui';
import { getRegistration, withdrawRegistration } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { withdrawalCredit } from '@/lib/money';
import type { RegistrationView } from '@/lib/types';

/** After checkout. Stripe's webhook can land a moment after the redirect, so this polls until paid. */
export function RegistrationDone() {
  const id = useSearchParams().get('r');
  const [reg, setReg] = useState<RegistrationView | null | undefined>(undefined);
  // An event id, 'all', or null when the dialog is closed.
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pay = useAction();
  const [loads, setLoads] = useState(0);

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
  }, [id, loads]);

  if (!id) return <Empty>Missing registration.</Empty>;
  if (error) return <Empty>{error}</Empty>;
  if (reg === undefined) return <Spinner />;
  if (reg === null) return <Empty>Registration not found.</Empty>;

  const paid = reg.status === 'paid';
  const canWithdraw = reg.tournament_status !== 'complete' && reg.entries.length > 0 && reg.status !== 'cancelled';
  const offered = reg.entries.some((e) => e.offered);
  const startCheckout = () =>
    pay.run(async () => {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ registrationId: reg.id }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!body.url) throw new Error(body.error ?? 'Could not start checkout');
      window.location.href = body.url;
    });
  return (
    <Card className="mx-auto max-w-xl p-6">
      {reg.status === 'waitlisted' ? (
        <>
          <p className="font-semibold text-called">You’re on the waitlist</p>
          <h2 className="mt-1 text-4xl">Thanks, {reg.player_name.split(' ')[0]}!</h2>
          <p className="mt-1 text-muted">
            {reg.tournament_name} is full right now. Nothing has been charged. If a spot opens, we’ll text and email you
            a link to pay and claim it.
          </p>
        </>
      ) : reg.status === 'pending' ? (
        <>
          <p className="font-semibold text-called">{offered ? 'A spot opened for you!' : 'Almost done'}</p>
          <h2 className="mt-1 text-4xl">Finish your registration</h2>
          <p className="mt-1 text-muted">
            {reg.tournament_name} · {formatMoney(reg.amount_cents)} to pay. If you just paid, this page updates in a few
            seconds.
          </p>
          <Button variant="primary" className="mt-4 h-14 w-full text-lg" disabled={pay.busy} onClick={startCheckout}>
            Pay {formatMoney(reg.amount_cents)} now
          </Button>
          <ErrorText>{pay.error}</ErrorText>
        </>
      ) : paid ? (
        <>
          <p className="text-sm font-medium text-accent">You’re registered</p>
          <h2 className="mt-1 text-4xl">See you on court, {reg.player_name.split(' ')[0]}!</h2>
          <p className="mt-1 text-muted">
            {reg.tournament_name} · paid {formatMoney(reg.amount_cents)} · registered as {reg.email}
          </p>
        </>
      ) : reg.withdrawals.length > 0 && reg.entries.length === 0 ? (
        <>
          <p className="font-semibold text-muted">Withdrawn</p>
          <h2 className="mt-1 text-4xl">You’ve withdrawn from {reg.tournament_name}</h2>
        </>
      ) : (
        <h2 className="text-4xl">This registration was {reg.status}.</h2>
      )}

      <ul className="mt-5 flex flex-col divide-y divide-border rounded-xl border border-border">
        {reg.entries.map((e) => (
          <li key={e.event_id} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div>
              <p className="font-medium">{e.event_name}</p>
              <p className="text-sm text-muted">
                {e.waitlisted
                  ? 'On the waitlist'
                  : e.team_name
                  ? `Team ${e.team_name}`
                  : e.partner_name
                    ? `Waiting for ${e.partner_name} to register`
                    : 'Entered'}
              </p>
              {e.paid_by_name && <p className="text-sm text-live">{e.paid_by_name} paid your entry</p>}
              {e.partner_paid_cents > 0 && (
                <p className="text-sm text-live">
                  You paid {e.partner_name ?? 'your partner'}’s entry ({formatMoney(e.partner_paid_cents)})
                  {e.partner_registered ? '' : '. They still need to register: '}
                  {!e.partner_registered && <CopyLink path={`/t/${reg.tournament_id}/register?event=${e.event_id}`} />}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {e.waitlisted ? (
                <Badge tone="called">Waitlist</Badge>
              ) : e.team_id ? (
                <Badge tone="live">Team set</Badge>
              ) : (
                <Badge>Pending partner</Badge>
              )}
              {canWithdraw && (
                <button type="button" className="min-h-11 text-sm font-medium text-late underline underline-offset-4" onClick={() => setWithdrawing(e.event_id)}>
                  Withdraw
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {canWithdraw && reg.entries.length > 1 && (
        <Button variant="ghost" className="mt-2 text-late" onClick={() => setWithdrawing('all')}>
          Withdraw from everything
        </Button>
      )}

      {reg.withdrawals.length > 0 && (
        <div className="mt-5">
          <h3 className="text-xl">Withdrawn</h3>
          <ul className="mt-1 flex flex-col gap-1 text-muted">
            {reg.withdrawals.map((w, i) => (
              <li key={i}>
                {w.event_name} · {new Date(w.withdrawn_at).toLocaleDateString()}
                {w.withdrawn_by === 'director' ? ' by the tournament' : ''}
                {w.credit_cents > 0 ? ` · ${formatMoney(w.credit_cents)} credited` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {reg.answers.length > 0 && (
        <dl className="mt-5 flex flex-col gap-1">
          {reg.answers.map((a) => (
            <div key={a.label}>
              <dt className="text-sm text-muted">{a.label}</dt>
              <dd>{a.answer.join(', ')}</dd>
            </div>
          ))}
        </dl>
      )}

      {reg.balance && <MoneySummary balance={reg.balance} />}

      <Modal open={withdrawing !== null} onClose={() => setWithdrawing(null)} title="Withdraw?">
        {withdrawing !== null && (
          <WithdrawConfirm
            reg={reg}
            eventId={withdrawing === 'all' ? null : withdrawing}
            onDone={() => {
              setWithdrawing(null);
              setLoads((n) => n + 1);
            }}
          />
        )}
      </Modal>
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

function WithdrawConfirm({ reg, eventId, onDone }: { reg: RegistrationView; eventId: string | null; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const entry = reg.entries.find((e) => e.event_id === eventId);
  const leaving = eventId === null ? reg.entries : reg.entries.filter((e) => e.event_id === eventId);
  const credit = withdrawalCredit({
    paid: reg.status === 'paid',
    ownAmountCents:
      reg.amount_cents -
      reg.entries.reduce((sum, e) => sum + e.partner_paid_cents, 0) -
      reg.withdrawals.reduce((sum, w) => sum + w.partner_paid_cents, 0),
    creditedCents: reg.withdrawals.reduce((sum, w) => sum + w.credit_cents, 0),
    countedEntries: reg.entries.filter((e) => !e.waitlisted).length,
    extraFeeCents: reg.extra_event_fee_cents,
    entry: entry ? { waitlisted: !!entry.waitlisted, paidByPartner: !!entry.paid_by_name } : null,
    unusedPartnerCents: leaving.filter((e) => !e.partner_registered).reduce((sum, e) => sum + e.partner_paid_cents, 0),
  });
  const what = eventId === null ? 'every event' : entry?.event_name;
  const hasTeam = reg.entries.some((e) => (eventId === null || e.event_id === eventId) && e.team_id);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg">
        Withdraw from <strong>{what}</strong> at {reg.tournament_name}? This can’t be undone.
      </p>
      {hasTeam && <p className="text-muted">Your partner stays registered and can be paired with someone else.</p>}
      {entry?.paid_by_name && (
        <p className="text-muted">{entry.paid_by_name} paid your entry here, so any credit goes back to them.</p>
      )}
      {credit > 0 && (
        <p>
          {formatMoney(credit)} of your entry fees is credited to you. Whether it’s refunded is up to the tournament’s refund
          policy.
        </p>
      )}
      <div className="rounded-xl bg-surface-2 p-3">
        <p className="font-medium">Refund policy</p>
        <p className="whitespace-pre-wrap text-muted">{reg.refund_policy?.trim() || 'The tournament hasn’t posted a refund policy. Ask the director.'}</p>
      </div>
      <ErrorText>{error}</ErrorText>
      <Button variant="danger" disabled={busy} onClick={() => run(() => withdrawRegistration(reg.id, eventId), onDone)}>
        {busy ? 'Withdrawing…' : `Withdraw from ${what}`}
      </Button>
    </div>
  );
}

/** Paid, credited and refunded, and who owes whom. */
function MoneySummary({ balance: b }: { balance: NonNullable<RegistrationView['balance']> }) {
  const lines: [string, number][] = [
    ['Entry fees', b.entry_fees_cents],
    ['Discount', -b.discount_cents],
    ['Paid', -b.paid_cents],
    ['Credited for withdrawing', -b.withdrawal_credit_cents],
    ['Refunded to you', b.refunded_cents],
    ['Fees', b.fees_cents],
    ['Other credits', -b.credits_cents],
  ];
  return (
    <div className="mt-5 rounded-xl border border-border p-3">
      <h3 className="text-xl">Payments</h3>
      <dl className="mt-1 flex flex-col gap-0.5">
        {lines
          .filter(([, cents]) => cents !== 0)
          .map(([label, cents]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-muted">{label}</dt>
              <dd className="tnum">{formatMoney(Math.abs(cents))}</dd>
            </div>
          ))}
      </dl>
      <p className="mt-2 border-t border-border pt-2 font-semibold">
        {b.balance_cents > 0
          ? `You owe ${formatMoney(b.balance_cents)}`
          : b.balance_cents < 0
            ? `The tournament owes you ${formatMoney(-b.balance_cents)}, under its refund policy`
            : 'All settled'}
      </p>
    </div>
  );
}

/** Copies a link to this site, for sending to a partner. */
function CopyLink({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="min-h-11 text-left font-medium underline underline-offset-4"
      onClick={() =>
        navigator.clipboard
          .writeText(`${window.location.origin}${path}`)
          .then(() => setCopied(true))
          .catch(() => window.prompt('Copy this link for your partner:', `${window.location.origin}${path}`))
      }
    >
      {copied ? 'Link copied' : 'copy their sign-up link'}
    </button>
  );
}
