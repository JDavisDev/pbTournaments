'use client';

// Setup sidebar cards: who runs the tournament, registration limits and
// extras (waiver, image, close date, refund policy), your own registration
// questions, and discount codes.
import { useState } from 'react';
import { Badge, Button, Card, ErrorText, Field, Input, Select, Textarea } from '@/components/ui';
import {
  addDiscountCode,
  addTournamentStaff,
  deleteDiscountCode,
  deleteRegistrationQuestion,
  getDiscountCodes,
  getRegistrationQuestions,
  saveRegistrationQuestion,
  getTournamentFees,
  getTournamentTeam,
  removeTournamentStaff,
  updateTournament,
} from '@/lib/api';
import { formatMoney, fromZonedInput, toZonedInput } from '@/lib/format';
import { useAction, useLoad } from '@/lib/hooks';
import { shrinkImage } from '@/lib/image';
import type { RegistrationQuestion, StaffRole, Tournament } from '@/lib/types';

const roleText: Record<StaffRole, string> = { admin: 'Admin', monitor: 'Court monitor' };

/** Share the tournament with other admins and court monitors, by email. */
export function SharingCard({ tournament }: { tournament: Tournament }) {
  const team = useLoad(() => getTournamentTeam(tournament.id), [tournament.id]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('monitor');
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-xl">Sharing</h2>
        <p className="text-xs text-muted">
          <b>Admins</b> can change everything. <b>Court monitors</b> see the courts and queue, enter scores, check players in
          and send a no-show back to the queue.
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-border text-sm">
        {(team.data ?? []).map((m) => (
          <li key={`${m.source}-${m.email ?? 'guest'}`} className="flex items-center justify-between gap-2 py-2">
            <span className="min-w-0">
              <span className="block truncate font-medium">
                {m.email ?? 'Guest'}
                {m.is_me ? ' (you)' : ''}
              </span>
              <span className="text-xs text-muted">
                {roleText[m.role]}
                {m.source === 'organization' ? ' · whole organization' : m.source === 'invite' ? ' · invited, not signed up yet' : ''}
              </span>
            </span>
            {m.source !== 'organization' && !m.is_me && m.email && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => run(() => removeTournamentStaff(tournament.id, m.email!), team.reload)}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setNote(null);
          run(async () => {
            const result = await addTournamentStaff(tournament.id, email, role);
            setNote(
              result === 'invited'
                ? `${email} doesn’t have an account yet. They’ll get access when they sign up with that email.`
                : `${email} added as ${roleText[role].toLowerCase()}.`,
            );
            setEmail('');
          }, team.reload);
        }}
      >
        <Input type="email" required placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="flex gap-2">
          <Select className="flex-1" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
            <option value="monitor">Court monitor</option>
            <option value="admin">Admin</option>
          </Select>
          <Button type="submit" disabled={busy || !email}>
            Add
          </Button>
        </div>
      </form>
      {note && <p className="text-sm text-live">{note}</p>}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

/** Registration limits and extras. */
export function RegistrationCard({ tournament, onChanged }: { tournament: Tournament; onChanged: () => void }) {
  const tz = tournament.time_zone;
  const [form, setForm] = useState({
    max_players: tournament.max_players?.toString() ?? '',
    closes: toZonedInput(tournament.registration_closes_at, tz),
    waiver: tournament.waiver_text ?? '',
    refundPolicy: tournament.refund_policy ?? '',
  });
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-xl">Registration</h2>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Tournament image</span>
        {tournament.image_data ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={tournament.image_data} alt="" className="max-h-40 w-full rounded-xl object-cover" />
        ) : (
          <p className="text-xs text-muted">A logo or banner, shown on the tournament page and sign-up form.</p>
        )}
        <div className="flex gap-2">
          <label className="inline-flex h-10 cursor-pointer items-center rounded-full border border-border px-4 text-sm font-medium hover:border-text">
            {tournament.image_data ? 'Change image' : 'Add an image'}
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) run(async () => updateTournament(tournament.id, { image_data: await shrinkImage(file) }), onChanged);
              }}
            />
          </label>
          {tournament.image_data && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => updateTournament(tournament.id, { image_data: null }), onChanged)}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          run(
            () =>
              updateTournament(tournament.id, {
                max_players: form.max_players ? Number(form.max_players) : null,
                registration_closes_at: form.closes ? new Date(fromZonedInput(form.closes, tz)).toISOString() : null,
                waiver_text: form.waiver.trim() || null,
                refund_policy: form.refundPolicy.trim() || null,
              }),
            () => (setSaved(true), onChanged()),
          );
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Max players" hint="Whole tournament. Then the waitlist.">
            <Input type="number" min={1} placeholder="No limit" value={form.max_players} onChange={(e) => setForm({ ...form, max_players: e.target.value })} />
          </Field>
          <Field label="Registration closes">
            <Input type="datetime-local" value={form.closes} onChange={(e) => setForm({ ...form, closes: e.target.value })} />
          </Field>
        </div>
        <p className="-mt-1 text-xs text-muted">Each division’s own limit is “Max teams” in its settings. Full divisions take a waitlist too.</p>
        <Field label="Waiver" hint="Optional. Players must agree to it to register.">
          <Textarea rows={5} value={form.waiver} onChange={(e) => setForm({ ...form, waiver: e.target.value })} placeholder="I understand pickleball involves risk of injury…" />
        </Field>
        <Field
          label="Refund policy"
          hint="Shown on the tournament page, at registration and when a player withdraws. Withdrawals credit what the entry cost; you decide the refund."
        >
          <Textarea
            rows={4}
            maxLength={5000}
            value={form.refundPolicy}
            onChange={(e) => setForm({ ...form, refundPolicy: e.target.value })}
            placeholder="Full refund less a $5 processing fee until 7 days before the tournament. No refunds after that."
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        {saved && <p className="text-sm text-live">Saved.</p>}
        <Button type="submit" disabled={busy}>
          Save registration settings
        </Button>
      </form>
    </Card>
  );
}

/** Discount codes players enter at registration. */
export function DiscountCodesCard({ tournament }: { tournament: Tournament }) {
  const codes = useLoad(() => getDiscountCodes(tournament.id), [tournament.id]);
  const [form, setForm] = useState({ code: '', kind: 'percent', value: '', maxUses: '', expires: '' });
  const { busy, error, run } = useAction();

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-xl">Discount codes</h2>
      {(codes.data ?? []).length === 0 ? (
        <p className="text-xs text-muted">None yet. Players enter a code when they register.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border text-sm">
          {codes.data!.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-2">
              <span>
                <span className="font-mono font-semibold">{c.code}</span>{' '}
                <Badge tone="live">{c.percent_off ? `${c.percent_off}% off` : `${formatMoney(c.amount_off_cents ?? 0)} off`}</Badge>
                <span className="block text-xs text-muted">
                  {[c.max_uses ? `up to ${c.max_uses} uses` : 'unlimited uses', c.expires_at ? `until ${new Date(c.expires_at).toLocaleDateString()}` : '']
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => deleteDiscountCode(c.id), codes.reload)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid grid-cols-2 gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () =>
              addDiscountCode({
                tournament_id: tournament.id,
                code: form.code.trim().toUpperCase(),
                percent_off: form.kind === 'percent' ? Number(form.value) : null,
                amount_off_cents: form.kind === 'amount' ? Math.round(Number(form.value) * 100) : null,
                max_uses: form.maxUses ? Number(form.maxUses) : null,
                expires_at: form.expires ? new Date(fromZonedInput(`${form.expires}T23:59`, tournament.time_zone)).toISOString() : null,
              }),
            () => (setForm({ code: '', kind: 'percent', value: '', maxUses: '', expires: '' }), codes.reload()),
          );
        }}
      >
        <Input className="col-span-2 font-mono uppercase" required placeholder="CODE, e.g. MEMBER10" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          <option value="percent">% off</option>
          <option value="amount">$ off</option>
        </Select>
        <Input type="number" min={1} step={form.kind === 'percent' ? 1 : 0.01} required placeholder={form.kind === 'percent' ? '10' : '5.00'} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
        <Input type="number" min={1} placeholder="Max uses (optional)" value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
        <Input type="date" aria-label="Expires (optional)" value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
        <Button type="submit" className="col-span-2" disabled={busy || !form.code || !form.value}>
          Add code
        </Button>
      </form>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

/** What this tournament costs on the platform, the setup fee, and the texting switch. */
export function FeesCard({ tournament, onChanged }: { tournament: Tournament; onChanged: () => void }) {
  const fees = useLoad(() => getTournamentFees(tournament.id), [tournament.id, tournament.texts_enabled, tournament.setup_paid_at]);
  const { busy, error, run } = useAction();
  const f = fees.data;
  if (!f) return null;

  const paySetup = () =>
    run(async () => {
      const res = await fetch('/api/checkout/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tournamentId: tournament.id }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!body.url) throw new Error(body.error ?? 'Could not start checkout');
      window.location.href = body.url;
    });

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl">Fees</h2>
        {f.is_demo && <Badge tone="called">Practice: free</Badge>}
      </div>

      <div className="flex items-center justify-between gap-3 rounded-xl bg-surface p-3">
        <span>
          <span className="block font-semibold">Setup fee</span>
          <span className="text-sm text-muted">One time. Needed before registration opens or play starts.</span>
        </span>
        {f.setup_due_cents === 0 ? (
          <Badge tone="live">{f.is_demo ? 'Not needed' : 'Paid'}</Badge>
        ) : (
          <Button size="sm" variant="primary" disabled={busy} onClick={paySetup}>
            Pay {formatMoney(f.setup_due_cents)}
          </Button>
        )}
      </div>

      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
        <dt>
          Players · {formatMoney(f.per_player_cents)} each × {f.players}
        </dt>
        <dd className="tnum text-right">{formatMoney(f.players * f.per_player_cents)}</dd>
        <dt className={f.texts_enabled ? '' : 'text-muted line-through'}>
          Texting · {formatMoney(f.texting_per_player_cents)} each × {f.players}
        </dt>
        <dd className={`tnum text-right ${f.texts_enabled ? '' : 'text-muted line-through'}`}>
          {formatMoney(f.players * f.texting_per_player_cents)}
        </dd>
        <dt className="border-t border-border pt-1 font-semibold">{f.is_demo ? 'Would cost (practice is free)' : 'Player fees so far'}</dt>
        <dd className="tnum border-t border-border pt-1 text-right font-semibold">
          {formatMoney(f.is_demo ? f.players * (f.per_player_cents + (f.texts_enabled ? f.texting_per_player_cents : 0)) : f.player_fees_cents)}
        </dd>
      </dl>

      <label className="flex items-start gap-3 rounded-xl bg-surface p-3">
        <input
          type="checkbox"
          className="mt-0.5 h-6 w-6 shrink-0 accent-[var(--accent)]"
          checked={tournament.texts_enabled}
          disabled={busy}
          onChange={(e) => run(() => updateTournament(tournament.id, { texts_enabled: e.target.checked }), onChanged)}
        />
        <span>
          <span className="block font-semibold">Text players</span>
          <span className="text-sm text-muted">
            Court calls, messages and waitlist offers by text. Turn off to save {formatMoney(f.texting_per_player_cents)} per
            player; emails still go out and players can follow their team page.
          </span>
        </span>
      </label>
      <p className="text-xs text-muted">Tip: build these into your entry price so players see one all-in price.</p>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

const kindText: Record<RegistrationQuestion['kind'], string> = {
  text: 'Short answer',
  choice: 'One choice',
  choices: 'Multiple choices',
};

const blankQuestion = { id: undefined as string | undefined, label: '', kind: 'choice' as RegistrationQuestion['kind'], options: '', required: false };

/** Your own questions at registration: T-shirt size, home club, lunch… */
export function QuestionsCard({ tournament }: { tournament: Tournament }) {
  const questions = useLoad(() => getRegistrationQuestions(tournament.id), [tournament.id]);
  const [form, setForm] = useState(blankQuestion);
  const { busy, error, run } = useAction();
  const list = questions.data ?? [];
  const options = form.options.split('\n').map((o) => o.trim()).filter(Boolean);

  const save = (q: RegistrationQuestion | (Omit<RegistrationQuestion, 'id'> & { id?: string })) =>
    saveRegistrationQuestion({
      id: q.id,
      tournament_id: tournament.id,
      label: q.label,
      kind: q.kind,
      options: q.options,
      required: q.required,
      sort_order: q.sort_order,
    });
  /** Swaps a question with its neighbor, numbering the whole list again. */
  const move = (i: number, by: -1 | 1) =>
    run(async () => {
      const order = [...list];
      [order[i], order[i + by]] = [order[i + by], order[i]];
      for (const [n, q] of order.entries()) if (q.sort_order !== n) await save({ ...q, sort_order: n });
    }, questions.reload);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-xl">Registration questions</h2>
        <p className="text-sm text-muted">Anything you need from players: T-shirt size, home club, lunch. Answers show on Registrations.</p>
      </div>
      {list.length > 0 && (
        <ol className="flex flex-col divide-y divide-border text-sm">
          {list.map((q, i) => (
            <li key={q.id} className="flex flex-col gap-1 py-2">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{q.label}</span>
                <Badge>{kindText[q.kind]}</Badge>
                {q.required && <Badge tone="info">Required</Badge>}
              </span>
              {q.kind !== 'text' && <span className="text-muted">{q.options.join(' · ')}</span>}
              <span className="flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm({ ...q, options: q.options.join('\n') })}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" disabled={busy || i === 0} aria-label={`Move ${q.label} up`} onClick={() => move(i, -1)}>
                  Up
                </Button>
                <Button size="sm" variant="ghost" disabled={busy || i === list.length - 1} aria-label={`Move ${q.label} down`} onClick={() => move(i, 1)}>
                  Down
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-late"
                  disabled={busy}
                  onClick={() =>
                    confirm(`Delete “${q.label}”? Answers players already gave to it are deleted too.`) &&
                    run(() => deleteRegistrationQuestion(q.id), questions.reload)
                  }
                >
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <form
        className="flex flex-col gap-3 rounded-xl bg-surface p-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () =>
              save({
                id: form.id,
                tournament_id: tournament.id,
                label: form.label.trim(),
                kind: form.kind,
                options: form.kind === 'text' ? [] : options,
                required: form.required,
                sort_order: form.id ? (list.find((q) => q.id === form.id)?.sort_order ?? 0) : list.length,
              }),
            () => (setForm(blankQuestion), questions.reload()),
          );
        }}
      >
        <h3 className="font-medium">{form.id ? 'Edit question' : 'Add a question'}</h3>
        <Field label="Question">
          <Input required maxLength={200} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="T-shirt size" />
        </Field>
        <Field label="Answer">
          <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as RegistrationQuestion['kind'] })}>
            <option value="choice">Pick one from a list</option>
            <option value="choices">Pick any from a list</option>
            <option value="text">Short answer (they type it)</option>
          </Select>
        </Field>
        {form.kind !== 'text' && (
          <Field label="Choices" hint="One per line.">
            <Textarea
              rows={4}
              required
              value={form.options}
              onChange={(e) => setForm({ ...form, options: e.target.value })}
              placeholder={'S\nM\nL\nXL'}
            />
          </Field>
        )}
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[var(--accent)]"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Players must answer
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !form.label.trim() || (form.kind !== 'text' && options.length === 0)}>
            {form.id ? 'Save question' : 'Add question'}
          </Button>
          {form.id && (
            <Button type="button" variant="ghost" onClick={() => setForm(blankQuestion)}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
