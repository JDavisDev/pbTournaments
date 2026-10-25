'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, PageTitle, Spinner } from '@/components/ui';
import { addOrganizationMember, createTournament, getOrganizationBySlug, getOrganizationTournaments } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAction, useLoad, useSession } from '@/lib/hooks';
import { isBackendConfigured } from '@/lib/config';

const statusTone = { draft: 'neutral', registration: 'info', live: 'live', complete: 'neutral' } as const;

export function OrganizationView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const session = useSession();
  const router = useRouter();
  const org = useLoad(() => getOrganizationBySlug(slug), [slug]);
  const tournaments = useLoad(
    () => (org.data ? getOrganizationTournaments(org.data.id) : Promise.resolve([])),
    [org.data?.id, session?.id],
  );

  const [name, setName] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [courts, setCourts] = useState(11);
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
            <Card className="p-5">
              <h2 className="mb-3 text-xl">New tournament</h2>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  create.run(async () => {
                    const t = await createTournament(organization.id, name, startsOn, courts);
                    router.push(`/t/${t.id}/setup`);
                  });
                }}
              >
                <Field label="Name">
                  <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Fall Classic" />
                </Field>
                <Field label="Date">
                  <Input type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
                </Field>
                <Field label="Courts" hint="You can change this any time, even during play.">
                  <Input
                    type="number"
                    min={0}
                    max={200}
                    value={courts}
                    onChange={(e) => setCourts(Number(e.target.value))}
                  />
                </Field>
                <ErrorText>{create.error}</ErrorText>
                <Button variant="primary" type="submit" disabled={create.busy || !name || !startsOn}>
                  Create tournament
                </Button>
              </form>
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
