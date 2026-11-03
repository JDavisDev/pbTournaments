'use client';

// Directors: the tournament's money (in, out, still open, and who gets what)
// and its player numbers by division.
import Link from 'next/link';
import { use } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Button, Card, Empty, ErrorText, Spinner } from '@/components/ui';
import { getTournament, getTournamentFinance } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAction, useLiveTournament, useStaffAccess } from '@/lib/hooks';
import { goToCheckout } from '@/lib/http';
import { CARD_FIXED_CENTS, CARD_PERCENT } from '@/lib/pricing';
import type { TournamentFinance } from '@/lib/types';

async function load(id: string) {
  const [tournament, finance] = await Promise.all([getTournament(id), getTournamentFinance(id)]);
  return { tournament, finance };
}

/** One number with what it is. */
function Stat({ label, value, note }: { label: string; value: string; note?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl bg-surface-2 p-4">
      <span className="text-sm text-muted">{label}</span>
      <span className="tnum font-display text-3xl leading-tight font-extrabold">{value}</span>
      {note && <span className="text-sm text-muted">{note}</span>}
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function FinanceView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error } = useLiveTournament(id, () => load(id));
  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>The tournament’s money is for its directors.</Empty>;
  const { tournament, finance: f } = data;
  const m = f.money;

  // Stripe's card fees are in the director's Stripe account; this is the standard US rate.
  const stripeFees = Math.round(m.card_payments_cents * CARD_PERCENT) + m.card_payment_count * CARD_FIXED_CENTS;
  const courtside = f.courtside.from_cards_cents + f.courtside.paid_separately_cents;
  const net = m.card_payments_cents + m.desk_payments_cents - m.card_refunds_cents - m.other_refunds_cents - courtside - stripeFees;
  const paidFees = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fees') === 'paid';

  return (
    <div className="flex flex-col gap-10">
      {paidFees && (
        <p role="status" className="rounded-lg bg-live-soft px-4 py-3 text-live">
          Thanks: Courtside’s player fees are paid.
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-3xl">Money</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Stat label="Card payments" value={formatMoney(m.card_payments_cents)} note={plural(m.card_payment_count, 'payment')} />
          {m.desk_payments_cents > 0 && <Stat label="Paid at the desk" value={formatMoney(m.desk_payments_cents)} />}
          <Stat label="Refunded" value={formatMoney(m.card_refunds_cents + m.other_refunds_cents)} note={m.kept_fees_cents ? `${formatMoney(m.kept_fees_cents)} kept in fees` : undefined} />
          <Stat label="Courtside fees" value={formatMoney(courtside)} note={`${formatMoney(f.courtside.rate_cents)} per player`} />
          <Stat label="Stripe card fees" value={`≈ ${formatMoney(stripeFees)}`} note="Exact amounts are in your Stripe account" />
          <Stat label="Yours after fees" value={`≈ ${formatMoney(net)}`} note="Card and desk payments, less refunds and fees" />
        </div>
        <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm">
          <dt className="text-muted">Entry fees</dt>
          <dd className="tnum text-right">{formatMoney(m.entry_fees_cents)}</dd>
          <dt className="text-muted">Discounts</dt>
          <dd className="tnum text-right">{formatMoney(m.discounts_cents)}</dd>
        </dl>
      </section>

      <OpenItems tournamentId={tournament.id} finance={f} />

      <section className="flex flex-col gap-3">
        <h2 className="text-3xl">Players</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="On teams" value={String(f.players)} />
          <Stat label="Paid registrations" value={String(f.registrations.paid)} />
          <Stat label="Waitlisted" value={String(f.registrations.waitlisted)} />
          <Stat
            label="Checkout not finished"
            value={String(f.registrations.pending)}
            note={f.withdrawals ? `${plural(f.withdrawals, 'withdrawal')} so far` : undefined}
          />
        </div>
        {f.divisions.length === 0 ? (
          <Empty>No divisions yet.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full text-left">
              <thead className="bg-surface-2 text-sm text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Division</th>
                  <th className="px-3 py-2 text-right font-medium">Teams</th>
                  <th className="px-3 py-2 text-right font-medium">Players</th>
                  <th className="px-3 py-2 text-right font-medium">Waitlist</th>
                  <th className="px-4 py-2 text-right font-medium">No partner yet</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {f.divisions.map((d) => (
                  <tr key={d.event_id}>
                    <td className="px-4 py-2">
                      <Link href={`/t/${tournament.id}/events/${d.event_id}`} className="font-medium hover:underline">
                        {d.name}
                      </Link>
                    </td>
                    <td className="tnum px-3 py-2 text-right">
                      {d.teams}
                      {d.max_teams ? <span className="text-muted"> / {d.max_teams}</span> : null}
                    </td>
                    <td className="tnum px-3 py-2 text-right">{d.players}</td>
                    <td className="tnum px-3 py-2 text-right">{d.waitlisted || ''}</td>
                    <td className="tnum px-4 py-2 text-right">{d.unpaired || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** What's still open: players who owe, players owed a refund, and Courtside's fees due. */
function OpenItems({ tournamentId, finance: f }: { tournamentId: string; finance: TournamentFinance }) {
  const { busy, error, run } = useAction();
  const b = f.balances;
  const payFees = () => run(() => goToCheckout('/api/checkout/fees', { tournamentId }));
  if (!b.players_owing && !b.players_owed && !f.courtside.owed_cents) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-3xl">Still open</h2>
      <Card className="flex flex-col divide-y divide-border p-0">
        {b.players_owing > 0 && (
          <Row
            title={`${plural(b.players_owing, 'player')} owe ${formatMoney(b.owed_by_players_cents)}`}
            text="Unfinished checkouts or fees added after they paid."
            action={<Link href={`/t/${tournamentId}/players`} className="font-medium underline">Players</Link>}
          />
        )}
        {b.players_owed > 0 && (
          <Row
            title={`You owe ${plural(b.players_owed, 'player')} ${formatMoney(b.owed_to_players_cents)}`}
            text="Credits from withdrawals. Refund them to their card from the Players page, or keep it under your refund policy."
            action={<Link href={`/t/${tournamentId}/players`} className="font-medium underline">Players</Link>}
          />
        )}
        {f.courtside.owed_cents > 0 && (
          <Row
            title={`Courtside fees due: ${formatMoney(f.courtside.owed_cents)}`}
            text={`${plural(f.courtside.uncovered_players, 'player')} didn’t pay by card (added at the desk, free entries), so their ${formatMoney(f.courtside.rate_cents)} wasn’t taken from a payment.`}
            action={
              <Button size="sm" variant="primary" disabled={busy} onClick={payFees}>
                Pay {formatMoney(f.courtside.owed_cents)}
              </Button>
            }
          />
        )}
      </Card>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

function Row({ title, text, action }: { title: string; text: string; action: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0 flex-1 basis-64">
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-muted">{text}</p>
      </div>
      {action}
    </div>
  );
}
