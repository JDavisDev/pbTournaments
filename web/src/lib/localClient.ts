// Browser side of local mode: calls /api/local, which runs the same SQL as
// Supabase against the dev server's own database.

export interface LocalUser {
  id: string;
  email: string;
}

const SESSION_KEY = 'courtside-local-user';

export function getLocalUser(): LocalUser | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function setLocalUser(user: LocalUser | null) {
  if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  else localStorage.removeItem(SESSION_KEY);
}

export async function localCall<T>(op: string, args: unknown[] = []): Promise<T> {
  const user = getLocalUser();
  const res = await fetch('/api/local', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-local-user': user.id } : {}) },
    body: JSON.stringify({ op, args }),
  });
  const body = (await res.json().catch(() => ({ error: `Local server error (${res.status})` }))) as {
    data?: T;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? 'Request failed');
  return body.data as T;
}

/** Every remoteApi function, by name, as a call to the local server. */
export const localApi = new Proxy(
  {},
  {
    get: (_target, op: string) =>
      (...args: unknown[]) =>
        localCall(op, args),
  },
);
