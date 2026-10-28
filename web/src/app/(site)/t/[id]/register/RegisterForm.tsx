'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Select, Spinner } from '@/components/ui';
import {
  checkDiscountCode,
  getEvents,
  getPartnerPaidEvents,
  getRegistrationAvailability,
  getRegistrationQuestions,
  getTournament,
  startRegistration,
} from '@/lib/api';
import { describeDivision, entryProblem, type PlayerFacts } from '@/lib/eligibility';
import { formatMoney, formatTime, registrationPrice } from '@/lib/format';
import { useAction, useLoad, useNow } from '@/lib/hooks';

interface Choice {
  partner_name: string;
  partner_email: string;
  /** Pay the partner's entry too. */
  pay_for_partner: boolean;
}

const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const optionalNumber = (v: string) => (v.trim() === '' ? null : Number(v));

export function RegisterForm({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const cancelled = searchParams.get('cancelled');
  // A division's sign-up link (?event=) opens with that division picked.
  const linkedEvent = searchParams.get('event');
  const data = useLoad(async () => {
    const [tournament, events, availability, questions] = await Promise.all([
      getTournament(id),
      getEvents(id),
      getRegistrationAvailability(id),
      getRegistrationQuestions(id),
    ]);
    return { tournament, events, availability, questions };
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
    linkedEvent ? { [linkedEvent]: { partner_name: '', partner_email: '', pay_for_partner: false } } : {},
  );
  // Events whose entry fee a partner already paid for this email.
  const myEmail = emailPattern.test(me.email.trim()) ? me.email.trim().toLowerCase() : '';
  const partnerPaid = useLoad(() => (myEmail ? getPartnerPaidEvents(id, myEmail) : Promise.resolve([])), [id, myEmail]);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const submit = useAction();
  const now = useNow(60_000);
  const [code, setCode] = useState('');
  const [discount, setDiscount] = useState<{ code: string; cents: number } | null>(null);
  const codeCheck = useAction();
  const [waiverOk, setWaiverOk] = useState(false);

  if (data.error === 'not-configured') return <ConnectNotice />;
  if (data.error) return <Empty>{data.error}</Empty>;
  if (!data.data) return <Spinner />;
  const { tournament: t, events, availability, questions } = data.data;
  const paidByPartner = new Set(partnerPaid.data ?? []);
  const full = new Set(availability.filter((a) => a.full).map((a) => a.event_id));
  const spotsLeft = new Map(availability.map((a) => [a.event_id, a.spots_left]));
  const closesAt = t.registration_closes_at ? new Date(t.registration_closes_at).getTime() : null;

  if (t.status === 'registration' && closesAt !== null && closesAt < now) {
    return <Empty>Registration closed on {new Date(closesAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.</Empty>;
  }
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
  // Full divisions go on the waitlist and cost nothing until a spot opens.
  // An event a partner already paid for holds its spot, even in a full division.
  const coveredPicks = picks.filter(([eventId]) => paidByPartner.has(eventId));
  const waitlistPicks = picks.filter(([eventId]) => full.has(eventId) && !paidByPartner.has(eventId));
  const paidPicks = picks.filter(([eventId]) => !full.has(eventId) && !paidByPartner.has(eventId));
  const payingFor = paidPicks.filter(([, c]) => c.pay_for_partner);
  const count = paidPicks.length;
  const early = t.early_until && new Date(t.early_until).getTime() > now;
  const firstPrice = early ? (t.early_entry_fee_cents ?? t.entry_fee_cents) : t.entry_fee_cents;
  const extraPrice = early ? (t.early_extra_event_fee_cents ?? t.extra_event_fee_cents) : t.extra_event_fee_cents;
  // Same as start_registration: with an event a partner paid, each of yours is an extra event.
  const price =
    (coveredPicks.length > 0 ? count * extraPrice : registrationPrice(t, count, now)) + payingFor.length * firstPrice;
  const total = Math.max(0, price - (discount?.cents ?? 0));
  const needsWaiver = !!t.waiver_text?.trim();
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
      else next[eventId] = { partner_name: '', partner_email: '', pay_for_partner: false };
      return next;
    });
  const setPartner = <K extends keyof Choice>(eventId: string, field: K, value: Choice[K]) =>
    setChosen((c) => ({ ...c, [eventId]: { ...c[eventId], [field]: value } }));

  return (
    <form
      className="mx-auto flex max-w-xl flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run(async () => {
          const unanswered = questions.find((q) => q.required && q.kind === 'choices' && !(answers[q.id] as string[] | undefined)?.length);
          if (unanswered) throw new Error(`Please answer “${unanswered.label}”`);
          const reg = await startRegistration(id, {
            player: {
              ...me,
              gender: facts.gender || null,
              birth_date: facts.birth_date || null,
              dupr_doubles: optionalNumber(facts.dupr_doubles),
              dupr_singles: optionalNumber(facts.dupr_singles),
              self_rating: optionalNumber(facts.self_rating),
              dupr_id: facts.dupr_id.trim() || null,
              discount_code: discount?.code ?? (code.trim() || null),
              waiver_accepted: needsWaiver ? waiverOk : undefined,
              answers: Object.entries(answers).map(([question_id, answer]) => ({ question_id, answer })),
            },
            entries: picks.map(([event_id, c]) => ({
              event_id,
              ...c,
              pay_for_partner: c.pay_for_partner && !full.has(event_id) && !paidByPartner.has(event_id),
            })),
          });
          if (reg.status === 'paid' || reg.status === 'waitlisted') {
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
      {t.image_data && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={t.image_data} alt="" className="max-h-56 w-full rounded-2xl object-cover" />
      )}
      <div>
        <h2 className="text-4xl">Register</h2>
        <p className="mt-1 text-muted">
          {formatMoney(firstPrice)} for your first event, {formatMoney(extraPrice)} for each extra event
          {early && t.early_until ? ` (early price until ${new Date(t.early_until).toLocaleDateString()})` : ''}. One
          price, no added fees.
        </p>
        {closesAt && (
          <p className="mt-1 font-semibold">
            Registration closes {new Date(closesAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.
          </p>
        )}
      </div>
      {t.is_demo && (
        <p className="rounded-lg bg-called-soft px-3 py-2 text-called">
          Practice tournament: anyone trying the demo can see what you enter here. Use made-up names, phone numbers and
          emails.
        </p>
      )}
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
                    {e.not_before && t.times_published_at ? ` · starts ${formatTime(e.not_before, t.time_zone)}` : ''}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    {paidByPartner.has(e.id) ? (
                      <Badge tone="live">Your partner paid your entry</Badge>
                    ) : full.has(e.id) ? (
                      <Badge tone="called">Full: you’ll join the waitlist</Badge>
                    ) : spotsLeft.get(e.id) != null && spotsLeft.get(e.id)! <= 6 ? (
                      <Badge tone="info">{Math.ceil(spotsLeft.get(e.id)! / (e.kind === 'doubles' ? 2 : 1))} spots left</Badge>
                    ) : null}
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
                    hint={
                      picked.pay_for_partner
                        ? 'We email you their sign-up link'
                        : e.partner_required
                          ? 'They register separately'
                          : 'No partner yet? Leave blank and the desk will pair you.'
                    }
                  >
                    <Input
                      type="email"
                      required={e.partner_required || picked.pay_for_partner}
                      value={picked.partner_email}
                      onChange={(ev) => setPartner(e.id, 'partner_email', ev.target.value)}
                    />
                  </Field>
                  {!full.has(e.id) && !paidByPartner.has(e.id) && (
                    <label className="flex items-start gap-3 rounded-xl bg-surface-2 p-3 sm:col-span-2">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-5 w-5 accent-[var(--accent)]"
                        checked={picked.pay_for_partner}
                        onChange={(ev) => setPartner(e.id, 'pay_for_partner', ev.target.checked)}
                      />
                      <span>
                        <span className="font-medium">Pay for my partner too (+{formatMoney(firstPrice)})</span>
                        <span className="block text-sm text-muted">
                          Their spot is held. They still register to add their own details and agree to the waiver, and
                          this event costs them nothing.
                        </span>
                      </span>
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Card>

      {(payingFor.length > 0 || coveredPicks.length > 0) && (
        <p className="rounded-lg bg-live-soft px-3 py-2 text-live">
          {payingFor.length > 0 &&
            `Includes ${payingFor.map(([, c]) => c.partner_name.trim() || c.partner_email.trim()).join(' and ')}’s entry (${formatMoney(firstPrice)} each). `}
          {coveredPicks.length > 0 &&
            `Your partner already paid for ${coveredPicks.map(([eventId]) => events.find((e) => e.id === eventId)?.name).join(', ')}.`}
        </p>
      )}

      {count > 0 && (
        <Card className="flex flex-col gap-2 p-5">
          <Field label="Discount code" hint="Optional">
            <div className="flex gap-2">
              <Input
                className="min-w-0 flex-1 font-mono uppercase"
                value={code}
                onChange={(e) => (setCode(e.target.value), setDiscount(null))}
              />
              <Button
                type="button"
                disabled={!code.trim() || codeCheck.busy}
                onClick={() =>
                  codeCheck.run(async () => {
                    const r = await checkDiscountCode(id, code.trim(), price);
                    if (r.problem) throw new Error(r.problem);
                    setDiscount({ code: r.code!, cents: r.cents });
                  })
                }
              >
                Apply
              </Button>
            </div>
          </Field>
          {discount && <p className="text-live">{discount.code}: {formatMoney(discount.cents)} off.</p>}
          <ErrorText>{codeCheck.error}</ErrorText>
        </Card>
      )}

      {needsWaiver && (
        <Card className="flex flex-col gap-3 p-5">
          <h3 className="text-xl">Waiver</h3>
          <div className="max-h-56 overflow-y-auto rounded-xl bg-surface p-3 text-sm whitespace-pre-wrap">{t.waiver_text}</div>
          <label className="flex items-start gap-3">
            <input type="checkbox" required className="mt-0.5 h-6 w-6 accent-[var(--accent)]" checked={waiverOk} onChange={(e) => setWaiverOk(e.target.checked)} />
            <span className="font-medium">I have read and agree to the waiver.</span>
          </label>
        </Card>
      )}

      {questions.length > 0 && (
        <Card className="flex flex-col gap-4 p-5">
          <h3 className="text-xl">A few questions</h3>
          {questions.map((q) => {
            const label = q.required ? q.label : `${q.label} (optional)`;
            if (q.kind === 'text') {
              return (
                <Field key={q.id} label={label}>
                  <Input
                    required={q.required}
                    maxLength={500}
                    value={(answers[q.id] as string | undefined) ?? ''}
                    onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  />
                </Field>
              );
            }
            if (q.kind === 'choice') {
              return (
                <Field key={q.id} label={label}>
                  <Select
                    required={q.required}
                    value={(answers[q.id] as string | undefined) ?? ''}
                    onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {q.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </Select>
                </Field>
              );
            }
            const picked = (answers[q.id] as string[] | undefined) ?? [];
            return (
              <fieldset key={q.id} className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium">{label} · choose any</legend>
                {q.options.map((o) => (
                  <label key={o} className="flex min-h-11 items-center gap-3">
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-[var(--accent)]"
                      checked={picked.includes(o)}
                      onChange={(e) =>
                        setAnswers({ ...answers, [q.id]: e.target.checked ? [...picked, o] : picked.filter((x) => x !== o) })
                      }
                    />
                    {o}
                  </label>
                ))}
              </fieldset>
            );
          })}
        </Card>
      )}

      {t.refund_policy?.trim() && (
        <Card className="flex flex-col gap-2 p-5">
          <h3 className="text-xl">Refund policy</h3>
          <p className="whitespace-pre-wrap text-muted">{t.refund_policy}</p>
        </Card>
      )}

      {waitlistPicks.length > 0 && (
        <p className="rounded-lg bg-called-soft px-3 py-2 text-called">
          You’ll join the waitlist for {waitlistPicks.map(([eventId]) => events.find((e) => e.id === eventId)?.name).join(', ')}.
          Nothing is charged for it unless a spot opens; then we text and email you a link to pay.
        </p>
      )}

      <ErrorText>{submit.error}</ErrorText>
      <div className="sticky bottom-0 -mx-4 bg-bg/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:bg-transparent sm:p-0">
        <Button
          variant="primary"
          type="submit"
          className="h-14 w-full text-base"
          disabled={submit.busy || picks.length === 0 || (needsWaiver && !waiverOk)}
        >
          {submit.busy
            ? 'Starting checkout…'
            : picks.length === 0
              ? 'Choose an event'
              : count === 0 && coveredPicks.length === 0
                ? 'Join the waitlist'
                : total === 0
                  ? 'Register'
                  : `Continue to payment · ${formatMoney(total)}`}
        </Button>
      </div>
    </form>
  );
}
