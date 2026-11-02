// Match alerts on this phone: push notifications for the signed-in account
// (server/push.ts sends them, public/sw.js shows them).
import { deletePushSubscription, savePushSubscription, sendTestPush } from './api';

const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

/** The site has push keys. */
export const alertsConfigured = !!publicKey;

/** This browser can get alerts now. iPhones only can once the site is on the Home Screen. */
export const alertsSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const registerServiceWorker = () =>
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });

export async function currentAlerts() {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function keyBytes(base64: string) {
  const raw = atob((base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Asks permission (from a tap: iPhones require it) and signs this phone up. */
export async function turnOnAlerts() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Alerts are blocked for this site. Allow notifications for it in your phone’s settings, then try again.'
        : 'Alerts weren’t turned on.',
    );
  }
  await registerServiceWorker();
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const { endpoint, keys } = sub.toJSON();
  await savePushSubscription(endpoint!, keys!.p256dh, keys!.auth);
  return sub;
}

export async function turnOffAlerts(sub: PushSubscription) {
  await deletePushSubscription(sub.endpoint).catch(() => null);
  await sub.unsubscribe();
}

/** Sends an alert to this account's phones; returns how many got it. */
export const sendTestAlert = () => sendTestPush();
