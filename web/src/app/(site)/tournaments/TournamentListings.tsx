'use client';

import { useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { ListingCard } from '@/components/ListingCard';
import { Empty, Field, Input, LinkButton, PageTitle, Select, Spinner } from '@/components/ui';
import { getListings } from '@/lib/api';
import { isBackendConfigured } from '@/lib/config';
import { localToday } from '@/lib/format';
import { useLoad, useSession } from '@/lib/hooks';
import { setListingState, useListingState } from '@/lib/listingState';
import { stateName, US_STATES } from '@/lib/places';
import type { TournamentListing } from '@/lib/types';

const monthOf = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

export function TournamentListings() {
  const session = useSession();
  const region = useListingState();
  const listings = useLoad(
    () => (region === null ? Promise.resolve(undefined) : getListings(region || null, localToday())),
    [region],
  );
  const [search, setSearch] = useState('');

  if (!isBackendConfigured) return <ConnectNotice />;

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (listings.data ?? []).filter((l) => {
    const text = [l.name, l.venue, l.city, l.state, stateName[l.state]].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const months = new Map<string, TournamentListing[]>();
  for (const l of shown) months.set(monthOf(l.starts_on), [...(months.get(monthOf(l.starts_on)) ?? []), l]);

  return (
    <>
      <PageTitle
        title="Find a tournament"
        subtitle="Tournaments near you. Sign up on the tournament’s own site."
        actions={
          <LinkButton variant="primary" href="/tournaments/new">
            List your tournament
          </LinkButton>
        }
      />
      <div className="mb-8 grid gap-4 sm:max-w-2xl sm:grid-cols-2">
        <Field label="State">
          <Select value={region ?? ''} onChange={(e) => setListingState(e.target.value)}>
            <option value="">All states</option>
            {US_STATES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Search">
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="City, venue or name" />
        </Field>
      </div>

      {listings.error ? (
        <Empty>{listings.error}</Empty>
      ) : listings.data === undefined ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <Empty>
          {search
            ? 'No tournaments match that search.'
            : `No upcoming tournaments listed${region ? ` in ${stateName[region]}` : ''} yet.`}
        </Empty>
      ) : (
        [...months].map(([month, list]) => (
          <section key={month} className="mb-10">
            <h2 className="mb-3 text-3xl">{month}</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((l) => (
                <ListingCard key={l.id} listing={l} mine={l.created_by === session?.id} />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}
