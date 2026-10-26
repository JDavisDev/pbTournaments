'use client';

import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Badge, Button, Card, Empty, ErrorText, Input, Select, Spinner } from '@/components/ui';
import { getEvents, getRegistrations, offerWaitlistSpot, pairRegistrations, removeWaitlistEntry } from '@/lib/api';
import { formatMoney, formatTime } from '@/lib/format';
import { useAction, useLiveTournament, useStaffAccess } from '@/lib/hooks';
import type { RegistrationRow } from '@/lib/types';

const statusTone = { paid: 'live', pending: 'called', cancelled: 'neutral', refunded: 'neutral', waitlisted: 'info' } as const;

async function load(id: string) {
  const [rows, events] = await Promise.all([getRegistrations(id), getEvents(id)]);
  return { rows, events };
}

export function Registrations({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => load(id));
  const [search, setSearch] = useState('');

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>Registrations are for this tournament’s directors.</Empty>;

  // One card per registration, with its events.
  const byRegistration = new Map<string, RegistrationRow[]>();
  for (const r of data.rows) byRegistration.set(r.registration_id, [...(byRegistration.get(r.registration_id) ?? []), r]);
  const registrations = [...byRegistration.values()].filter((entries) =>
    `${entries[0].first_name} ${entries[0].last_name} ${entries[0].email}`.toLowerCase().includes(search.toLowerCase()),
  );
  const paid = [...byRegistration.values()].filter((e) => e[0].status === 'paid');
  const collected = paid.reduce((sum, e) => sum + e[0].amount_cents, 0);

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Paid players', paid.length],
          ['Collected', formatMoney(collected)],
          ['Waiting for partner', data.rows.filter((r) => r.status === 'paid' && !r.team_id && !r.waitlisted).length],
          ['On the waitlist', data.rows.filter((r) => r.waitlisted && r.status !== 'cancelled').length],
        ].map(([label, value]) => (
          <Card key={label} className="p-3 text-center">
            <dd className="tnum text-2xl font-semibold">{value}</dd>
            <dt className="text-xs text-muted sm:text-sm">{label}</dt>
          </Card>
        ))}
      </dl>

      <Waitlist rows={data.rows} events={data.events} onChanged={reload} />
      <Unpaired rows={data.rows} events={data.events} onChanged={reload} />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-3xl">All registrations</h2>
          <Input className="w-48" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {registrations.length === 0 ? (
          <Empty>No registrations yet. Share the Register link when the tournament is open for registration.</Empty>
        ) : (
          <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
            {registrations.map((entries) => {
              const r = entries[0];
              return (
                <div key={r.registration_id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {r.first_name} {r.last_name}
                      </span>
                      <Badge tone={statusTone[r.status]}>{r.status}</Badge>
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
          </div>
        )}
      </section>
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
