'use client';

// One account for everything: a player's details, so registering only asks
// which events, and the tournaments they run.
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, ErrorText, Field, Input, Select, Spinner } from '@/components/ui';
import { claimStaffInvites, getMyRegistrations, getMyTournaments } from '@/lib/api';
import { auth, isGuest, type AuthUser } from '@/lib/auth';
import { isBackendConfigured, isDemoMode, textingAvailable } from '@/lib/config';
import { isUnder18 } from '@/lib/eligibility';
import { formatDate, formatMoney } from '@/lib/format';
import { useAction, useLoad, useSession } from '@/lib/hooks';
import { Captcha } from '@/lib/captcha';
import { logInPlayer, logOut, saveProfile, signUpPlayer, useProfile, type PlayerProfile } from '@/lib/profile';
import { setViewMode } from '@/lib/viewMode';
import { ConnectNotice } from '@/components/ConnectNotice';
import { MatchAlerts } from '@/components/MatchAlerts';
import type { MyRegistration } from '@/lib/types';
import { DeleteAccount } from './DeleteAccount';

const under18 = 'You must be 18 or older to have an account.';

const blank: PlayerProfile = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  // Asked when they register (the "Text me" box), never assumed.
  sms_opt_in: false,
  gender: '',
  birth_date: '',
  dupr_doubles: '',
  dupr_singles: '',
  self_rating: '',
  dupr_id: '',
};

export function ProfileForm() {
  const session = useSession();
  const profile = useProfile();
  const params = useSearchParams();
  const [logIn, setLogIn] = useState(params.get('mode') === 'login');
  if (!isBackendConfigured) return <ConnectNotice />;
  const next = params.get('next');
  const home = next?.startsWith('/') ? next : '/';
  if (session === undefined || profile === undefined) return <Spinner />;
  if (session && isGuest(session)) return <GuestNote />;
  if (session) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-8">
        {/* Keyed so a fake player from the Test menu shows up here too. */}
        <Details key={session.id} user={session} saved={profile} home={home} />
        <MatchAlerts />
        <MyRegistrations />
        <MyTournaments />
        <DeleteAccount />
      </div>
    );
  }
  return (
    <>
      {params.has('deleted') && (
        <p role="status" className="mx-auto mb-6 max-w-md rounded-lg bg-surface-2 px-4 py-3">
          Your account has been deleted.
        </p>
      )}
      {logIn ? <LogIn home={home} onSignUp={() => setLogIn(false)} /> : <SignUp home={home} onLogIn={() => setLogIn(true)} />}
    </>
  );
}

function GuestNote() {
  const { busy, error, run } = useAction();
  return (
    <Card className="mx-auto flex max-w-md flex-col gap-3 p-6">
      <h1 className="text-3xl">You’re using the guest account</h1>
      <p className="text-muted">It’s shared by everyone trying the demo, so it has no profile. Sign out to log in or make your own account.</p>
      <ErrorText>{error}</ErrorText>
      <Button disabled={busy} onClick={() => run(() => logOut())}>
        Sign out
      </Button>
    </Card>
  );
}

function LogIn({ home, onSignUp }: { home: string; onSignUp: () => void }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();
  const emailLink = () => {
    setNote(null);
    if (!email.trim()) return setError('Enter your email first, and we’ll send the link there.');
    if (!auth.emailLink) return setError('Sign-in links need real email, so they don’t work in local test mode.');
    run(async () => {
      await auth.emailLink!(email.trim().toLowerCase());
      setNote(`Check ${email.trim()} for your sign-in link.`);
    });
  };
  return (
    <form
      className="mx-auto flex max-w-md flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        setNote(null);
        run(() => logInPlayer(email, password), () => router.push(home));
      }}
    >
      <div>
        <h1 className="text-4xl">Log in</h1>
        <p className="mt-1 text-muted">
          New here?{' '}
          <button type="button" className="font-medium text-text underline" onClick={onSignUp}>
            Sign up
          </button>
        </p>
      </div>
      <Card className="flex flex-col gap-3 p-5">
        <Field label="Email">
          <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button
          type="button"
          className="self-start text-sm font-medium underline"
          onClick={() => (setError(null), setNote('Password reset isn’t set up yet. Use a sign-in link instead, or ask the tournament’s director.'))}
        >
          Forgot password?
        </button>
      </Card>
      <Captcha />
      <ErrorText>{error}</ErrorText>
      {note && <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">{note}</p>}
      <Button variant="primary" type="submit" className="h-14 text-base" disabled={busy}>
        Log in
      </Button>
      <Button type="button" disabled={busy} onClick={emailLink}>
        Email me a sign-in link
      </Button>
      {isDemoMode && (
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            run(
              async () => (await auth.signInAsGuest(), setViewMode('admin')),
              () => router.push('/'),
            )
          }
        >
          Continue as a guest
        </Button>
      )}
    </form>
  );
}

function SignUp({ home, onLogIn }: { home: string; onLogIn: () => void }) {
  const router = useRouter();
  const [p, setP] = useState<PlayerProfile>(blank);
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  if (confirming) {
    return (
      <Card className="mx-auto flex max-w-md flex-col gap-3 p-6">
        <h1 className="text-3xl">Check your email</h1>
        <p className="text-muted">Confirm your address using the link we sent to {p.email}, then log in.</p>
        <Button onClick={onLogIn}>Log in</Button>
      </Card>
    );
  }
  return (
    <form
      className="mx-auto flex max-w-md flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          if (isUnder18(p.birth_date)) throw new Error(under18);
          if ((await signUpPlayer({ ...p, email: p.email.trim().toLowerCase() }, password)) === 'signed-in') router.push(home);
          else setConfirming(true);
        });
      }}
    >
      <div>
        <h1 className="text-4xl">Sign up</h1>
        <p className="mt-1 text-muted">
          One account to play in tournaments and run them, for adults 18 and older. Already have one?{' '}
          <button type="button" className="font-medium text-text underline" onClick={onLogIn}>
            Log in
          </button>
        </p>
      </div>
      <Card className="flex flex-col gap-3 p-5">
        <PersonFields p={p} set={setP}>
          <Field label="Email">
            <Input type="email" required autoComplete="email" value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} />
          </Field>
          <Field label="Password" hint="At least 8 characters.">
            <Input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </PersonFields>
      </Card>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          required
          className="mt-0.5 h-6 w-6 shrink-0 accent-[var(--accent)]"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
        />
        <span>
          I’m 18 or older, and by signing up I agree to the{' '}
          <Link href="/terms" target="_blank" className="font-medium underline">
            Terms of Service
          </Link>{' '}
          and{' '}
          <Link href="/privacy" target="_blank" className="font-medium underline">
            Privacy Policy
          </Link>
          .
        </span>
      </label>
      <Captcha />
      <ErrorText>{error}</ErrorText>
      <Button variant="primary" type="submit" className="h-14 text-base" disabled={busy || !agreed}>
        Sign up
      </Button>
    </form>
  );
}

function Details({ user, saved, home }: { user: AuthUser; saved: PlayerProfile | null; home: string }) {
  const router = useRouter();
  const [p, setP] = useState<PlayerProfile>(saved ?? { ...blank, email: user.email ?? '' });
  const { busy, error, run } = useAction();
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          async () => {
            if (isUnder18(p.birth_date)) throw new Error(under18);
            await saveProfile(p);
          },
          () => router.push(home),
        );
      }}
    >
      <h1 className="text-4xl">Your profile</h1>
      <Card className="flex flex-col gap-3 p-5">
        <PersonFields p={p} set={setP}>
          <Field label="Email" hint="The one you log in with.">
            <Input type="email" disabled value={user.email ?? ''} />
          </Field>
        </PersonFields>
      </Card>
      <ErrorText>{error}</ErrorText>
      <Button variant="primary" type="submit" className="h-14 text-base" disabled={busy}>
        Save
      </Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => run(() => logOut(), () => router.push('/'))}>
        Log out
      </Button>
    </form>
  );
}

function PersonFields({ p, set, children }: { p: PlayerProfile; set: (p: PlayerProfile) => void; children: React.ReactNode }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name">
          <Input required autoComplete="given-name" value={p.first_name} onChange={(e) => set({ ...p, first_name: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input required autoComplete="family-name" value={p.last_name} onChange={(e) => set({ ...p, last_name: e.target.value })} />
        </Field>
      </div>
      {children}
      <Field label="Mobile number" hint={textingAvailable ? 'We text you which court to go to.' : 'So the desk can reach you on the day.'}>
        <Input type="tel" autoComplete="tel" placeholder="(555) 123-4567" value={p.phone} onChange={(e) => set({ ...p, phone: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Gender" hint="For men’s, women’s and mixed events">
          <Select value={p.gender} onChange={(e) => set({ ...p, gender: e.target.value as PlayerProfile['gender'] })}>
            <option value="">Choose…</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </Select>
        </Field>
        <Field label="Date of birth" hint="For age divisions">
          <Input type="date" autoComplete="bday" value={p.birth_date} onChange={(e) => set({ ...p, birth_date: e.target.value })} />
        </Field>
      </div>
    </>
  );
}

/** Where a registration's payment stands, for the player. */
function PaymentStatus({ r }: { r: MyRegistration }) {
  if (r.disputed) return <Badge tone="late">Payment disputed</Badge>;
  if (r.status === 'waitlisted') return <Badge tone="info">Waitlisted</Badge>;
  if (r.status === 'refunded') return <Badge>Refunded</Badge>;
  if (r.status === 'pending') return <Badge tone="called">Not paid yet</Badge>;
  if (r.balance_cents > 0) return <Badge tone="late">You owe {formatMoney(r.balance_cents)}</Badge>;
  if (r.balance_cents < 0) return <Badge tone="called">Owed {formatMoney(-r.balance_cents)}</Badge>;
  return <Badge tone="live">{r.amount_cents > 0 ? 'Paid' : 'Free entry'}</Badge>;
}

/** The tournaments this player signed up for, and whether each is paid. */
function MyRegistrations() {
  const mine = useLoad(() => getMyRegistrations(), []);
  if (mine.error) return <ErrorText>{mine.error}</ErrorText>;
  if (!mine.data || mine.data.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-3xl">Your registrations</h2>
      <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
        {mine.data.map((r) => (
          <li key={r.registration_id}>
            <Link
              href={`/t/${r.tournament_id}/register/done?r=${r.registration_id}`}
              className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2"
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold">{r.tournament_name}</span>
                <span className="block text-sm text-muted">
                  {formatDate(r.starts_on)}
                  {r.events.length > 0 && <> · {r.events.join(', ')}</>}
                </span>
                {r.refunded_cents > 0 && <span className="block text-sm text-muted">Refunded {formatMoney(r.refunded_cents)}</span>}
              </span>
              <PaymentStatus r={r} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const roleLabel = { owner: 'Owner', admin: 'Manager', monitor: 'Court monitor' };

/** The tournaments this account owns or was added to. */
function MyTournaments() {
  const mine = useLoad(async () => {
    await claimStaffInvites().catch(() => 0);
    return getMyTournaments();
  }, []);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-3xl">Tournaments you run</h2>
      {mine.error ? (
        <ErrorText>{mine.error}</ErrorText>
      ) : !mine.data ? (
        <Spinner />
      ) : mine.data.length === 0 ? (
        <p className="text-muted">
          None yet. <Link href="/" className="font-medium text-text underline">Create one</Link>, or ask a tournament’s owner to add your
          email as a manager.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
          {mine.data.map((t) => (
            <li key={t.id}>
              <Link href={`/t/${t.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{t.name}</span>
                  <span className="block text-sm text-muted">{formatDate(t.starts_on)}</span>
                  {t.status === 'cancelled' && (
                    <span className="block text-sm font-medium text-late">
                      Cancelled{t.refunds_due > 0 ? ` · ${t.refunds_due} ${t.refunds_due === 1 ? 'refund' : 'refunds'} to send` : ''}
                    </span>
                  )}
                </span>
                <Badge tone={t.role === 'owner' ? 'live' : 'neutral'}>{roleLabel[t.role]}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
