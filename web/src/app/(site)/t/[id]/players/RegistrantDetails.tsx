'use client';

// A registrant's details for admins: their events (withdraw, move to another
// division), what they've paid and been credited, who owes whom, and
// payments, refunds and fees recorded by hand.
import { useState } from 'react';
import { Badge, Button, ErrorText, Field, Input, Select } from '@/components/ui';
import { moveRegistrationEntry, recordLedgerEntry, withdrawRegistration } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { balanceText, describeLedger, extraEventFee, withdrawalCredit } from '@/lib/money';
import type { LedgerEntry, PaymentMethod, PlayerBalance, RegistrationRow, Tournament, TournamentEvent, WithdrawalRow } from '@/lib/types';

export interface Registrant {
  playerId: string;
  /** Their answers to the tournament's questions. */
  answers: { label: string; answer: string[] }[];
  name: string;
  email: string;
  phone: string | null;
  /** Live entries, across the player's registrations. */
  entries: RegistrationRow[];
  withdrawals: WithdrawalRow[];
  ledger: LedgerEntry[];
  balance: PlayerBalance | null;
}

const toCents = (dollars: string) => Math.round(Number(dollars) * 100);
const toDollars = (cents: number) => (cents / 100).toFixed(2);

export function RegistrantDetails({
  who,
  tournament,
  events,
  onChanged,
}: {
  who: Registrant;
  tournament: Tournament;
  events: TournamentEvent[];
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const open = tournament.status !== 'complete';
  const balance = who.balance?.balance_cents ?? 0;

  /** What withdrawing this entry (or all of this registration's, entry null) credits. */
  const creditFor = (registrationId: string, entry: RegistrationRow | null) => {
    const same = who.entries.filter((e) => e.registration_id === registrationId);
    const gone = who.withdrawals.filter((w) => w.registration_id === registrationId);
    const first = same[0];
    const leaving = entry ? [entry] : same;
    return withdrawalCredit({
      paid: first?.status === 'paid',
      ownAmountCents:
        (first?.amount_cents ?? 0) -
        same.reduce((sum, e) => sum + e.partner_paid_cents, 0) -
        gone.reduce((sum, w) => sum + w.partner_paid_cents, 0),
      creditedCents: gone.reduce((sum, w) => sum + w.credit_cents, 0),
      countedEntries: same.filter((e) => !e.waitlisted).length,
      extraFeeCents: first ? extraEventFee(tournament, first.created_at) : 0,
      entry: entry ? { waitlisted: entry.waitlisted, paidByPartner: !!entry.paid_by_registration_id } : null,
      unusedPartnerCents: leaving.filter((e) => !e.partner_registered).reduce((sum, e) => sum + e.partner_paid_cents, 0),
    });
  };

  const withdraw = (entry: RegistrationRow) => {
    const credit = creditFor(entry.registration_id, entry);
    const message =
      `Withdraw ${who.name} from ${entry.event_name}?` +
      (entry.team_name ? ` Team ${entry.team_name} leaves the division (forfeiting any matches left).` : '') +
      (credit > 0 ? ` ${formatMoney(credit)} is credited to them; record a refund after if your policy gives one.` : '') +
      (entry.paid_by_name ? ` ${entry.paid_by_name} paid this entry, so the ${formatMoney(entry.paid_by_cents)} is credited to them.` : '');
    if (confirm(message)) run(() => withdrawRegistration(entry.registration_id, entry.event_id), onChanged);
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-muted">
          {who.email}
          {who.phone ? ` · ${who.phone}` : ''}
        </p>
        <p className="mt-2 text-2xl font-semibold">
          {who.balance ? (
            <span className={balance > 0 ? 'text-late' : balance < 0 ? 'text-called' : 'text-live'}>
              {balance > 0
                ? `Owes the tournament ${formatMoney(balance)}`
                : balance < 0
                  ? `The tournament owes them ${formatMoney(-balance)}`
                  : 'Paid in full, nothing owed'}
            </span>
          ) : (
            <span className="text-muted">Nothing paid yet</span>
          )}
        </p>
      </div>

      <section>
        <h3 className="text-xl">Events</h3>
        {who.entries.length === 0 ? (
          <p className="text-muted">Withdrawn from every event.</p>
        ) : (
          <ul className="mt-1 flex flex-col divide-y divide-border rounded-xl border border-border">
            {who.entries.map((e) => {
              const others = events.filter((ev) => ev.id !== e.event_id);
              const target = moveTo[`${e.registration_id}:${e.event_id}`] ?? '';
              return (
                <li key={`${e.registration_id}:${e.event_id}`} className="flex flex-col gap-2 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">{e.event_name}</span>{' '}
                      <span className="text-muted">
                        {e.status !== 'paid'
                          ? `· ${e.status === 'pending' ? 'checkout not finished' : e.status}`
                          : e.waitlisted
                            ? '· waitlist'
                            : e.team_name
                              ? `· team ${e.team_name}`
                              : '· waiting for a partner'}
                      </span>
                      {e.paid_by_name && <span className="block text-sm text-live">Entry paid by {e.paid_by_name}</span>}
                      {e.partner_paid_cents > 0 && (
                        <span className="block text-sm text-live">
                          Paid {e.partner_name ?? e.partner_email}’s entry ({formatMoney(e.partner_paid_cents)})
                          {e.partner_registered ? '' : ', partner hasn’t registered yet (spot held)'}
                        </span>
                      )}
                    </span>
                    {open && (
                      <Button size="sm" variant="ghost" className="text-late" disabled={busy} onClick={() => withdraw(e)}>
                        Withdraw
                      </Button>
                    )}
                  </div>
                  {open && others.length > 0 && (
                    <div className="flex gap-2">
                      <Select
                        className="h-10 min-w-0 flex-1 text-sm"
                        aria-label={`Move ${who.name} from ${e.event_name} to`}
                        value={target}
                        onChange={(ev) => setMoveTo({ ...moveTo, [`${e.registration_id}:${e.event_id}`]: ev.target.value })}
                      >
                        <option value="">Move to another division…</option>
                        {others.map((ev) => (
                          <option key={ev.id} value={ev.id}>
                            {ev.name}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        disabled={busy || !target}
                        onClick={() =>
                          confirm(
                            `Move ${e.team_name ? `team ${e.team_name}` : who.name} from ${e.event_name} to ${events.find((ev) => ev.id === target)?.name}? The price stays the same.`,
                          ) && run(() => moveRegistrationEntry(e.registration_id, e.event_id, target), onChanged)
                        }
                      >
                        Move
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {who.withdrawals.length > 0 && (
          <ul className="mt-2 flex flex-col gap-0.5 text-sm text-muted">
            {who.withdrawals.map((w) => (
              <li key={w.id}>
                Withdrew from {w.event_name} {new Date(w.withdrawn_at).toLocaleDateString()} ({w.withdrawn_by === 'player' ? 'themselves' : 'by an admin'})
                {w.credit_cents > 0 ? ` · ${formatMoney(w.credit_cents)} credited` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      {who.answers.length > 0 && (
        <section>
          <h3 className="text-xl">Answers</h3>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {who.answers.map((a) => (
              <div key={a.label} className="contents">
                <dt className="text-muted">{a.label}</dt>
                <dd>{a.answer.join(', ')}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section>
        <h3 className="text-xl">Payments</h3>
        {who.ledger.length === 0 ? (
          <p className="text-muted">Nothing yet. Fees and payments show here once they’ve paid at checkout.</p>
        ) : (
          <>
            <Totals balance={who.balance} ledger={who.ledger} />
            <table className="mt-3 w-full text-sm">
              <tbody className="divide-y divide-border">
                {who.ledger.map((l) => (
                  <tr key={l.id}>
                    <td className="py-1.5 pr-2 whitespace-nowrap text-muted">{new Date(l.created_at).toLocaleDateString()}</td>
                    <td className="py-1.5 pr-2">
                      {describeLedger(l)}
                      {l.payment_ref && <span className="block font-mono text-muted">{l.payment_ref}</span>}
                    </td>
                    <td className={`tnum py-1.5 text-right whitespace-nowrap ${l.amount_cents < 0 ? 'text-live' : ''}`}>
                      {l.amount_cents < 0 ? '−' : '+'}
                      {formatMoney(Math.abs(l.amount_cents))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-sm text-muted">+ adds to what they owe; − takes off.</p>
          </>
        )}
      </section>

      {/* Keyed on the balance so the amounts filled in start over after each change. */}
      {who.balance && <MoneyActions key={balance} who={who} tournament={tournament} onChanged={onChanged} />}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** Paid via Stripe, the cost after discounts and withdrawals, refunds, and the balance. */
function Totals({ balance: b, ledger }: { balance: PlayerBalance | null; ledger: LedgerEntry[] }) {
  if (!b) return null;
  const paidBy = (methods: PaymentMethod[]) =>
    -ledger.filter((l) => l.kind === 'payment' && l.method && methods.includes(l.method)).reduce((sum, l) => sum + l.amount_cents, 0);
  const cost = b.entry_fees_cents - b.discount_cents - b.withdrawal_credit_cents + b.fees_cents - b.credits_cents;
  const rows: [string, number, string?][] = [
    ['Entry fees', b.entry_fees_cents],
    ['Discounts', b.discount_cents],
    ['Credited for withdrawals', b.withdrawal_credit_cents],
    ['Fees and other credits', b.fees_cents - b.credits_cents],
    ['Cost now', cost, 'font-semibold'],
    ['Paid by card (Stripe)', paidBy(['stripe'])],
    ['Paid by test checkout', paidBy(['test'])],
    ['Paid at the desk', paidBy(['cash', 'check', 'other'])],
    ['Refunded', b.refunded_cents],
  ];
  return (
    <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
      {rows
        .filter(([label, cents]) => cents !== 0 || label === 'Cost now')
        .map(([label, cents, cls]) => (
          <div key={label} className={`contents ${cls ?? ''}`}>
            <dt className={cls ? '' : 'text-muted'}>{label}</dt>
            <dd className="tnum text-right">{formatMoney(Math.abs(cents))}</dd>
          </div>
        ))}
      <div className="col-span-2 mt-1 flex justify-between gap-4 border-t border-border pt-1 font-semibold">
        <dt>Balance</dt>
        <dd className="tnum text-right">{balanceText(b.balance_cents)}</dd>
      </div>
    </dl>
  );
}

/** Record a refund, keep what's owed under the refund policy, take a payment, or add a fee or credit. */
function MoneyActions({ who, tournament, onChanged }: { who: Registrant; tournament: Tournament; onChanged: () => void }) {
  const balance = who.balance?.balance_cents ?? 0;
  const owed = Math.max(0, -balance);
  const [refund, setRefund] = useState(() => toDollars(Math.max(0, owed - tournament.refund_fee_cents)));
  const [payment, setPayment] = useState(() => toDollars(Math.max(0, balance)));
  const [method, setMethod] = useState<PaymentMethod>('stripe');
  const [adjust, setAdjust] = useState({ kind: 'fee' as 'fee' | 'credit', amount: '', note: '' });
  const { busy, error, run } = useAction();
  const record = (kind: 'payment' | 'refund' | 'fee' | 'credit', cents: number, m: PaymentMethod | null, note: string | null) =>
    run(() => recordLedgerEntry(tournament.id, who.playerId, kind, cents, m, note), onChanged);
  const methods = (
    <Select className="h-10 text-sm" aria-label="How" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
      <option value="stripe">Card (Stripe)</option>
      <option value="cash">Cash</option>
      <option value="check">Check</option>
      <option value="other">Other</option>
    </Select>
  );

  return (
    <section className="flex flex-col gap-4 rounded-xl bg-surface-2 p-4">
      {owed > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xl">They’re owed {formatMoney(owed)}</h3>
          {tournament.refund_policy?.trim() ? (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">Your refund policy</summary>
              <p className="mt-1 whitespace-pre-wrap text-muted">{tournament.refund_policy}</p>
            </details>
          ) : (
            <p className="text-sm text-muted">No refund policy yet: add one in Settings → Registration.</p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Refund ($)">
              <Input className="h-10 w-28" inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} />
            </Field>
            {methods}
            <Button size="sm" variant="primary" disabled={busy || !(toCents(refund) > 0)} onClick={() => record('refund', toCents(refund), method, null)}>
              Record refund
            </Button>
          </div>
          {method === 'stripe' && <p className="text-sm text-muted">Refund the card in your Stripe dashboard, then record it here.</p>}
          {tournament.refund_fee_cents > 0 && owed > tournament.refund_fee_cents && (
            <p className="text-sm text-muted">Filled in less the {formatMoney(tournament.refund_fee_cents)} you keep on refunds (Setup).</p>
          )}
          <Button
            size="sm"
            className="self-start"
            disabled={busy}
            onClick={() =>
              confirm(`Keep the ${formatMoney(owed)} they’re owed under your refund policy? Their balance goes to $0.`) &&
              record('fee', owed, null, 'Kept under the refund policy')
            }
          >
            Keep {formatMoney(owed)} under the refund policy
          </Button>
        </div>
      )}

      {balance > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xl">They owe {formatMoney(balance)}</h3>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Payment ($)">
              <Input className="h-10 w-28" inputMode="decimal" value={payment} onChange={(e) => setPayment(e.target.value)} />
            </Field>
            {methods}
            <Button size="sm" variant="primary" disabled={busy || !(toCents(payment) > 0)} onClick={() => record('payment', toCents(payment), method, null)}>
              Record payment
            </Button>
          </div>
        </div>
      )}

      <details>
        <summary className="cursor-pointer font-medium">Add a fee or credit</summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Select className="h-10 text-sm" aria-label="Fee or credit" value={adjust.kind} onChange={(e) => setAdjust({ ...adjust, kind: e.target.value as 'fee' | 'credit' })}>
            <option value="fee">Fee (they owe more)</option>
            <option value="credit">Credit (they owe less)</option>
          </Select>
          <Field label="Amount ($)">
            <Input className="h-10 w-28" inputMode="decimal" value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })} />
          </Field>
          <Field label="Note">
            <Input className="h-10" value={adjust.note} maxLength={200} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} placeholder="Shirt, late fee…" />
          </Field>
          <Button
            size="sm"
            disabled={busy || !(toCents(adjust.amount) > 0)}
            onClick={() => record(adjust.kind, toCents(adjust.amount), null, adjust.note.trim() || null)}
          >
            Add
          </Button>
        </div>
      </details>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

/** "Owes $10" / "Owed $40" next to a registrant's name. */
export function BalanceBadge({ balance }: { balance: PlayerBalance | null }) {
  if (!balance || balance.balance_cents === 0) return null;
  return <Badge tone={balance.balance_cents > 0 ? 'late' : 'called'}>{balanceText(balance.balance_cents)}</Badge>;
}
