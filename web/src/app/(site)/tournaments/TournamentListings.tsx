'use client';

import { useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { HostedCard, isListed, ListingCard } from '@/components/ListingCard';
import { Empty, Field, Input, LinkButton, PageTitle, Select, Spinner } from '@/components/ui';
import { getListings, getLiveTournaments } from '@/lib/api';
import { isBackendConfigured } from '@/lib/config';
import { localToday } from '@/lib/format';
import { useLoad, useSession } from '@/lib/hooks';
import { setListingState, useListingState } from '@/lib/listingState';
import { stateName, US_STATES } from '@/lib/places';

const monthOf = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

export function TournamentListings() {
  const session = useSession();
  const region = useListingState();
  const listings = useLoad(
    () => (region === null ? Promise.resolve(undefined) : getListings(region || null, localToday())),
    [region],
  );
  const running = useLoad(async () => ({ today: localToday(), list: await getLiveTournaments() }), []);
  const [search, setSearch] = useState('');

  if (!isBackendConfigured) return <ConnectNotice />;

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...fields: (string | null)[]) => {
    const text = fields.join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  };
  // Listed elsewhere, and run here, together by date. Without a state, one run here only shows under All states.
  const shown = [
    ...(listings.data ?? [])
      .filter((l) => matches(l.name, l.venue, l.city, l.state, stateName[l.state]))
      .map((l) => ({ date: l.starts_on, name: l.name, card: <ListingCard key={l.id} listing={l} mine={l.created_by === session?.id} /> })),
    ...(running.data?.list ?? [])
      .filter((t) => isListed(t, running.data!.today) && (!region || t.state === region))
      .filter((t) => matches(t.name, t.location, t.state, t.state && stateName[t.state], t.ball))
      .map((t) => ({ date: t.starts_on, name: t.name, card: <HostedCard key={t.id} tournament={t} /> })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const months = new Map<string, typeof shown>();
  for (const s of shown) months.set(monthOf(s.date), [...(months.get(monthOf(s.date)) ?? []), s]);

  return (
    <>
      <PageTitle
        title="Find a tournament"
        subtitle="Tournaments near you, with what one event costs."
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
              {list.map((s) => s.card)}
            </div>
          </section>
        ))
      )}
    </>
  );
}
