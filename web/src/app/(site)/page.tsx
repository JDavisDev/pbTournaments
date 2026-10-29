'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ConnectNotice } from '@/components/ConnectNotice';
import { LogoStacked } from '@/components/Logo';
import { Badge, Button, Card, Empty, ErrorText, LinkButton, Spinner } from '@/components/ui';
import { getLiveTournaments, getMyOrganizations, newTournament } from '@/lib/api';
import { auth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { useAction, useLoad, useSession } from '@/lib/hooks';
import { setViewMode } from '@/lib/viewMode';
import { DemoCard } from '@/components/DemoTools';
import { ListingsNearYou } from './ListingsNearYou';
import { PricingBlock } from '@/components/PricingBlock';
import { isBackendConfigured, isDemoMode } from '@/lib/config';

export default function Home() {
  const session = useSession();
  const orgs = useLoad(getMyOrganizations, [session?.id]);
  const live = useLoad(getLiveTournaments, []);
  const create = useAction();
  const router = useRouter();

  if (!isBackendConfigured) return <ConnectNotice />;

  return (
    <>
      <section className="mb-12 pt-6 pb-4 sm:pt-12">
        <h1>
          <LogoStacked className="h-auto w-full max-w-[34rem]" />
        </h1>
        <p className="mt-5 max-w-xl text-lg text-muted">
          Registration, brackets and live court assignment. Players get a text when they’re up, and the next match goes
          out the moment a score comes in.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          {/* One organization (or a demo site, where organizations are hidden): straight to Setup. */}
          {isDemoMode || orgs.data?.length === 1 ? (
            <Button
              variant="primary"
              disabled={create.busy || session === undefined}
              onClick={() =>
                create.run(async () => {
                  if (!session) await auth.signInAsGuest();
                  setViewMode('admin');
                  const t = await newTournament(isDemoMode ? null : orgs.data![0].id);
                  router.push(`/t/${t.id}/setup`);
                })
              }
            >
              {create.busy ? 'Creating…' : 'Create Tournament'}
            </Button>
          ) : (
            <LinkButton
              variant="primary"
              href={!session ? '/login' : orgs.data && orgs.data.length > 1 ? '#your-organizations' : '/orgs/new'}
            >
              Create Tournament
            </LinkButton>
          )}
          <LinkButton href="/tournaments">Find Tournaments</LinkButton>
        </div>
        <p className="mt-4 text-muted">
          Taking sign-ups somewhere else?{' '}
          <Link href="/tournaments/new" className="font-medium text-text underline underline-offset-4 hover:text-brand">
            Advertise your tournament with us for no cost.
          </Link>
        </p>
        <ErrorText>{create.error}</ErrorText>
      </section>
      <ListingsNearYou />
      {isDemoMode && session !== undefined && (
        <div id="practice" className="scroll-mt-6">
          <DemoCard signedIn={!!session} />
        </div>
      )}
      <PricingBlock />

      {session && !isDemoMode && (
        <section id="your-organizations" className="mb-10 scroll-mt-6">
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
