'use client';

// The registration side of the Players page: money at a glance, answers to
// the tournament's questions, the waitlist and players without a partner.
import { useState } from 'react';
import { Button, Card, ErrorText, Select } from '@/components/ui';
import { offerWaitlistSpot, pairRegistrations, removeWaitlistEntry } from '@/lib/api';
import { formatMoney, formatTime } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { PlayerBalance, RegistrationAnswer, RegistrationQuestion, RegistrationRow } from '@/lib/types';

/** Paid players, money in and owed, and who's still waiting on something. */
export function RegistrationTotals({ rows, balances }: { rows: RegistrationRow[]; balances: PlayerBalance[] }) {
  const paid = new Set(rows.filter((r) => r.status === 'paid').map((r) => r.registration_id)).size;
  const collected = balances.reduce((sum, b) => sum + b.paid_cents - b.refunded_cents, 0);
  const owedToPlayers = balances.reduce((sum, b) => sum + Math.max(0, -b.balance_cents), 0);
  const playersOwe = balances.reduce((sum, b) => sum + Math.max(0, b.balance_cents), 0);
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {(
        [
          ['Paid players', paid],
          ['Collected, less refunds', formatMoney(collected)],
          ['Owed to players', formatMoney(owedToPlayers)],
          ['Players owe', formatMoney(playersOwe)],
          ['Waiting for partner', rows.filter((r) => r.status === 'paid' && !r.team_id && !r.waitlisted).length],
          ['On the waitlist', rows.filter((r) => r.waitlisted && r.status !== 'cancelled').length],
        ] as const
      ).map(([label, value]) => (
        <Card key={label} className="p-3 text-center">
          <dd className="tnum text-2xl font-semibold">{value}</dd>
          <dt className="text-xs text-muted sm:text-sm">{label}</dt>
        </Card>
      ))}
    </dl>
  );
}

/** Paid players still without a team, per event, with a way to pair them. */
export function Unpaired({
  rows,
  events,
  onChanged,
}: {
  rows: RegistrationRow[];
  events: { id: string; name: string; kind: string }[];
  onChanged: () => void;
}) {
  const waiting = rows.filter((r) => r.status === 'paid' && !r.team_id && !r.waitlisted);
  const { busy, error, run } = useAction();
  const [picks, setPicks] = useState<Record<string, [string, string]>>({});
  if (waiting.length === 0) return null;

  return (
    <Card className="p-4">
      <h2 className="text-xl">Players waiting for a partner</h2>
      <p className="mb-3 text-sm text-muted">
        Teams form on their own when both partners register with each other’s email. Pair the rest here.
      </p>
      <div className="flex flex-col gap-4">
        {events
          .filter((e) => e.kind === 'doubles')
          .map((e) => {
            const people = waiting.filter((r) => r.event_id === e.id);
            if (people.length === 0) return null;
            const [a, b] = picks[e.id] ?? ['', ''];
            const option = (r: RegistrationRow) => (
              <option key={r.registration_id} value={r.registration_id}>
                {r.first_name} {r.last_name} (wants {r.partner_name ?? 'anyone'})
              </option>
            );
            return (
              <div key={e.id}>
                <h3 className="mb-1 text-lg">
                  {e.name} · {people.length} waiting
                </h3>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select className="flex-1" value={a} onChange={(ev) => setPicks({ ...picks, [e.id]: [ev.target.value, b] })}>
                    <option value="">Player…</option>
                    {people.filter((r) => r.registration_id !== b).map(option)}
                  </Select>
                  <Select className="flex-1" value={b} onChange={(ev) => setPicks({ ...picks, [e.id]: [a, ev.target.value] })}>
                    <option value="">Partner…</option>
                    {people.filter((r) => r.registration_id !== a).map(option)}
                  </Select>
                  <Button
                    variant="primary"
                    disabled={busy || !a || !b}
                    onClick={() =>
                      run(
                        () => pairRegistrations(e.id, a, b),
                        () => (setPicks({ ...picks, [e.id]: ['', ''] }), onChanged()),
                      )
                    }
                  >
                    Make team
                  </Button>
                </div>
              </div>
            );
          })}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

/**
 * Players waiting for a spot, first come first served per division. Offering
 * the spot texts and emails them a link to pay (free entries go straight in).
 */
export function Waitlist({
  rows,
  events,
  onChanged,
}: {
  rows: RegistrationRow[];
  events: { id: string; name: string }[];
  onChanged: () => void;
}) {
  const waiting = rows
    .filter((r) => r.waitlisted && r.status !== 'cancelled')
    .sort((a, b) => (a.waitlisted_at ?? '').localeCompare(b.waitlisted_at ?? ''));
  const offered = rows.filter((r) => r.offered_at && r.status === 'pending');
  const { busy, error, run } = useAction();
  if (waiting.length === 0 && offered.length === 0) return null;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-xl">Waitlist</h2>
        <p className="text-sm text-muted">
          First come, first served. Offer a spot when a team drops or you raise a division’s limit: the player gets a text and
          email with a link to pay.
        </p>
      </div>
      {events.map((e) => {
        const line = waiting.filter((r) => r.event_id === e.id);
        if (line.length === 0) return null;
        return (
          <div key={e.id}>
            <h3 className="mb-1 text-lg">
              {e.name} · {line.length} waiting
            </h3>
            <ol className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
              {line.map((r, i) => (
                <li
                  key={`${r.registration_id}-${r.event_id}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="font-medium">
                      {i + 1}. {r.first_name} {r.last_name}
                    </span>
                    <span className="block text-sm text-muted">
                      {r.partner_name ? `with ${r.partner_name} · ` : ''}joined{' '}
                      {r.waitlisted_at ? new Date(r.waitlisted_at).toLocaleDateString() : ''}
                      {r.waitlisted_at ? ` ${formatTime(r.waitlisted_at)}` : ''}
                    </span>
                  </span>
                  <span className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() =>
                        confirm(
                          `Offer ${r.first_name} ${r.last_name} a spot in ${e.name}? They’ll get a text and email with a link to pay.`,
                        ) && run(() => offerWaitlistSpot(r.registration_id, r.event_id), onChanged)
                      }
                    >
                      Offer spot
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        confirm(`Take ${r.first_name} ${r.last_name} off the ${e.name} waitlist?`) &&
                        run(() => removeWaitlistEntry(r.registration_id, r.event_id), onChanged)
                      }
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        );
      })}
      {offered.length > 0 && (
        <div>
          <h3 className="mb-1 text-lg">Offered, waiting for payment</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {offered.map((r) => (
              <li key={`${r.registration_id}-${r.event_id}`}>
                {r.first_name} {r.last_name} · {r.event_name} · {formatMoney(r.amount_cents)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

/** How many registrants picked each answer (T-shirt sizes to order, lunches), counting players still entered. */
export function AnswerCounts({
  questions,
  answers,
  live,
}: {
  questions: RegistrationQuestion[];
  answers: RegistrationAnswer[];
  live: Set<string>;
}) {
  const choices = questions.filter((q) => q.kind !== 'text');
  if (choices.length === 0) return null;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-xl">Answers</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {choices.map((q) => {
          const picks = answers.filter((a) => a.question_id === q.id && live.has(a.registration_id)).flatMap((a) => a.answer);
          return (
            <div key={q.id}>
              <h3 className="text-lg">{q.label}</h3>
              <ul className="mt-1 flex flex-col gap-0.5">
                {q.options.map((o) => (
                  <li key={o} className="flex justify-between gap-3">
                    <span>{o}</span>
                    <span className="tnum font-semibold">{picks.filter((p) => p === o).length}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
