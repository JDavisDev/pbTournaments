'use client';

// At the door: on a tablet, or a player's own phone from the QR code. No
// account needed; the link is the permission, and it only checks people in.
import { use, useEffect, useState } from 'react';
import { Button, Empty, ErrorText, Input, Spinner } from '@/components/ui';
import { getSelfCheckinInfo, searchSelfCheckin, selfCheckIn } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import type { SelfCheckinPlayer } from '@/lib/types';

/** How long the "you're in" screen stays up, so a shared tablet is ready for the next person. */
const RESET_MS = 10_000;

export function SelfCheckIn({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const info = useLoad(() => getSelfCheckinInfo(code), [code]);
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState('');
  const [done, setDone] = useState<SelfCheckinPlayer | null>(null);
  const action = useAction();
  const results = useLoad(() => (typed.length >= 2 ? searchSelfCheckin(code, typed) : Promise.resolve([])), [code, typed]);

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
  if (info.data === undefined) return <Spinner />;
  if (!info.data) return <Empty>Self check-in isn’t on right now. Please see the desk.</Empty>;

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
        <p className="text-lg">We’ll text you when it’s time to play. Your partner checks in too.</p>
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
