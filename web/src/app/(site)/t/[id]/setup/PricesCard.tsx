'use client';

import { Fragment, useState } from 'react';
import { Button, Check, Field, Input } from '@/components/ui';
import { updateTournament } from '@/lib/api';
import { priceSummary } from '@/lib/format';
import type { Tournament } from '@/lib/types';
import { useUnsaved } from './SaveAll';
import { SettingsGroup } from './SetupCards';

const dollars = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));
const cents = (value: string) => (value.trim() === '' ? null : Math.round(Number(value) * 100));

interface StepDraft {
  through: string;
  registration: string;
  event: string;
}

/**
 * The registration fee (once per player) and event fee (each event), whether
 * the registration covers one event, and optional earlier prices that step up
 * on dates.
 */
export function PricesCard({ tournament }: { tournament: Tournament }) {
  const [form, setForm] = useState({
    registration: dollars(tournament.entry_fee_cents),
    event: dollars(tournament.extra_event_fee_cents),
    included: tournament.first_event_included,
    refundFee: dollars(tournament.refund_fee_cents),
  });
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    [...tournament.price_schedule]
      .sort((a, b) => a.through.localeCompare(b.through))
      .map((s) => ({ through: s.through, registration: dollars(s.registration_cents), event: dollars(s.event_cents) })),
  );
  const schedule = [...steps]
    .sort((a, b) => a.through.localeCompare(b.through))
    .map((s) => ({ through: s.through, registration_cents: cents(s.registration) ?? 0, event_cents: cents(s.event) ?? 0 }));
  const changes = {
    entry_fee_cents: cents(form.registration) ?? 0,
    extra_event_fee_cents: cents(form.event) ?? 0,
    first_event_included: form.included,
    price_schedule: schedule,
    refund_fee_cents: cents(form.refundFee) ?? 0,
  };
  useUnsaved('prices', { form, steps }, async () => {
    if (steps.some((s) => !s.through)) throw new Error('Pick a date for each price date.');
    if (new Set(steps.map((s) => s.through)).size !== steps.length) throw new Error('Each price date needs its own day.');
    await updateTournament(tournament.id, changes);
  });
  const money = (value: string, onChange: (value: string) => void, label?: string) => ({
    type: 'number',
    min: 0,
    step: '0.01',
    inputMode: 'decimal' as const,
    placeholder: '0.00',
    value,
    'aria-label': label,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
  });
  const setStep = (i: number, patch: Partial<StepDraft>) => setSteps((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <SettingsGroup title="Prices" description="All-in prices players see: bake processing and texting costs in.">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Field label="Registration fee ($)" hint="Once per player">
          <Input {...money(form.registration, (registration) => setForm({ ...form, registration }))} />
        </Field>
        <Field label="Event fee ($)" hint="Each event">
          <Input {...money(form.event, (event) => setForm({ ...form, event }))} />
        </Field>
        <Field label="Kept on refunds ($)">
          <Input {...money(form.refundFee, (refundFee) => setForm({ ...form, refundFee }))} />
        </Field>
      </div>
      <div>
        <Check label="First event included in registration" checked={form.included} onChange={(included) => setForm({ ...form, included })} />
        <p className="text-sm text-muted">
          {form.included
            ? 'The registration fee covers one event; each extra event costs the event fee. Each division’s settings say whether it can be the included event.'
            : 'Players pay the registration fee and the event fee for every event.'}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-medium">Price dates</span>
        <p className="-mt-1 text-sm text-muted">
          Optional: lower prices that step up on dates, through the end of each day. After the last date, the prices above apply.
        </p>
        {steps.length > 0 && (
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
            <span className="text-sm font-medium">Through</span>
            <span className="text-sm font-medium">Registration ($)</span>
            <span className="text-sm font-medium">Event ($)</span>
            <span />
            {steps.map((s, i) => (
              <Fragment key={i}>
                <Input type="date" aria-label="Through" value={s.through} onChange={(e) => setStep(i, { through: e.target.value })} />
                <Input {...money(s.registration, (registration) => setStep(i, { registration }), 'Registration fee ($)')} />
                <Input {...money(s.event, (event) => setStep(i, { event }), 'Event fee ($)')} />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove the price through ${s.through || 'this date'}`}
                  onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </Fragment>
            ))}
          </div>
        )}
        <Button
          size="sm"
          className="self-start"
          onClick={() => setSteps((all) => [...all, { through: '', registration: form.registration, event: form.event }])}
        >
          Add a price date
        </Button>
      </div>
      <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm">
        <span className="font-semibold">Today: </span>
        {priceSummary({ ...tournament, ...changes })}
      </p>
    </SettingsGroup>
  );
}
