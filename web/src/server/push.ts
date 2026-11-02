// Push notifications to phones that turned on match alerts (public/sw.js shows
// them). Needs NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY; free to send.
import webpush from 'web-push';
import { BRAND } from '@/lib/brand';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  /** Alerts with the same tag replace each other on the phone. */
  tag?: string;
}

export const pushConfigured = () => !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY;

let ready = false;

/** Sends to each phone. `gone`: phones that have turned alerts off or been reset, to forget. */
export async function sendPush(targets: PushTarget[], message: PushMessage) {
  if (!ready) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || `mailto:${BRAND.contactEmail}`,
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!,
    );
    ready = true;
  }
  const sent: string[] = [];
  const gone: string[] = [];
  await Promise.all(
    targets.map(async (t) => {
      try {
        // A match call is stale after 15 minutes.
        await webpush.sendNotification({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, JSON.stringify(message), {
          TTL: 15 * 60,
          urgency: 'high',
        });
        sent.push(t.endpoint);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) gone.push(t.endpoint);
        else console.error(`Push failed (${status ?? 'no status'}): ${(err as Error).message}`);
      }
    }),
  );
  return { sent, gone };
}

/** A text's wording for an alert: the link is the tap, so it comes out of the words. */
export const alertText = (body: string) => body.replace(/:?\s*\{url\}/g, '').replace(/\s+/g, ' ').trim();
