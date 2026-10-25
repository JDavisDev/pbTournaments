// Delivers the message outbox (public.notifications): texts and emails.
//   Texts:  real with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER
//           or TWILIO_MESSAGING_SERVICE_SID (and SMS_MODE not 'log'); otherwise
//           logged. Twilio reports delivery to /api/twilio/status (docs/twilio.md).
//   Emails: real with RESEND_API_KEY and EMAIL_FROM; otherwise logged.
// Directors can read every message, sent or logged, on the Messages page.
import { appUrl, serverRpc } from './serverRpc';

export type DeliveryMode = 'live' | 'log';

export const textsMode = (): DeliveryMode =>
  process.env.SMS_MODE !== 'log' &&
  process.env.NEXT_PUBLIC_DEMO_MODE !== '1' &&
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID)
    ? 'live'
    : 'log';

/** Where Twilio posts delivery reports. Twilio can't reach localhost, so none there. */
export function statusCallbackUrl(): string | null {
  const url = `${appUrl()}/api/twilio/status`;
  return /^https:\/\//.test(url) && !/\/\/(localhost|127\.0\.0\.1)/.test(url) ? url : null;
}

export const emailMode = (): DeliveryMode =>
  process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.NEXT_PUBLIC_DEMO_MODE !== '1' ? 'live' : 'log';

interface Claimed {
  id: number;
  body: string;
  kind: string;
  via: 'sms' | 'email';
  subject: string | null;
  phone: string | null;
  sms_opt_in: boolean;
  email: string | null;
  report_code: string | null;
}

const finish = (id: number, channel: string, to: string | null, body: string, error: string | null) =>
  serverRpc('finish_notification', { p_id: id, p_channel: channel, p_to: to, p_sent_body: body, p_error: error });

export const twilioAuth = () =>
  `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`;

/** Sends one text. Returns Twilio's message id, or the error to log. */
async function sendText(to: string, body: string): Promise<{ sid?: string; error?: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const form = new URLSearchParams({ To: to, Body: body });
  // A messaging service picks the sender (and handles opt-outs); otherwise our number sends.
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set('From', process.env.TWILIO_FROM_NUMBER!);
  const callback = statusCallbackUrl();
  if (callback) form.set('StatusCallback', callback);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { authorization: twilioAuth(), 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (res.ok) return { sid: json.sid };
  return { error: `${json.message ?? `Twilio error ${res.status}`}${json.code ? ` (code ${json.code})` : ''}` };
}

async function sendEmail(to: string, subject: string, body: string): Promise<string | null> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject, text: body }),
  });
  if (res.ok) return null;
  const err = (await res.json().catch(() => ({}))) as { message?: string };
  return err.message ?? `Email error ${res.status}`;
}

async function deliver(n: Claimed) {
  const body = n.body.replaceAll('{url}', n.report_code ? `${appUrl()}/s/${n.report_code}` : appUrl());

  if (n.via === 'email') {
    if (!n.email) return finish(n.id, 'none', null, body, 'No email address');
    if (emailMode() === 'log') {
      console.log(`[email to ${n.email}] ${n.subject ?? ''} ${body}`);
      return finish(n.id, 'log', n.email, body, null);
    }
    const error = await sendEmail(n.email, n.subject ?? 'Tournament update', body).catch((e: Error) => e.message);
    return finish(n.id, 'email', n.email, body, error);
  }

  if (!n.phone || !n.sms_opt_in) {
    return finish(n.id, 'none', n.phone, body, n.phone ? 'Player did not opt in to texts' : 'No phone number');
  }
  if (textsMode() === 'log') {
    console.log(`[text to ${n.phone}] ${body}`);
    return finish(n.id, 'log', n.phone, body, null);
  }
  const sent = await sendText(n.phone, body).catch((e: Error) => ({ error: e.message, sid: undefined }));
  await finish(n.id, 'sms', n.phone, body, sent.error ?? null);
  if (sent.sid) await serverRpc('set_notification_provider_id', { p_id: n.id, p_provider_id: sent.sid });
}

/** Sends (or logs) one batch of queued messages. Returns how many it handled. */
export async function sendPendingTexts(limit = 50): Promise<number> {
  const batch = (await serverRpc<Claimed[]>('claim_notifications', { p_limit: limit })) ?? [];
  for (const n of batch) await deliver(n);
  return batch.length;
}
