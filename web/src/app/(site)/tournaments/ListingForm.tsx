'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, ErrorText, Field, Input, LinkButton, Select, Spinner, Textarea } from '@/components/ui';
import { deleteListing, saveListing } from '@/lib/api';
import { auth } from '@/lib/auth';
import { isDemoMode } from '@/lib/config';
import { useAction, useSession } from '@/lib/hooks';
import { shrinkImage } from '@/lib/image';
import { US_STATES } from '@/lib/places';
import type { TournamentListing } from '@/lib/types';

/** Adds https:// to links pasted without it ("pickleballtournaments.com/..."). */
const withScheme = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

/** Post a tournament listing, or edit one of yours. */
export function ListingForm({ listing }: { listing?: TournamentListing }) {
  const router = useRouter();
  const session = useSession();
  const [form, setForm] = useState({
    name: listing?.name ?? '',
    signup_url: listing?.signup_url ?? '',
    starts_on: listing?.starts_on ?? '',
    ends_on: listing?.ends_on ?? '',
    venue: listing?.venue ?? '',
    city: listing?.city ?? '',
    state: listing?.state ?? '',
    refund_policy: listing?.refund_policy ?? '',
  });
  const [image, setImage] = useState(listing?.image_data ?? null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const { busy, error, run } = useAction();
  const guest = useAction();

  if (session === undefined) return <Spinner />;
  if (!session) {
    return (
      <Card className="max-w-lg p-6">
        <p>Sign in to list a tournament. You can change or remove your listing any time.</p>
        <ErrorText>{guest.error}</ErrorText>
        <div className="mt-4">
          {isDemoMode ? (
            <Button variant="primary" disabled={guest.busy} onClick={() => guest.run(() => auth.signInAsGuest())}>
              {guest.busy ? 'Signing in…' : 'Sign in'}
            </Button>
          ) : (
            <LinkButton variant="primary" href="/login">
              Sign in
            </LinkButton>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card className="max-w-2xl p-6">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await saveListing(listing?.id ?? null, {
              name: form.name.trim(),
              signup_url: withScheme(form.signup_url.trim()),
              starts_on: form.starts_on,
              ends_on: form.ends_on && form.ends_on !== form.starts_on ? form.ends_on : null,
              venue: form.venue.trim() || null,
              city: form.city.trim(),
              state: form.state,
              image_data: image,
              refund_policy: form.refund_policy.trim() || null,
            });
            router.push('/tournaments');
          });
        }}
      >
        <Field label="Tournament name">
          <Input required minLength={2} maxLength={120} value={form.name} onChange={set('name')} placeholder="Lone Star Fall Classic" />
        </Field>
        <Field label="Sign-up link" hint="Where players register, e.g. the tournament’s page on PickleballTournaments.com.">
          <Input
            required
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            value={form.signup_url}
            onChange={set('signup_url')}
            placeholder="https://pickleballtournaments.com/…"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First day">
            <Input required type="date" value={form.starts_on} onChange={set('starts_on')} />
          </Field>
          <Field label="Last day" hint="Leave empty for a one-day tournament.">
            <Input type="date" min={form.starts_on || undefined} value={form.ends_on} onChange={set('ends_on')} />
          </Field>
        </div>
        <Field label="Venue (optional)">
          <Input maxLength={120} value={form.venue} onChange={set('venue')} placeholder="Austin Pickleball Center" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
          <Field label="City">
            <Input required maxLength={80} value={form.city} onChange={set('city')} placeholder="Austin" />
          </Field>
          <Field label="State">
            <Select required value={form.state} onChange={set('state')}>
              <option value="" disabled>
                Choose…
              </option>
              {US_STATES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Refund policy (optional)" hint="What players get back if they withdraw.">
          <Textarea
            rows={3}
            maxLength={2000}
            value={form.refund_policy}
            onChange={set('refund_policy')}
            placeholder="Full refund less a $5 fee until 7 days before; no refunds after that."
          />
        </Field>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Image (optional)</span>
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="max-h-56 w-full rounded-xl bg-border/40 object-contain" />
          ) : (
            <p className="text-sm text-muted">The tournament’s logo or flyer.</p>
          )}
          <div className="flex gap-2">
            <label className="inline-flex h-10 cursor-pointer items-center rounded-full border border-border px-4 text-sm font-medium hover:border-text">
              {image ? 'Change image' : 'Add an image'}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Smaller than tournament images: a listings page shows many at once.
                  if (file) run(async () => setImage(await shrinkImage(file, 800)));
                }}
              />
            </label>
            {image && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setImage(null)}>
                Remove
              </Button>
            )}
          </div>
        </div>

        <ErrorText>{error}</ErrorText>
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="primary" disabled={busy}>
            {busy ? 'Saving…' : listing ? 'Save changes' : 'Post listing'}
          </Button>
          {listing && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              className="text-late"
              onClick={() =>
                confirm(`Remove ${listing.name} from the listings?`) &&
                run(async () => {
                  await deleteListing(listing.id);
                  router.push('/tournaments');
                })
              }
            >
              Remove listing
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
