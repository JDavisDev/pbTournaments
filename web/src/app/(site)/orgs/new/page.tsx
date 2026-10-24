'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, ErrorText, Field, Input, PageTitle } from '@/components/ui';
import { createOrganization } from '@/lib/api';
import { useAction } from '@/lib/hooks';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export default function NewOrganizationPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const { busy, error, run } = useAction();

  return (
    <>
      <PageTitle title="New organization" subtitle="Your club, gym or tournament series. You can add other directors later." />
      <Card className="max-w-lg p-6">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const org = await createOrganization(name, slug || slugify(name));
              router.push(`/o/${org.slug}`);
            });
          }}
        >
          <Field label="Name">
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Downtown Pickleball Club" />
          </Field>
          <Field label="Web address" hint="Lowercase letters, numbers and dashes.">
            <Input value={slug || slugify(name)} onChange={(e) => setSlug(slugify(e.target.value))} />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button variant="primary" type="submit" disabled={busy || !name}>
            Create organization
          </Button>
        </form>
      </Card>
    </>
  );
}
