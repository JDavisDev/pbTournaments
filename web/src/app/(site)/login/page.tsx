'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Button, Card, ErrorText, Field, Input } from '@/components/ui';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!isSupabaseConfigured) return <ConnectNotice />;

  async function attempt(action: () => Promise<{ error: { message: string } | null }>, success: () => void) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const { error } = await action();
    setBusy(false);
    if (error) setError(error.message);
    else success();
  }

  const signIn = () =>
    attempt(
      () => supabase().auth.signInWithPassword({ email, password }),
      () => router.push('/'),
    );

  const signUp = () =>
    attempt(
      () => supabase().auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } }),
      () => setMessage('Check your email to confirm your account, then sign in.'),
    );

  const emailLink = () =>
    attempt(
      () => supabase().auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } }),
      () => setMessage('We sent you a sign-in link.'),
    );

  return (
    <Card className="mx-auto mt-6 max-w-sm p-6">
      <h1 className="text-xl font-semibold">Director sign in</h1>
      <p className="mt-1 text-sm text-muted">Players don’t need an account to follow a tournament.</p>
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
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" onClick={signUp} disabled={busy || !email || password.length < 6}>
            Create account
          </Button>
          <Button type="button" onClick={emailLink} disabled={busy || !email}>
            Email me a link
          </Button>
        </div>
      </form>
    </Card>
  );
}
