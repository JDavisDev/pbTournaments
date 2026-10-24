'use client';

import Link from 'next/link';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Badge, Card, Empty, LinkButton, PageTitle, Spinner } from '@/components/ui';
import { getLiveTournaments, getMyOrganizations } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useLoad, useSession } from '@/lib/hooks';
import { isSupabaseConfigured } from '@/lib/supabase';

export default function Home() {
  const session = useSession();
  const orgs = useLoad(getMyOrganizations, [session?.user.id]);
  const live = useLoad(getLiveTournaments, []);

  if (!isSupabaseConfigured) return <ConnectNotice />;

  return (
    <>
      <PageTitle title="Tournaments" subtitle="Registration, brackets and live court assignment." />

      {session && (
        <section className="mb-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Your organizations</h2>
            <LinkButton href="/orgs/new">New organization</LinkButton>
          </div>
          {orgs.data === undefined ? (
            <Spinner />
          ) : orgs.data.length === 0 ? (
            <Empty>Create an organization for your club or gym to start running tournaments.</Empty>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {orgs.data.map((o) => (
                <Link key={o.id} href={`/o/${o.slug}`}>
                  <Card className="p-4 transition hover:border-accent">
                    <div className="font-semibold">{o.name}</div>
                    <div className="text-sm text-muted">/{o.slug}</div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Happening now</h2>
        {live.error ? (
          <Empty>{live.error}</Empty>
        ) : live.data === undefined ? (
          <Spinner />
        ) : live.data.length === 0 ? (
          <Empty>No tournaments are open or live right now.</Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {live.data.map((t) => (
              <Link key={t.id} href={`/t/${t.id}`}>
                <Card className="p-4 transition hover:border-accent">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold">{t.name}</div>
                    <Badge tone={t.status === 'live' ? 'live' : 'info'}>{t.status === 'live' ? 'Live' : 'Registration'}</Badge>
                  </div>
                  <div className="mt-1 text-sm text-muted">{formatDate(t.starts_on)}</div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
