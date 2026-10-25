// YouTube links for court and event streams. Directors paste whatever link
// YouTube gives them; we turn it into a privacy-friendly embed when we can.

/** The video id in a watch, youtu.be, live, shorts or embed link. */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  if (u.pathname === '/watch') return u.searchParams.get('v');
  const match = u.pathname.match(/^\/(live|shorts|embed)\/([\w-]{6,})/);
  return match ? match[2] : null;
}

/** Embed URL for a video link, or null for links we can't embed (e.g. a channel). */
export function youtubeEmbedUrl(url: string | null | undefined, opts: { autoplay?: boolean } = {}) {
  const id = youtubeId(url);
  if (!id) return null;
  const params = new URLSearchParams({ rel: '0', modestbranding: '1', playsinline: '1' });
  if (opts.autoplay) {
    params.set('autoplay', '1');
    params.set('mute', '1');
  }
  return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
}

export const isYoutubeUrl = (url: string | null | undefined) => {
  if (!url) return false;
  try {
    return /(^|\.)(youtube\.com|youtu\.be)$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};
