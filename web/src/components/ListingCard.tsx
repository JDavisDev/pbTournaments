import Link from 'next/link';
import { formatDateRange } from '@/lib/format';
import type { TournamentListing } from '@/lib/types';
import { Icon } from './Icon';
import { Card } from './ui';

/** "pickleballtournaments.com", so players know where the sign-up link goes. */
function siteName(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A listed tournament: image, dates, place, and the sign-up link out. `mine` adds Edit. */
export function ListingCard({ listing: l, mine = false }: { listing: TournamentListing; mine?: boolean }) {
  return (
    <Card className="flex flex-col overflow-hidden">
      {/* Without an image, phones (one column) skip the empty frame; the grid keeps cards lined up. */}
      <div className={`flex aspect-[16/9] items-center justify-center bg-border/40 ${l.image_data ? '' : 'max-sm:hidden'}`}>
        {l.image_data ? (
          // Logos and flyers come in every shape: show all of it, not a crop.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={l.image_data} alt="" className="h-full w-full object-contain" />
        ) : (
          <span aria-hidden className="h-10 w-5 -skew-x-12 rounded-[3px] bg-brand/30" />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
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
      </div>
    </Card>
  );
}
