'use client';

// At the desk: a player scans the QR code, logs in and confirms; they can
// only check themselves in. Directors and court monitors can find and check in
// anyone from the same link (a tablet at the door).
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { Button, Empty, ErrorText, Input, Spinner } from '@/components/ui';
import { getMySelfCheckin, getSelfCheckinInfo, searchSelfCheckin, selfCheckIn } from '@/lib/api';
import { isGuest } from '@/lib/auth';
import { useAction, useLoad, useSession } from '@/lib/hooks';
import { logOut } from '@/lib/profile';
import type { SelfCheckinPlayer } from '@/lib/types';

/** How long the "you're in" screen stays up, so a shared tablet is ready for the next person. */
const RESET_MS = 10_000;

export function SelfCheckIn({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const info = useLoad(() => getSelfCheckinInfo(code), [code]);
  const session = useSession();
  const signedIn = !!session && !isGuest(session);
  const me = useLoad(() => (signedIn ? getMySelfCheckin(code) : Promise.resolve([])), [code, session?.id]);
  // Cancel on the confirm screen leads to finding a name instead.
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState('');
  const [done, setDone] = useState<SelfCheckinPlayer | null>(null);
  const action = useAction();
  const staff = !!info.data?.staff;
  const results = useLoad(
    () => (staff && typed.length >= 2 ? searchSelfCheckin(code, typed) : Promise.resolve([])),
    [code, typed, staff],
  );

  useEffect(() => {
    const wait = setTimeout(() => setTyped(query.trim()), 250);
    return () => clearTimeout(wait);
  }, [query]);

  const reset = () => {
    setDone(null);
    setQuery('');
    setTyped('');
  };
  useEffect(() => {
    if (!done) return;
    const wait = setTimeout(reset, RESET_MS);
    return () => clearTimeout(wait);
  }, [done]);

  if (info.error) return <Empty>{info.error}</Empty>;
  if (info.data === undefined || session === undefined || me.data === undefined) return <Spinner />;
  if (!info.data) return <Empty>Self check-in isn’t on right now. Please see the desk.</Empty>;

  // Players: logged in, and only themselves.
  if (!staff) {
    if (!signedIn) {
      return (
        <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 p-6 text-center">
          <p className="text-lg text-muted">{info.data.tournament_name}</p>
          <h1 className="text-5xl">Check in</h1>
          <p className="text-lg">Log in with the account you registered with, then tap Confirm.</p>
          <Link
            href={`/profile?mode=login&next=${encodeURIComponent(`/k/${code}`)}`}
            className="inline-flex h-14 items-center justify-center rounded-full bg-accent px-6 text-base font-medium text-accent-text"
          >
            Log in
          </Link>
          <p className="text-muted">No account? Please check in at the desk.</p>
        </main>
      );
    }
    if (me.data.length > 0) {
      return <Mine code={code} tournament={info.data.tournament_name} players={me.data} onChanged={me.reload} />;
    }
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 p-6 text-center">
        <p className="text-lg text-muted">{info.data.tournament_name}</p>
        <h1 className="text-5xl">Check in</h1>
        <p className="text-lg">We can’t find an entry under {session?.email}. Please check in at the desk.</p>
        <button type="button" className="text-muted underline" onClick={() => logOut()}>
          Registered with another account? Log out
        </button>
      </main>
    );
  }

  if (me.data.length > 0 && !searching) {
    return (
      <Mine
        code={code}
        tournament={info.data.tournament_name}
        players={me.data}
        onCancel={() => setSearching(true)}
        onChanged={me.reload}
      />
    );
  }

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 p-6 text-center">
        <p className="font-display text-6xl font-extrabold text-live uppercase">You’re in</p>
        <p className="text-3xl font-semibold">
          {done.first_name} {done.last_name}
        </p>
        <ul className="text-lg text-muted">
          {done.teams.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <p className="text-lg">When it’s your turn, your court shows under My matches on the tournament page. Your partner needs to check in separately.</p>
        <ErrorText>{action.error}</ErrorText>
        <div className="flex flex-col gap-2">
          <Button variant="primary" className="h-14 text-base" onClick={reset}>
            Done
          </Button>
          <Button variant="ghost" disabled={action.busy} onClick={() => action.run(() => selfCheckIn(code, done.player_id, false), reset)}>
            Not you? Undo
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-5 p-6">
      <div>
        <p className="text-muted">{info.data.tournament_name}</p>
        <h1 className="text-5xl">Check in</h1>
        <p className="mt-2 text-lg text-muted">Staff: find anyone by name and check them in.</p>
      </div>
      <Input
        aria-label="Your name"
        autoComplete="off"
        autoCapitalize="words"
        spellCheck={false}
        placeholder="Type your name"
        className="h-14 text-xl"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ErrorText>{results.error ?? action.error}</ErrorText>
      <ul className="flex flex-col gap-2">
        {(results.data ?? []).map((p) => (
          <li key={p.player_id}>
            <button
              disabled={action.busy}
              className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 text-left hover:border-text"
              onClick={() =>
                action.run(
                  async () => {
                    if (!p.checked_in) await selfCheckIn(code, p.player_id);
                  },
                  () => setDone(p),
                )
              }
            >
              <span className="min-w-0">
                <span className="block text-xl font-semibold">
                  {p.first_name} {p.last_name}
                </span>
                {p.teams.map((t) => (
                  <span key={t} className="block truncate text-muted">
                    {t}
                  </span>
                ))}
              </span>
              <span className="shrink-0 font-semibold">{p.checked_in ? 'Already in' : 'Check in'}</span>
            </button>
          </li>
        ))}
      </ul>
      {typed.length >= 2 && results.data?.length === 0 && <p className="text-lg text-muted">No match. Please see the desk.</p>}
    </main>
  );
}

/** Logged in: "Josh Checking In", and a tap. One email can hold more than one entry, so all of them check in. */
function Mine({
  code,
  tournament,
  players,
  onCancel,
  onChanged,
}: {
  code: string;
  tournament: string;
  players: SelfCheckinPlayer[];
  /** Staff only: back to finding someone by name. */
  onCancel?: () => void;
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  const [justIn, setJustIn] = useState(false);
  const first = players[0];
  const allIn = players.every((p) => p.checked_in);
  const teams = [...new Set(players.flatMap((p) => p.teams))];
  const setAll = (checkedIn: boolean) => Promise.all(players.map((p) => selfCheckIn(code, p.player_id, checkedIn)));

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-6 text-center">
      <p className="text-lg text-muted">{tournament}</p>
      <h1 className={`text-6xl ${allIn ? 'text-live' : ''}`}>{allIn ? `${first.first_name}, you’re in` : `${first.first_name} Checking In`}</h1>
      <ul className="text-lg text-muted">
        {teams.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      {allIn && <p className="text-lg">When it’s your turn, your court shows under My matches on the tournament page. Your partner needs to check in separately.</p>}
      <ErrorText>{error}</ErrorText>
      {allIn ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            run(
              async () => {
                await setAll(false);
                setJustIn(false);
              },
              onChanged,
            )
          }
        >
          {justIn ? 'Undo' : 'Undo my check-in'}
        </Button>
      ) : (
        <div className={`grid gap-3 ${onCancel ? 'grid-cols-2' : ''}`}>
          {onCancel && (
            <Button className="h-16 text-lg" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            className="h-16 text-lg"
            disabled={busy}
            onClick={() =>
              run(
                async () => {
                  await setAll(true);
                  setJustIn(true);
                },
                onChanged,
              )
            }
          >
            {busy ? 'Checking in…' : 'Confirm'}
          </Button>
        </div>
      )}
      <button type="button" className="text-muted underline" onClick={() => logOut()}>
        Not {first.first_name}? Log out
      </button>
    </main>
  );
}
