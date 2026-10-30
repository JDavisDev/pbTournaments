'use client';

import Link from 'next/link';
import { HostedCard, ListingCard } from '@/components/ListingCard';
import { Empty, Spinner } from '@/components/ui';
import { getListings } from '@/lib/api';
import { localToday } from '@/lib/format';
import { useLoad, useSession } from '@/lib/hooks';
import { useListingState } from '@/lib/listingState';
import { stateName } from '@/lib/places';
import type { Tournament } from '@/lib/types';

const SHOWN = 6;

/**
 * Home page: what's coming up soonest, in the state this device last browsed
 * (else everywhere). `hosted`: tournaments run here with registration open,
 * mixed in by date.
 */
export function ListingsNearYou({ hosted = [] }: { hosted?: Tournament[] }) {
  const session = useSession();
  const region = useListingState();
  const listings = useLoad(async () => {
    if (region === null) return undefined;
    const today = localToday();
    if (region) {
      const near = await getListings(region, today, SHOWN);
      if (near.length) return { near: true, list: near, today };
    }
    return { near: false, list: await getListings(null, today, SHOWN), today };
  }, [region]);

  const data = listings.data;
  const upcoming = data && [
    ...data.list.map((l) => ({ date: l.starts_on, card: <ListingCard key={l.id} listing={l} mine={l.created_by === session?.id} /> })),
    ...hosted
      .filter((t) => t.status === 'registration' && !t.is_demo && t.starts_on >= data.today)
      .map((t) => ({ date: t.starts_on, card: <HostedCard key={t.id} tournament={t} /> })),
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, SHOWN);

  return (
    <section className="mb-12">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <h2 className="text-3xl">{data?.near && region ? `Upcoming in ${stateName[region]}` : 'Upcoming'}</h2>
        <Link href="/tournaments" className="inline-flex h-11 items-center font-medium underline underline-offset-4 hover:text-brand">
          {region ? 'See all tournaments' : 'Find tournaments near you'}
        </Link>
      </div>
      {region && data && !data.near && (
        <p className="mb-3 text-muted">Nothing is listed in {stateName[region]} yet. Here’s what’s coming up everywhere.</p>
      )}
      {listings.error ? (
        <Empty>{listings.error}</Empty>
      ) : !upcoming ? (
        <Spinner />
      ) : upcoming.length === 0 ? (
        <Empty>No upcoming tournaments yet.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{upcoming.map((u) => u.card)}</div>
      )}
    </section>
  );
}
