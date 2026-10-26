'use client';

import Link from 'next/link';
import { getPlatformPricing } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useLoad } from '@/lib/hooks';

/** The platform's prices for directors, from the database. */
export function PricingBlock() {
  const pricing = useLoad(() => getPlatformPricing(), []);
  const p = pricing.data;
  if (!p) return null;
  const items: [string, string, string][] = [
    [formatMoney(p.setup_fee_cents), 'per tournament', 'One-time setup'],
    [formatMoney(p.per_player_cents), 'per player', 'Courts, brackets, check-in, results'],
    [formatMoney(p.texting_per_player_cents), 'per player', 'Texting, optional. Turn it off to skip it.'],
  ];
  return (
    <section className="mb-12">
      <h2 className="text-4xl">Simple pricing</h2>
      <p className="mt-1 max-w-prose text-muted">
        No percentage of your entries, no ads, no surprises. Card processing is at cost.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {items.map(([price, per, what]) => (
          <div key={what} className="rounded-2xl bg-surface-2 p-5">
            <p className="font-display text-5xl leading-none font-extrabold">{price}</p>
            <p className="text-sm font-semibold text-muted uppercase">{per}</p>
            <p className="mt-2">{what}</p>
          </div>
        ))}
      </div>
      <Link href="/pricing" className="mt-4 inline-flex h-12 items-center rounded-full border border-border px-6 font-medium hover:border-text">
        See how pricing works, with a calculator
      </Link>
    </section>
  );
}
