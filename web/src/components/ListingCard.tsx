import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatDateRange } from '@/lib/format';
import type { Tournament, TournamentListing } from '@/lib/types';
import { Icon } from './Icon';
import { LogoMark } from './Logo';
import { Card } from './ui';

/** "pickleballtournaments.com", so players know where the sign-up link goes. */
function siteName(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The card's frame: the image (or the mark), then the details. */
function Frame({ image, children }: { image: string | null; children: ReactNode }) {
  return (
    <Card className="flex flex-col overflow-hidden">
      {/* Without an image, phones (one column) skip the empty frame; the grid keeps cards lined up. */}
      <div className={`flex aspect-[16/9] items-center justify-center bg-border/40 ${image ? '' : 'max-sm:hidden'}`}>
        {image ? (
          // Logos and flyers come in every shape: show all of it, not a crop.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="h-full w-full object-contain" />
        ) : (
          <LogoMark className="h-10 w-auto opacity-25" />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">{children}</div>
    </Card>
  );
}

/** A tournament run here with registration open: like a listing, signing up on its own page. */
export function HostedCard({ tournament: t }: { tournament: Tournament }) {
  return (
    <Frame image={t.image_data}>
      <h3 className="text-2xl leading-tight">{t.name}</h3>
      <p className="font-medium">{formatDateRange(t.starts_on, null)}</p>
      {t.location && <p className="text-muted">{t.location}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        <Link
          href={`/t/${t.id}/register`}
          className="inline-flex h-12 items-center justify-center rounded-full bg-accent px-6 font-medium text-accent-text transition hover:opacity-80"
        >
          Register
        </Link>
        <Link href={`/t/${t.id}`} className="inline-flex h-12 items-center rounded-full px-4 font-medium hover:bg-surface">
          Details
        </Link>
      </div>
    </Frame>
  );
}

/** A listed tournament: image, dates, place, and the sign-up link out. `mine` adds Edit. */
export function ListingCard({ listing: l, mine = false }: { listing: TournamentListing; mine?: boolean }) {
  return (
    <Frame image={l.image_data}>
      <h3 className="text-2xl leading-tight">{l.name}</h3>
      <p className="font-medium">{formatDateRange(l.starts_on, l.ends_on)}</p>
      <p className="text-muted">
        {l.venue && <>{l.venue} · </>}
        {l.city}, {l.state}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        <a
          href={l.signup_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-12 items-center justify-center gap-1.5 rounded-full bg-accent px-6 font-medium text-accent-text transition hover:opacity-80"
        >
          Sign up <Icon name="external" />
        </a>
        {mine && (
          <Link href={`/tournaments/${l.id}/edit`} className="inline-flex h-12 items-center rounded-full px-4 font-medium hover:bg-surface">
            Edit
          </Link>
        )}
      </div>
      <p className="text-sm text-muted">on {siteName(l.signup_url)}</p>
      {l.refund_policy && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer py-2 font-medium">Refund policy</summary>
          <p className="whitespace-pre-wrap text-muted">{l.refund_policy}</p>
        </details>
      )}
    </Frame>
  );
}
