'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Button, Card, ErrorText, Field, Input } from '@/components/ui';
import { auth } from '@/lib/auth';
import { isBackendConfigured, isDemoMode, isLocalMode } from '@/lib/config';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Creating an account means agreeing to the Terms of Service and Privacy Policy.
  const [agreed, setAgreed] = useState(false);

  if (!isBackendConfigured) return <ConnectNotice />;

  async function attempt(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const signIn = () =>
    attempt(async () => {
      await auth.signIn(email, password);
      router.push('/');
    });

  const signUp = () =>
    attempt(async () => {
      if ((await auth.signUp(email, password)) === 'signed-in') router.push('/');
      else setMessage('Check your email to confirm your account, then sign in.');
    });

  const emailLink = () =>
    attempt(async () => {
      await auth.emailLink!(email);
      setMessage('We sent you a sign-in link.');
    });

  return (
    <Card className="mx-auto mt-6 max-w-sm p-6">
      <h1 className="text-3xl">Director sign in</h1>
      <p className="mt-1 text-sm text-muted">
        {isLocalMode
          ? 'Local test mode: create any account. It only exists on this computer.'
          : 'Players don’t need an account to follow a tournament.'}
      </p>
      <form
        className="mt-5 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          signIn();
        }}
      >
        <Field label="Email">
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        {message && <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">{message}</p>}
        <Button variant="primary" type="submit" disabled={busy || !email || !password}>
          Sign in
        </Button>
        <p className="-mt-2 text-center text-sm text-muted">
          By signing in you agree to the <Terms />.
        </p>
        <label className="flex items-start gap-3 border-t border-border pt-4 text-sm">
          <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            New here? To create an account, I agree to the <Terms />.
          </span>
        </label>
        <div className={`grid gap-2 ${auth.emailLink ? 'grid-cols-2' : ''}`}>
          <Button type="button" onClick={signUp} disabled={busy || !agreed || !email || password.length < 6}>
            Create account
          </Button>
          {auth.emailLink && (
            <Button type="button" onClick={emailLink} disabled={busy || !agreed || !email}>
              Email me a link
            </Button>
          )}
        </div>
        {isDemoMode && (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => attempt(async () => (await auth.signInAsGuest(), router.push('/')))}>
            Continue as a guest
          </Button>
        )}
      </form>
    </Card>
  );
}

function Terms() {
  return (
    <>
      <Link href="/terms" target="_blank" className="underline">
        Terms of Service
      </Link>{' '}
      and{' '}
      <Link href="/privacy" target="_blank" className="underline">
        Privacy Policy
      </Link>
    </>
  );
}
