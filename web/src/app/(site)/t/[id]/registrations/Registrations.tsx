'use client';

import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Badge, Button, Card, Empty, ErrorText, Input, Modal, Select, Spinner } from '@/components/ui';
import {
  getEvents,
  getMoney,
  getRegistrationAnswers,
  getRegistrationQuestions,
  getRegistrations,
  getTournament,
  offerWaitlistSpot,
  pairRegistrations,
  removeWaitlistEntry,
} from '@/lib/api';
import { formatMoney, formatTime } from '@/lib/format';
import { useAction, useLiveTournament, useStaffAccess } from '@/lib/hooks';
import type { RegistrationAnswer, RegistrationQuestion, RegistrationRow } from '@/lib/types';
import { BalanceBadge, RegistrantDetails, type Registrant } from './RegistrantDetails';

const statusTone = { paid: 'live', pending: 'called', cancelled: 'neutral', refunded: 'neutral', waitlisted: 'info' } as const;

async function load(id: string) {
  const [rows, events, money, tournament, questions, answers] = await Promise.all([
    getRegistrations(id),
    getEvents(id),
    getMoney(id),
    getTournament(id),
    getRegistrationQuestions(id),
    getRegistrationAnswers(id),
  ]);
  return { rows, events, money, tournament, questions, answers };
}

export function Registrations({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => load(id));
  const [search, setSearch] = useState('');
  // The registrant whose details are open, by player.
  const [openPlayer, setOpenPlayer] = useState<string | null>(null);

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>Registrations are for this tournament’s directors.</Empty>;

  // One card per registration, with its events. Registrations withdrawn from
  // every event have no entries left; they stay listed (they may be owed money).
  const byRegistration = new Map<string, RegistrationRow[]>();
  for (const r of data.rows) byRegistration.set(r.registration_id, [...(byRegistration.get(r.registration_id) ?? []), r]);
  const withdrawnOnly = new Map(
    data.money.withdrawals.filter((w) => !byRegistration.has(w.registration_id)).map((w) => [w.registration_id, w]),
  );
  const balanceOf = (playerId: string) => data.money.balances.find((b) => b.player_id === playerId) ?? null;
  const matches = (first: string, last: string, email: string) =>
    `${first} ${last} ${email}`.toLowerCase().includes(search.toLowerCase());
  const registrations = [...byRegistration.values()].filter((e) => matches(e[0].first_name, e[0].last_name, e[0].email));
  const withdrawn = [...withdrawnOnly.values()].filter((w) => matches(w.first_name, w.last_name, w.email));
  const paid = [...byRegistration.values()].filter((e) => e[0].status === 'paid');
  const collected = data.money.balances.reduce((sum, b) => sum + b.paid_cents - b.refunded_cents, 0);
  const owedToPlayers = data.money.balances.reduce((sum, b) => sum + Math.max(0, -b.balance_cents), 0);
  const playersOwe = data.money.balances.reduce((sum, b) => sum + Math.max(0, b.balance_cents), 0);

  const registrant = (playerId: string): Registrant | null => {
    const entries = data.rows.filter((r) => r.player_id === playerId);
    const withdrawals = data.money.withdrawals.filter((w) => w.player_id === playerId);
    const who = entries[0] ?? withdrawals[0];
    if (!who) return null;
    const registrationIds = new Set([...entries.map((e) => e.registration_id), ...withdrawals.map((w) => w.registration_id)]);
    return {
      playerId,
      answers: data.questions.flatMap((q) => {
        const a = data.answers.find((x) => x.question_id === q.id && registrationIds.has(x.registration_id));
        return a ? [{ label: q.label, answer: a.answer }] : [];
      }),
      name: `${who.first_name} ${who.last_name}`,
      email: who.email,
      phone: who.phone,
      entries,
      withdrawals,
      ledger: data.money.ledger.filter((l) => l.player_id === playerId),
      balance: balanceOf(playerId),
    };
  };
  const details = openPlayer ? registrant(openPlayer) : null;

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Paid players', paid.length],
          ['Collected, less refunds', formatMoney(collected)],
          ['Owed to players', formatMoney(owedToPlayers)],
          ['Players owe', formatMoney(playersOwe)],
          ['Waiting for partner', data.rows.filter((r) => r.status === 'paid' && !r.team_id && !r.waitlisted).length],
          ['On the waitlist', data.rows.filter((r) => r.waitlisted && r.status !== 'cancelled').length],
        ].map(([label, value]) => (
          <Card key={label} className="p-3 text-center">
            <dd className="tnum text-2xl font-semibold">{value}</dd>
            <dt className="text-xs text-muted sm:text-sm">{label}</dt>
          </Card>
        ))}
      </dl>

      <AnswerCounts questions={data.questions} answers={data.answers} live={new Set(data.rows.map((r) => r.registration_id))} />
      <Waitlist rows={data.rows} events={data.events} onChanged={reload} />
      <Unpaired rows={data.rows} events={data.events} onChanged={reload} />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-3xl">All registrations</h2>
          <Input className="w-48" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {registrations.length === 0 && withdrawn.length === 0 ? (
          <Empty>No registrations yet. Share the Register link when the tournament is open for registration.</Empty>
        ) : (
          <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
            {registrations.map((entries) => {
              const r = entries[0];
              return (
                // The whole row opens the details; the name is the button for keyboards.
                <div
                  key={r.registration_id}
                  onClick={() => setOpenPlayer(r.player_id)}
                  className="flex cursor-pointer flex-col gap-2 px-4 py-3 hover:bg-surface-2 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className="min-h-11 text-left font-medium underline underline-offset-4">
                        {r.first_name} {r.last_name}
                      </button>
                      <Badge tone={statusTone[r.status]}>{r.status}</Badge>
                      <BalanceBadge balance={balanceOf(r.player_id)} />
                      {r.payment_provider === 'test' && <Badge>test payment</Badge>}
                      {r.discount_code && <Badge tone="info">{r.discount_code} −{formatMoney(r.discount_cents)}</Badge>}
                    </div>
                    <p className="truncate text-sm text-muted">
                      {r.email}
                      {r.phone ? ` · ${r.phone}` : ''}
                      {r.phone && !r.sms_opt_in ? ' (no texts)' : ''}
                      {r.dupr_doubles ? ` · DUPR ${Number(r.dupr_doubles).toFixed(2)}` : ''}
                    </p>
                    <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                      {entries.map((e) => (
                        <li key={e.event_id}>
                          {e.event_name}:{' '}
                          {e.waitlisted ? (
                            <span className="text-called">on the waitlist</span>
                          ) : e.team_name ? (
                            <span className="text-accent">team {e.team_name}</span>
                          ) : e.partner_name ? (
                            <span className="text-muted">
                              partner {e.partner_name} ({e.partner_email}) not matched yet
                            </span>
                          ) : (
                            <span className="text-muted">entered</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <span className="tnum text-sm font-medium sm:text-right">{formatMoney(r.amount_cents)}</span>
                </div>
              );
            })}
            {withdrawn.map((w) => (
              <div
                key={w.registration_id}
                onClick={() => setOpenPlayer(w.player_id)}
                className="flex cursor-pointer flex-col gap-1 px-4 py-3 hover:bg-surface-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="min-h-11 text-left font-medium underline underline-offset-4">
                    {w.first_name} {w.last_name}
                  </button>
                  <Badge>withdrawn</Badge>
                  <BalanceBadge balance={balanceOf(w.player_id)} />
                </div>
                <p className="truncate text-sm text-muted">{w.email}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal open={!!details} onClose={() => setOpenPlayer(null)} title={details?.name ?? ''}>
        {details && <RegistrantDetails who={details} tournament={data.tournament} events={data.events} onChanged={reload} />}
      </Modal>
    </div>
  );
}

/** Paid players still without a team, per event, with a way to pair them. */
function Unpaired({
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
                    onClick={() => run(() => pairRegistrations(e.id, a, b), () => (setPicks({ ...picks, [e.id]: ['', ''] }), onChanged()))}
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
function Waitlist({
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
          First come, first served. Offer a spot when a team drops or you raise a division’s limit: the player gets a text
          and email with a link to pay.
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
                <li key={`${r.registration_id}-${r.event_id}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">
                      {i + 1}. {r.first_name} {r.last_name}
                    </span>
                    <span className="block text-sm text-muted">
                      {r.partner_name ? `with ${r.partner_name} · ` : ''}joined {r.waitlisted_at ? new Date(r.waitlisted_at).toLocaleDateString() : ''}
                      {r.waitlisted_at ? ` ${formatTime(r.waitlisted_at)}` : ''}
                    </span>
                  </span>
                  <span className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() =>
                        confirm(`Offer ${r.first_name} ${r.last_name} a spot in ${e.name}? They’ll get a text and email with a link to pay.`) &&
                        run(() => offerWaitlistSpot(r.registration_id, r.event_id), onChanged)
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
function AnswerCounts({
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
