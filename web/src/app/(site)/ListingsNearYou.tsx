'use client';

import Link from 'next/link';
import { ListingCard } from '@/components/ListingCard';
import { Empty, Spinner } from '@/components/ui';
import { getListings, getRecentListings } from '@/lib/api';
import { localToday } from '@/lib/format';
import { useLoad, useSession } from '@/lib/hooks';
import { useListingState } from '@/lib/listingState';
import { stateName } from '@/lib/places';

const SHOWN = 6;

/** Home page: what's coming up in the state this device last browsed, else the newest listings. */
export function ListingsNearYou() {
  const session = useSession();
  const region = useListingState();
  const listings = useLoad(async () => {
    if (region === null) return undefined;
    const today = localToday();
    if (region) {
      const near = await getListings(region, today, SHOWN);
      if (near.length) return { near: true, list: near };
    }
    return { near: false, list: await getRecentListings(today, SHOWN) };
  }, [region]);

  const data = listings.data;
  return (
    <section className="mb-12">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <h2 className="text-3xl">{data?.near && region ? `Coming up in ${stateName[region]}` : 'Recently listed'}</h2>
        <Link href="/tournaments" className="inline-flex h-11 items-center font-medium underline underline-offset-4 hover:text-brand">
          {region ? 'See all tournaments' : 'Find tournaments near you'}
        </Link>
      </div>
      {region && data && !data.near && (
        <p className="mb-3 text-muted">Nothing is listed in {stateName[region]} yet. Here’s what’s new everywhere.</p>
      )}
      {listings.error ? (
        <Empty>{listings.error}</Empty>
      ) : !data ? (
        <Spinner />
      ) : data.list.length === 0 ? (
        <Empty>No upcoming tournaments are listed yet.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.list.map((l) => (
            <ListingCard key={l.id} listing={l} mine={l.created_by === session?.id} />
          ))}
        </div>
      )}
    </section>
  );
}
