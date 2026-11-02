// DUPR's Partner API: current ratings by DUPR ID. Needs partner keys from DUPR,
// and DUPR only answers for players who connected their account through its login.
// https://dupr.gitbook.io/dupr-raas
const clientKey = () => process.env.DUPR_CLIENT_KEY;
const clientSecret = () => process.env.DUPR_CLIENT_SECRET;
const baseUrl = () => process.env.DUPR_API_URL || 'https://prod.mydupr.com/api';

export const duprConnected = () => !!clientKey() && !!clientSecret();

let partnerToken: { token: string; until: number } | null = null;

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => null)) as { status?: string; message?: string; result?: T } | null;
  if (!res.ok || body?.status !== 'SUCCESS' || !body.result) {
    throw new Error(`DUPR: ${body?.message ?? `request failed (${res.status})`}`);
  }
  return body.result;
}

/** Tokens last an hour; this one is replaced a little early. */
async function token() {
  if (partnerToken && partnerToken.until > Date.now()) return partnerToken.token;
  const encoded = Buffer.from(`${clientKey()}:${clientSecret()}`).toString('base64');
  const { token: value } = await call<{ token: string }>('/auth/v1.0/token', {
    method: 'POST',
    headers: { 'x-authorization': encoded },
  });
  partnerToken = { token: value, until: Date.now() + 50 * 60_000 };
  return value;
}

/** A number, or null for a player with no rating ("NR"). */
function rating(value: unknown) {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) && n > 0 && n < 10 ? n : null;
}

export interface DuprRating {
  dupr_id: string;
  doubles: number | null;
  singles: number | null;
}

/** Current ratings, and the IDs DUPR wouldn't return. DUPR takes up to 100 per request. */
export async function fetchDuprRatings(duprIds: string[]) {
  const found: DuprRating[] = [];
  const notFound: string[] = [];
  for (let i = 0; i < duprIds.length; i += 100) {
    const result = await call<{
      users: { id: string; ratings?: { doubles?: unknown; singles?: unknown } }[];
      notFound: string[];
    }>('/user/v1.0/batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ duprIds: duprIds.slice(i, i + 100) }),
    });
    for (const u of result.users) {
      found.push({ dupr_id: u.id.toUpperCase(), doubles: rating(u.ratings?.doubles), singles: rating(u.ratings?.singles) });
    }
    notFound.push(...result.notFound);
  }
  return { found, notFound };
}
