import { youtubeEmbedUrl } from '@/lib/youtube';
import { Icon } from './Icon';

/** A YouTube stream, embedded when the link is a video; otherwise a "Watch" link. */
export function StreamEmbed({ url, title, className = '' }: { url: string; title: string; className?: string }) {
  const embed = youtubeEmbedUrl(url);
  if (!embed) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={`flex items-center gap-2 rounded-2xl bg-black px-4 py-3 font-medium text-white ${className}`}
      >
        <LiveDot /> Watch {title} on YouTube <Icon name="external" />
      </a>
    );
  }
  return (
    <div className={`overflow-hidden rounded-2xl bg-black ${className}`}>
      <div className="aspect-video">
        <iframe
          src={embed}
          title={title}
          className="h-full w-full"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </div>
  );
}

export function LiveDot({ className = '' }: { className?: string }) {
  return (
    <span className={`relative inline-flex h-2.5 w-2.5 ${className}`} aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
    </span>
  );
}

/** A small "Watch" chip linking to a stream. */
export function WatchChip({ url, label = 'Watch' }: { url: string; label?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-full bg-black px-2.5 py-0.5 font-display text-[0.8rem] leading-5 font-semibold tracking-wide text-white uppercase hover:opacity-85"
    >
      <LiveDot className="h-2 w-2" /> {label}
    </a>
  );
}
