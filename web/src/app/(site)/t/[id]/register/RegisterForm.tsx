'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Button, Card, Empty, ErrorText, Field, Input, Select, Spinner } from '@/components/ui';
import { getEvents, getTournament, startRegistration } from '@/lib/api';
import { describeDivision, entryProblem, type PlayerFacts } from '@/lib/eligibility';
import { formatMoney, formatTime, registrationPrice } from '@/lib/format';
import { useAction, useLoad, useNow } from '@/lib/hooks';

interface Choice {
  partner_name: string;
  partner_email: string;
}

const optionalNumber = (v: string) => (v.trim() === '' ? null : Number(v));

export function RegisterForm({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const cancelled = searchParams.get('cancelled');
  // A division's sign-up link (?event=) opens with that division picked.
  const linkedEvent = searchParams.get('event');
  const data = useLoad(async () => {
    const [tournament, events] = await Promise.all([getTournament(id), getEvents(id)]);
    return { tournament, events };
  }, [id]);
  const [me, setMe] = useState({ first_name: '', last_name: '', email: '', phone: '', sms_opt_in: true });
  const [facts, setFacts] = useState<PlayerFacts>({
    gender: '',
    birth_date: '',
    dupr_doubles: '',
    dupr_singles: '',
    self_rating: '',
    dupr_id: '',
  });
  const [chosen, setChosen] = useState<Record<string, Choice>>(() =>
    linkedEvent ? { [linkedEvent]: { partner_name: '', partner_email: '' } } : {},
  );
  const submit = useAction();
  const now = useNow(60_000);

  if (data.error === 'not-configured') return <ConnectNotice />;
  if (data.error) return <Empty>{data.error}</Empty>;
  if (!data.data) return <Spinner />;
  const { tournament: t, events } = data.data;

  if (t.status !== 'registration') {
    return (
      <Empty>
        {t.status === 'live' || t.status === 'complete'
          ? 'Registration for this tournament is closed.'
          : 'Registration isn’t open yet.'}
      </Empty>
    );
  }

  // Ignore a linked division that isn't in this tournament.
  const picks = Object.entries(chosen).filter(([eventId]) => events.some((e) => e.id === eventId));
  const count = picks.length;
  const total = registrationPrice(t, count, now);
  const early = t.early_until && new Date(t.early_until).getTime() > now;
  const firstPrice = early ? (t.early_entry_fee_cents ?? t.entry_fee_cents) : t.entry_fee_cents;
  const extraPrice = early ? (t.early_extra_event_fee_cents ?? t.extra_event_fee_cents) : t.extra_event_fee_cents;
  const problems = Object.fromEntries(events.map((e) => [e.id, entryProblem(e, t.starts_on, facts)]));
  // Only ask for what some event needs.
  const needsAge = events.some((e) => e.min_age !== null || e.max_age !== null);
  const needsRating = events.some((e) => e.skill_rule !== 'open');
  const needsDuprId = events.some((e) => e.require_dupr_id);
  const hasSingles = events.some((e) => e.kind === 'singles' && e.skill_rule !== 'open');

  const toggle = (eventId: string) =>
    setChosen((c) => {
      const next = { ...c };
      if (next[eventId]) delete next[eventId];
      else next[eventId] = { partner_name: '', partner_email: '' };
      return next;
    });
  const setPartner = (eventId: string, field: keyof Choice, value: string) =>
    setChosen((c) => ({ ...c, [eventId]: { ...c[eventId], [field]: value } }));

  return (
    <form
      className="mx-auto flex max-w-xl flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run(async () => {
          const reg = await startRegistration(id, {
            player: {
              ...me,
              gender: facts.gender || null,
              birth_date: facts.birth_date || null,
              dupr_doubles: optionalNumber(facts.dupr_doubles),
              dupr_singles: optionalNumber(facts.dupr_singles),
              self_rating: optionalNumber(facts.self_rating),
              dupr_id: facts.dupr_id.trim() || null,
            },
            entries: picks.map(([event_id, c]) => ({ event_id, ...c })),
          });
          if (reg.status === 'paid') {
            router.push(`/t/${id}/register/done?r=${reg.registration_id}`);
            return;
          }
          const res = await fetch('/api/checkout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ registrationId: reg.registration_id }),
          });
          const body = (await res.json()) as { url?: string; error?: string };
          if (!body.url) throw new Error(body.error ?? 'Could not start checkout');
          window.location.href = body.url;
        });
      }}
    >
      <div>
        <h2 className="text-4xl">Register</h2>
        <p className="mt-1 text-muted">
          {formatMoney(firstPrice)} for your first event, {formatMoney(extraPrice)} for each extra event
          {early && t.early_until ? ` (early price until ${new Date(t.early_until).toLocaleDateString()})` : ''}. One
          price, no added fees.
        </p>
      </div>
      {cancelled && (
        <p className="rounded-lg bg-called-soft px-3 py-2 text-sm text-called">
          Payment was cancelled, so you’re not registered yet. You can try again.
        </p>
      )}

      <Card className="flex flex-col gap-3 p-5">
        <h3 className="text-xl">Your details</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input required autoComplete="given-name" value={me.first_name} onChange={(e) => setMe({ ...me, first_name: e.target.value })} />
          </Field>
          <Field label="Last name">
            <Input required autoComplete="family-name" value={me.last_name} onChange={(e) => setMe({ ...me, last_name: e.target.value })} />
          </Field>
        </div>
        <Field label="Email">
          <Input type="email" required autoComplete="email" value={me.email} onChange={(e) => setMe({ ...me, email: e.target.value })} />
        </Field>
        <Field label="Mobile number">
          <Input
            type="tel"
            autoComplete="tel"
            placeholder="(555) 123-4567"
            value={me.phone}
            onChange={(e) => setMe({ ...me, phone: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Gender" hint="For men’s, women’s and mixed events">
            <Select value={facts.gender} onChange={(e) => setFacts({ ...facts, gender: e.target.value as PlayerFacts['gender'] })}>
              <option value="">Choose…</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </Select>
          </Field>
          {needsAge && (
            <Field label="Date of birth" hint="For age divisions">
              <Input
                type="date"
                autoComplete="bday"
                value={facts.birth_date}
                onChange={(e) => setFacts({ ...facts, birth_date: e.target.value })}
              />
            </Field>
          )}
        </div>
        <Field
          label={needsDuprId ? 'DUPR ID' : 'DUPR ID (optional)'}
          hint="On your DUPR profile, under your name. We use it to check ratings and send your results to DUPR."
        >
          <Input
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. 7K2QXW"
            value={facts.dupr_id}
            onChange={(e) => setFacts({ ...facts, dupr_id: e.target.value.toUpperCase() })}
          />
        </Field>
        {needsRating && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="DUPR doubles">
              <Input
                type="number"
                step="0.001"
                min="1"
                max="8"
                inputMode="decimal"
                value={facts.dupr_doubles}
                onChange={(e) => setFacts({ ...facts, dupr_doubles: e.target.value })}
              />
            </Field>
            {hasSingles ? (
              <Field label="DUPR singles">
                <Input
                  type="number"
                  step="0.001"
                  min="1"
                  max="8"
                  inputMode="decimal"
                  value={facts.dupr_singles}
                  onChange={(e) => setFacts({ ...facts, dupr_singles: e.target.value })}
                />
              </Field>
            ) : (
              <Field label="Self-rating" hint="If you have no DUPR">
                <Input
                  type="number"
                  step="0.5"
                  min="1"
                  max="6"
                  inputMode="decimal"
                  value={facts.self_rating}
                  onChange={(e) => setFacts({ ...facts, self_rating: e.target.value })}
                />
              </Field>
            )}
          </div>
        )}
        {needsRating && hasSingles && (
          <Field label="Self-rating" hint="If you have no DUPR">
            <Input
              type="number"
              step="0.5"
              min="1"
              max="6"
              inputMode="decimal"
              value={facts.self_rating}
              onChange={(e) => setFacts({ ...facts, self_rating: e.target.value })}
            />
          </Field>
        )}
        <label className="flex items-start gap-3 rounded-xl bg-surface p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5 accent-[var(--accent)]"
            checked={me.sms_opt_in}
            onChange={(e) => setMe({ ...me, sms_opt_in: e.target.checked })}
          />
          <span>
            <span className="font-medium">Text me match and court updates</span>
            <span className="block text-muted">
              Only tournament updates, like which court to go to. Reply STOP to opt out.
            </span>
          </span>
        </label>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <h3 className="text-xl">Events</h3>
        {events.length === 0 && <p className="text-sm text-muted">No events yet.</p>}
        {events.map((e) => {
          const picked = chosen[e.id];
          const problem = problems[e.id];
          // "Needs your ..." isn't a no: it just means fill in that field first.
          const blocked = problem !== null && !problem.startsWith('needs');
          return (
            <div
              key={e.id}
              className={`rounded-xl border p-3 ${picked ? 'border-text bg-surface' : 'border-border'} ${blocked && !picked ? 'opacity-50' : ''}`}
            >
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-5 w-5 accent-[var(--accent)]"
                  checked={!!picked}
                  disabled={blocked && !picked}
                  onChange={() => toggle(e.id)}
                />
                <span>
                  <span className="font-medium">{e.name}</span>
                  <span className="block text-sm text-muted">
                    {describeDivision(e)}
                    {e.not_before ? ` · starts ${formatTime(e.not_before, t.time_zone)}` : ''}
                  </span>
                  {problem && (
                    <span className={`block text-sm ${blocked ? 'text-late' : 'text-called'}`}>This event {problem}.</span>
                  )}
                </span>
              </label>
              {picked && e.kind === 'doubles' && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label={e.partner_required ? 'Partner’s name' : 'Partner’s name (optional)'}>
                    <Input
                      required={e.partner_required}
                      value={picked.partner_name}
                      onChange={(ev) => setPartner(e.id, 'partner_name', ev.target.value)}
                    />
                  </Field>
                  <Field
                    label={e.partner_required ? 'Partner’s email' : 'Partner’s email (optional)'}
                    hint={e.partner_required ? 'They register and pay separately' : 'No partner yet? Leave blank and the desk will pair you.'}
                  >
                    <Input
                      type="email"
                      required={e.partner_required}
                      value={picked.partner_email}
                      onChange={(ev) => setPartner(e.id, 'partner_email', ev.target.value)}
                    />
                  </Field>
                </div>
              )}
            </div>
          );
        })}
      </Card>

      <ErrorText>{submit.error}</ErrorText>
      <div className="sticky bottom-0 -mx-4 bg-bg/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:bg-transparent sm:p-0">
        <Button variant="primary" type="submit" className="h-14 w-full text-base" disabled={submit.busy || count === 0}>
          {submit.busy
            ? 'Starting checkout…'
            : count === 0
              ? 'Choose an event'
              : total === 0
                ? 'Register'
                : `Continue to payment · ${formatMoney(total)}`}
        </Button>
      </div>
    </form>
  );
}
