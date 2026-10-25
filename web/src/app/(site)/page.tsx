'use client';

import Link from 'next/link';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Badge, Card, Empty, LinkButton, Spinner } from '@/components/ui';
import { getLiveTournaments, getMyOrganizations } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useLoad, useSession } from '@/lib/hooks';
import { DemoCard } from '@/components/DemoTools';
import { isBackendConfigured, isDemoMode } from '@/lib/config';

export default function Home() {
  const session = useSession();
  const orgs = useLoad(getMyOrganizations, [session?.id]);
  const live = useLoad(getLiveTournaments, []);

  if (!isBackendConfigured) return <ConnectNotice />;

  return (
    <>
      <section className="mb-12 pt-6 pb-4 sm:pt-12">
        <h1 className="max-w-4xl text-6xl sm:text-8xl lg:text-9xl">
          Every court.
          <br />
          Always full.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-muted">
          Registration, brackets and live court assignment. Players get a text when they’re up, and the next match goes
          out the moment a score comes in.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          {session ? (
            <LinkButton variant="primary" href="/orgs/new">
              Start a tournament
            </LinkButton>
          ) : (
            <LinkButton variant="primary" href="/login">
              Run a tournament
            </LinkButton>
          )}
          <LinkButton href="#live">Find a tournament</LinkButton>
        </div>
      </section>
      {isDemoMode && session !== undefined && <DemoCard signedIn={!!session} />}

      {session && (
        <section className="mb-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-3xl">Your organizations</h2>
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

      <section id="live">
        <h2 className="mb-3 text-3xl">Happening now</h2>
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
