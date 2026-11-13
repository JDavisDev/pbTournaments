// "Where the money goes": every bill we pay to run Courtside, what each of our
// fees covers, and what we never take. The bills live in lib/costs.ts.
import { Card } from '@/components/ui';
import { textingAvailable } from '@/lib/config';
import { COSTS_UPDATED, MONTHLY_COSTS, USAGE_COSTS } from '@/lib/costs';
import { formatMoney } from '@/lib/format';
import { CARD_FIXED_CENTS, CARD_PERCENT } from '@/lib/pricing';
import type { PlatformPricing } from '@/lib/types';

const money = (c: number) => formatMoney(Math.round(c));
const updated = new Date(`${COSTS_UPDATED}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

export function OurCosts({ pricing: p }: { pricing: PlatformPricing }) {
  const monthly = MONTHLY_COSTS.filter((c) => textingAvailable || !c.texting);
  const usage = USAGE_COSTS.filter((c) => textingAvailable || !c.texting);
  const monthlyTotal = monthly.reduce((s, c) => s + c.monthlyCents, 0);
  // Players a month whose fee covers the fixed bills.
  const breakEven = p.per_player_cents > 0 ? Math.ceil(monthlyTotal / p.per_player_cents) : 0;
  const setupStripe = p.setup_fee_cents > 0 ? Math.round(p.setup_fee_cents * CARD_PERCENT) + CARD_FIXED_CENTS : 0;

  return (
    <section className="flex flex-col gap-6" aria-labelledby="costs">
      <div>
        <h2 id="costs" className="text-4xl sm:text-5xl">
          Where the money goes
        </h2>
        <p className="mt-2 max-w-2xl text-lg text-muted">
          Courtside is small and independent. Here is every bill we pay to keep it running, and what each of our fees
          pays for. Nothing hidden.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Card className="flex flex-col gap-3 p-5">
          <h3 className="text-2xl">What we pay each month</h3>
          <ul className="flex flex-col divide-y divide-border">
            {monthly.map((c) => (
              <CostRow key={c.name} name={c.name} plan={c.plan} does={c.does} amount={c.monthlyCents ? money(c.monthlyCents) : 'Free'} />
            ))}
          </ul>
          <div className="tnum flex items-baseline justify-between gap-4 border-t border-border pt-3 text-lg font-bold">
            <span>Total</span>
            <span>{money(monthlyTotal)} a month</span>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-3 p-5">
            <h3 className="text-2xl">Paid as we go</h3>
            <ul className="flex flex-col divide-y divide-border">
              {usage.map((c) => (
                <CostRow key={`${c.name}-${c.rate}`} name={c.name} plan={c.rate} does={c.does} />
              ))}
            </ul>
          </Card>

          {breakEven > 0 && (
            <div className="rounded-2xl bg-surface-2 p-5">
              <p className="text-sm font-semibold tracking-widest text-muted uppercase">Break-even</p>
              <p className="tnum font-display text-6xl leading-none font-extrabold text-live">{breakEven} players</p>
              <p className="mt-2">
                a month cover the bills, at {money(p.per_player_cents)} each. Every player after that pays for
                development, support and new features.
              </p>
            </div>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-3xl">What your fees pay for</h3>
        <div className={`mt-3 grid gap-3 ${textingAvailable ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
          <FeeCard price={money(p.setup_fee_cents)} per="setup, per tournament">
            You pay it to us by card, so Stripe keeps {money(setupStripe)} of it. The rest goes toward the monthly bills:
            the servers and database your tournament lives on from the day you open registration.
          </FeeCard>
          <FeeCard price={money(p.per_player_cents)} per="per player">
            Comes out of the player’s payment as Stripe’s platform fee, which costs us nothing extra. It pays for what
            that player uses (registration, emails, check-in, live courts, scores and results), then development and
            support.
          </FeeCard>
          {textingAvailable && (
            <FeeCard price={money(p.texting_per_player_cents)} per="texting, per player">
              Pays Twilio for the texts (court calls, court changes and score links) and the number they come from.
              Turn texting off and you don’t pay it.
            </FeeCard>
          )}
        </div>
      </div>

      <Card className="p-5">
        <h3 className="text-2xl">What we never take</h3>
        <ul className="mt-3 grid gap-x-8 gap-y-3 md:grid-cols-2">
          <Never title="A cut of your entries">
            Our fee is flat per player, not a percentage. A $90 entry costs the same as a $30 one.
          </Never>
          <Never title="Your players’ money">
            Payments go straight into your own Stripe account. We never hold tournament money.
          </Never>
          <Never title="Anything on card processing">
            Stripe’s {(CARD_PERCENT * 100).toFixed(1)}% + {money(CARD_FIXED_CENTS)} goes to Stripe at cost. We add nothing to it.
          </Never>
          <Never title="Ads or player data">
            No ads on your pages, and we don’t sell or share player data. The fees are how we pay the bills.
          </Never>
        </ul>
        <p className="mt-4 border-t border-border pt-3 text-sm text-muted">
          One thing to know: when you refund a player, our fee from that payment isn’t refunded, and neither is Stripe’s
          card fee. Basic tournaments are free, and the paid ones cover them.
        </p>
      </Card>

      <p className="text-sm text-muted">
        Figures as of {updated}, at each service’s current plan prices. As we grow, we’ll update them here.
      </p>
    </section>
  );
}

function CostRow({ name, plan, does, amount }: { name: string; plan?: string; does: string; amount?: string }) {
  return (
    <li className="flex items-start justify-between gap-4 py-3 first:pt-0">
      <div className="min-w-0">
        <p className="font-semibold">
          {name}
          {plan && <span className="font-normal text-muted"> · {plan}</span>}
        </p>
        <p className="text-sm text-muted">{does}</p>
      </div>
      {amount && <p className="tnum shrink-0 text-right font-semibold">{amount}</p>}
    </li>
  );
}

function FeeCard({ price, per, children }: { price: string; per: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-surface-2 p-5">
      <p className="font-display text-5xl leading-none font-extrabold">{price}</p>
      <p className="text-sm font-semibold text-muted uppercase">{per}</p>
      <p className="mt-2">{children}</p>
    </div>
  );
}

function Never({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li>
      <p className="font-semibold">{title}</p>
      <p className="text-muted">{children}</p>
    </li>
  );
}
