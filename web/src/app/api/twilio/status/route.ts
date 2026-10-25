import { createHmac, timingSafeEqual } from 'node:crypto';
import { serverRpc } from '@/server/serverRpc';
import { statusCallbackUrl } from '@/server/texts';

/**
 * Twilio's delivery reports (the StatusCallback we pass with each text).
 * Checks Twilio's signature, then stores the status on the message so the
 * Messages page shows delivered / undelivered / failed.
 */
export async function POST(request: Request) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const url = statusCallbackUrl();
  if (!token || !url) return new Response('Texts are not set up', { status: 404 });

  const params = Object.fromEntries(new URLSearchParams(await request.text()));
  // Twilio signs the URL it called plus every POST field, sorted by name.
  const signed = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', token).update(signed).digest();
  const given = Buffer.from(request.headers.get('x-twilio-signature') ?? '', 'base64');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return new Response('Bad signature', { status: 403 });
  }

  const sid = params.MessageSid ?? params.SmsSid;
  const status = params.MessageStatus ?? params.SmsStatus;
  if (sid && status) {
    const error = params.ErrorCode ? `Twilio error ${params.ErrorCode}${errorHint[params.ErrorCode] ? `: ${errorHint[params.ErrorCode]}` : ''}` : null;
    await serverRpc('record_delivery_status', { p_provider_id: sid, p_status: status, p_error: error });
  }
  return new Response(null, { status: 204 });
}

// The delivery errors directors run into most.
const errorHint: Record<string, string> = {
  '21610': 'the player replied STOP',
  '21614': 'not a mobile number',
  '30003': 'phone off or out of service',
  '30004': 'blocked by the carrier or the player',
  '30005': 'unknown number',
  '30006': 'landline or unreachable carrier',
  '30007': 'filtered as spam by the carrier (register the number: docs/twilio.md)',
  '30032': 'toll-free number not verified yet',
  '30034': 'number not registered for A2P 10DLC',
};
