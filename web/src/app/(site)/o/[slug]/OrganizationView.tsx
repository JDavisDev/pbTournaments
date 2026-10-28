'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Badge, Button, Card, Empty, ErrorText, Input, PageTitle, Spinner } from '@/components/ui';
import { addOrganizationMember, getOrganizationBySlug, getOrganizationTournaments, newTournament } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAction, useLoad, useSession } from '@/lib/hooks';
import { isBackendConfigured } from '@/lib/config';

const statusTone = { draft: 'neutral', registration: 'called', live: 'live', complete: 'info' } as const;

export function OrganizationView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const session = useSession();
  const router = useRouter();
  const org = useLoad(() => getOrganizationBySlug(slug), [slug]);
  const tournaments = useLoad(
    () => (org.data ? getOrganizationTournaments(org.data.id) : Promise.resolve([])),
    [org.data?.id, session?.id],
  );

  const create = useAction();
  const [email, setEmail] = useState('');
  const invite = useAction();
  const [invited, setInvited] = useState<string | null>(null);

  if (!isBackendConfigured) return <ConnectNotice />;
  if (org.error) return <Empty>{org.error}</Empty>;
  if (!org.data) return <Spinner />;
  const organization = org.data;

  return (
    <>
      <PageTitle title={organization.name} subtitle={`/${organization.slug}`} />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section>
          <h2 className="mb-3 text-3xl">Tournaments</h2>
          {tournaments.data === undefined ? (
            <Spinner />
          ) : tournaments.data.length === 0 ? (
            <Empty>No tournaments yet.</Empty>
          ) : (
            <div className="flex flex-col gap-2">
              {tournaments.data.map((t) => (
                <Link key={t.id} href={`/t/${t.id}`}>
                  <Card className="flex items-center justify-between p-4 transition hover:border-accent">
                    <div>
                      <div className="font-semibold">{t.name}</div>
                      <div className="text-sm text-muted">{formatDate(t.starts_on)}</div>
                    </div>
                    <Badge tone={statusTone[t.status]}>{t.status}</Badge>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </section>

        {session && (
          <aside className="flex flex-col gap-4">
            <Card className="flex flex-col gap-3 p-5">
              <div>
                <h2 className="text-xl">New tournament</h2>
                <p className="text-sm text-muted">Starts as a draft with one division. Name it, set the date, and add divisions in Setup.</p>
              </div>
              <ErrorText>{create.error}</ErrorText>
              <Button
                variant="primary"
                disabled={create.busy}
                onClick={() =>
                  create.run(async () => {
                    const t = await newTournament(organization.id);
                    router.push(`/t/${t.id}/setup`);
                  })
                }
              >
                {create.busy ? 'Creating…' : 'New tournament'}
              </Button>
            </Card>

            <Card className="p-5">
              <h2 className="mb-1 text-xl">Add a director</h2>
              <p className="mb-3 text-sm text-muted">They need to create an account first.</p>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  invite.run(
                    () => addOrganizationMember(organization.id, email),
                    () => {
                      setInvited(email);
                      setEmail('');
                    },
                  );
                }}
              >
                <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
                <ErrorText>{invite.error}</ErrorText>
                {invited && <p className="text-sm text-accent">{invited} can now run this organization’s tournaments.</p>}
                <Button type="submit" disabled={invite.busy || !email}>
                  Add director
                </Button>
              </form>
            </Card>
          </aside>
        )}
      </div>
    </>
  );
}
