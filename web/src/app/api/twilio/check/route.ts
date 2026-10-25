import type { TwilioCheck } from '@/lib/types';
import { statusCallbackUrl, textsMode, twilioAuth } from '@/server/texts';

let cached: { at: number; result: TwilioCheck } | null = null;

const mask = (n: string) => (n.length > 6 ? `${n.slice(0, -4).replace(/\d/g, '•')}${n.slice(-4)}` : n);

/** Checks the Twilio setup for the Messages page: credentials, account type, sender, delivery reports. */
export async function POST() {
  if (cached && Date.now() - cached.at < 5 * 60_000) return Response.json(cached.result);
  const from = process.env.TWILIO_FROM_NUMBER;
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const result: TwilioCheck = {
    mode: textsMode(),
    sender: service ? `Messaging service ${service.slice(0, 6)}…` : from ? mask(from) : null,
    callbackUrl: statusCallbackUrl(),
    account: null,
    error: null,
    warnings: [],
  };

  if (result.mode === 'live') {
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID!;
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: { authorization: twilioAuth() },
      });
      const json = (await res.json()) as { status?: string; type?: string; friendly_name?: string; message?: string };
      if (!res.ok) result.error = json.message ?? `Twilio said ${res.status}`;
      else result.account = { status: json.status ?? '', type: json.type ?? '', name: json.friendly_name ?? '' };
    } catch (e) {
      result.error = (e as Error).message;
    }
    if (from === '+15005550006') result.warnings.push('Using Twilio’s magic test number: texts are accepted but never delivered.');
    if (result.account?.type === 'Trial') result.warnings.push('Trial account: texts only reach phone numbers you verified in Twilio, and start with “Sent from your Twilio trial account”.');
    if (!result.callbackUrl) result.warnings.push('No delivery reports: set NEXT_PUBLIC_APP_URL to the public https address so Twilio can report back.');
  }
  cached = { at: Date.now(), result };
  return Response.json(result);
}
