'use client';

// How pricing works, with a calculator: players, entry fees and who pays the
// fees in; what each player pays, where it goes and what the director keeps out.
import Link from 'next/link';
import { useState } from 'react';
import { Card, Empty, Field, Input, Select, Spinner } from '@/components/ui';
import { getPlatformPricing } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useLoad } from '@/lib/hooks';
import { CARD_FIXED_CENTS, CARD_PERCENT, calculate, type PricingInputs } from '@/lib/pricing';

const money = (c: number) => formatMoney(Math.round(c));

export function PricingPage() {
  const pricing = useLoad(() => getPlatformPricing(), []);
  const [inputs, setInputs] = useState<PricingInputs>({
    players: 100,
    entryFee: 45,
    extraEventFee: 15,
    extraEvents: 0.5,
    texting: true,
    passToPlayers: false,
  });
  const set = <K extends keyof PricingInputs>(key: K, value: PricingInputs[K]) => setInputs((i) => ({ ...i, [key]: value }));

  if (pricing.error) return <Empty>{pricing.error}</Empty>;
  if (!pricing.data) return <Spinner />;
  const p = pricing.data;
  const r = calculate(inputs, p);
  const saving = r.ptFees - r.totals.platform;

  return (
    <div className="flex flex-col gap-12">
      <section>
        <h1 className="text-5xl sm:text-7xl">Simple pricing</h1>
        <p className="mt-3 max-w-2xl text-lg text-muted">
          A small flat fee per player. No percentage of your entries, no ads, no setup surprises. Card processing is passed
          through at cost.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <PriceCard price={money(p.setup_fee_cents)} per="per tournament" what="One-time setup, paid when you open registration. Practice tournaments are free." />
          <PriceCard price={money(p.per_player_cents)} per="per player" what="Registration, check-in, live courts, brackets, results and DUPR export." />
          <PriceCard price={money(p.texting_per_player_cents)} per="per player" what="Texting: court calls and score links by text. Optional; turn it off to skip it." />
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[22rem_1fr] [&>*]:min-w-0">
        <Card className="flex min-w-0 flex-col gap-4 self-start p-5">
          <h2 className="text-3xl">Try your numbers</h2>
          <Field label={`Players: ${inputs.players}`}>
            <input
              type="range"
              min={10}
              max={400}
              step={5}
              value={inputs.players}
              onChange={(e) => set('players', Number(e.target.value))}
              className="h-10 w-full accent-[var(--accent)]"
            />
            <Input className="w-full min-w-0" type="number" min={1} value={inputs.players} onChange={(e) => set('players', Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First event ($)">
              <Input className="w-full min-w-0" type="number" min={0} step={1} value={inputs.entryFee} onChange={(e) => set('entryFee', Number(e.target.value) || 0)} />
            </Field>
            <Field label="Each extra event ($)">
              <Input className="w-full min-w-0" type="number" min={0} step={1} value={inputs.extraEventFee} onChange={(e) => set('extraEventFee', Number(e.target.value) || 0)} />
            </Field>
          </div>
          <Field label="Extra events per player" hint="On average">
            <Select value={inputs.extraEvents} onChange={(e) => set('extraEvents', Number(e.target.value))}>
              {[0, 0.25, 0.5, 0.75, 1, 1.5, 2].map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? 'None (one event each)' : v}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-0.5 h-6 w-6 accent-[var(--accent)]" checked={inputs.texting} onChange={(e) => set('texting', e.target.checked)} />
            <span>
              <span className="block font-semibold">Text players</span>
              <span className="text-sm text-muted">{money(p.texting_per_player_cents)} per player</span>
            </span>
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Who pays the fees?</span>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface p-1" role="radiogroup">
              {(
                [
                  [false, 'Director', 'Take them out of entries'],
                  [true, 'Players', 'Add them to the price'],
                ] as const
              ).map(([pass, label, hint]) => (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={inputs.passToPlayers === pass}
                  onClick={() => set('passToPlayers', pass)}
                  className={`rounded-lg px-3 py-2 text-left ${inputs.passToPlayers === pass ? 'bg-accent text-accent-text' : 'hover:bg-surface-2'}`}
                >
                  <span className="block font-semibold">{label}</span>
                  <span className="text-xs opacity-80">{hint}</span>
                </button>
              ))}
            </div>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <BigNumber label="Each player pays" value={money(r.playerPays)} note={inputs.passToPlayers ? `${money(r.baseEntry)} entry + fees` : 'Your entry price, unchanged'} />
            <BigNumber label="You keep" value={money(r.totals.director)} note={`${money(r.totals.director / Math.max(1, inputs.players))} per player`} tone="text-live" />
          </div>

          <Card className="flex flex-col gap-3 p-5">
            <h3 className="text-2xl">Where each player’s {money(r.playerPays)} goes</h3>
            <SplitBar parts={[
              ['Director', r.perPlayer.director, 'var(--brand)'],
              ['Card processing', r.perPlayer.card, 'var(--idle)'],
              ['Courtside', r.perPlayer.platform, 'var(--info)'],
            ]} />
          </Card>

          <Card className="p-5">
            <h3 className="mb-3 text-2xl">For {inputs.players} players</h3>
            <dl className="tnum grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
              <Row label="Registrations collected" value={money(r.totals.collected)} strong />
              <Row label={`Card processing (${(CARD_PERCENT * 100).toFixed(1)}% + ${money(CARD_FIXED_CENTS)} per player, at cost)`} value={`−${money(r.totals.card)}`} />
              <Row label="Courtside setup (one time)" value={`−${money(r.totals.setup)}`} />
              <Row label={`Courtside ${money(p.per_player_cents)} × ${inputs.players} players`} value={`−${money(r.totals.playerFees)}`} />
              {inputs.texting && <Row label={`Texting ${money(p.texting_per_player_cents)} × ${inputs.players} players`} value={`−${money(r.totals.texting)}`} />}
              <dt className="border-t border-border pt-2 text-lg font-bold">You keep</dt>
              <dd className="border-t border-border pt-2 text-right text-lg font-bold text-live">{money(r.totals.director)}</dd>
            </dl>
          </Card>

          <Card className="flex flex-col gap-1 p-5">
            <h3 className="text-2xl [overflow-wrap:anywhere]">Compared with PickleballTournaments.com</h3>
            <p className="text-muted">
              Their published fees for the same registrations ($5 per registration + 7.99% of checkout, $25 setup
              {inputs.texting ? ', $0.25 texting per player' : ''}):{' '}
              <b className="text-text">{money(r.ptFees)}</b>, plus card processing if it’s charged separately. Ours:{' '}
              <b className="text-text">{money(r.totals.platform)}</b>.
            </p>
            {saving > 0 && (
              <p className="mt-1 font-display text-3xl font-bold text-live">You’d save {money(saving)}</p>
            )}
            <p className="text-xs text-muted">PT fees as published for tournaments opened from August 3, 2026. Check their site for current terms.</p>
          </Card>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Explainer title="You choose who pays">
          Keep your entry price and absorb the fees, or add them to the price so you keep the full entry. Either way, players
          see one price at checkout, with no surprise fees.
        </Explainer>
        <Explainer title="No ads, no tricks">
          No ads on your tournament pages, no blocked VPNs, no selling player data. Practice tournaments are free, so try
          everything first.
        </Explainer>
        <Explainer title="Built for match day">
          Players get a text with their court, format and a score link. Big, clear screens for every age, and directors run
          the courts from one desk.
        </Explainer>
      </section>

      <p className="text-center">
        <Link href="/" className="inline-flex h-12 items-center rounded-full bg-accent px-6 font-medium text-accent-text">
          Try a practice tournament
        </Link>
      </p>
    </div>
  );
}

function PriceCard({ price, per, what }: { price: string; per: string; what: string }) {
  return (
    <div className="rounded-2xl bg-surface-2 p-5">
      <p className="font-display text-6xl leading-none font-extrabold">{price}</p>
      <p className="text-sm font-semibold text-muted uppercase">{per}</p>
      <p className="mt-2">{what}</p>
    </div>
  );
}

function BigNumber({ label, value, note, tone = '' }: { label: string; value: string; note: string; tone?: string }) {
  return (
    <div className="rounded-2xl bg-surface-2 p-5">
      <p className="text-sm font-semibold tracking-widest text-muted uppercase">{label}</p>
      <p className={`tnum font-display text-6xl leading-none font-extrabold ${tone}`}>{value}</p>
      <p className="mt-1 text-muted">{note}</p>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <>
      <dt className={strong ? 'font-semibold' : 'text-muted'}>{label}</dt>
      <dd className={`text-right ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </>
  );
}

/** One bar split by share, with a legend that reads on its own. */
function SplitBar({ parts }: { parts: [string, number, string][] }) {
  const total = parts.reduce((s, [, v]) => s + Math.max(0, v), 0) || 1;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-8 overflow-hidden rounded-full" aria-hidden>
        {parts.map(([label, v, color]) => (
          <span key={label} style={{ width: `${(Math.max(0, v) / total) * 100}%`, background: color }} />
        ))}
      </div>
      <ul className="grid gap-2 sm:grid-cols-3">
        {parts.map(([label, v, color]) => (
          <li key={label} className="flex items-center gap-2">
            <span className="h-4 w-4 shrink-0 rounded-sm" style={{ background: color }} aria-hidden />
            <span>
              <span className="block font-semibold">{label}</span>
              <span className="tnum text-muted">
                {money(v)} · {Math.round((Math.max(0, v) / total) * 100)}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Explainer({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border p-5">
      <h3 className="text-2xl">{title}</h3>
      <p className="mt-2 text-muted">{children}</p>
    </div>
  );
}
