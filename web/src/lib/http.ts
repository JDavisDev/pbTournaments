// Calls from the browser to the site's own routes (src/app/api), which answer
// JSON and put what went wrong in `error`.
import { supabase } from './supabase';

/**
 * POSTs to one of the site's routes and returns its answer, or throws its
 * error. `signedIn` sends the Supabase session, for routes that check who's asking.
 */
export async function postJson<T>(path: string, body?: unknown, { signedIn = false } = {}): Promise<T> {
  const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
  if (signedIn) {
    const { data } = await supabase().auth.getSession();
    if (data.session) headers.authorization = `Bearer ${data.session.access_token}`;
  }
  const res = await fetch(path, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  // An error page from the host isn't JSON.
  const answer = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(answer.error ?? `Something went wrong (${res.status}). Try again.`);
  return answer;
}

/** Starts a checkout (Stripe's, or the test one) and goes there. */
export async function goToCheckout(path: string, body: unknown) {
  const { url } = await postJson<{ url?: string }>(path, body);
  if (!url) throw new Error('Could not start checkout');
  window.location.href = url;
}
