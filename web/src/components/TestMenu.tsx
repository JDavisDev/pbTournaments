'use client';

// Demo and local sites: everything for trying sign-ups in one place. Pick a
// tournament, pick who you are, register, and see what happened.
import { useRouter } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { auth, isGuest } from '@/lib/auth';
import { useAction, useSession } from '@/lib/hooks';
import { backToTestPlayer, becomeFakePlayer, forgetTestPlayer, logOut, TEST_PASSWORD, useProfile, useTestPartner } from '@/lib/profile';
import { scenarios } from '@/lib/testScenarios';
import { clearTestLog, useTestLog } from '@/lib/testLog';
import { setViewMode } from '@/lib/viewMode';
import { Button, ErrorText, Modal } from './ui';

const KEY = 'courtside-test-tournament';
const listeners = new Set<() => void>();
const readTournament = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
function rememberTournament(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {}
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

export function TestMenu() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="h-9 rounded-full bg-called-soft px-3 font-semibold whitespace-nowrap text-called hover:brightness-95"
        onClick={() => setOpen(true)}
      >
        Test
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Test sign-ups">
        {open && <Panel onClose={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const profile = useProfile();
  const partner = useTestPartner();
  const session = useSession();
  const log = useTestLog();
  const tournament = useSyncExternalStore(subscribe, readTournament, () => null);
  const [copied, setCopied] = useState(false);
  const go = (href: string) => (onClose(), router.push(href));

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-lg">1. Start a test tournament</h3>
        <div className="flex flex-col gap-2">
          {scenarios.map((s) => (
            <Button
              key={s.key}
              className="h-auto flex-col items-start py-2 text-left"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const id = await s.run();
                  await backToTestPlayer();
                  rememberTournament(id);
                  setViewMode('admin');
                  go(`/t/${id}/register`);
                })
              }
            >
              <span className="font-semibold">{busy ? 'Building…' : s.label}</span>
              <span className="text-xs font-normal text-muted">{s.hint}</span>
            </Button>
          ))}
        </div>
        <ErrorText>{error}</ErrorText>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">2. Choose who you are</h3>
        <p className="text-sm">
          {profile ? (
            <>
              <strong>
                {profile.first_name} {profile.last_name}
              </strong>{' '}
              <span className="text-muted">{profile.email}</span>
            </>
          ) : (
            <span className="text-muted">A new player, with no profile.</span>
          )}
        </p>
        {partner && (
          <p className="text-sm text-muted">
            Partner to name: {partner.first_name} {partner.last_name}, {partner.email}
          </p>
        )}
        <p className="text-xs text-muted">Fake players log in with the password {TEST_PASSWORD}.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => becomeFakePlayer(profile))}>
            New fake player
          </Button>
          <Button size="sm" disabled={busy || !profile} onClick={() => run(async () => (forgetTestPlayer(), await logOut()))}>
            Log out
          </Button>
          <Button size="sm" onClick={() => go('/profile')}>
            Sign-up page
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">3. Check the result</h3>
        <p className="text-sm text-muted">
          {session === undefined ? '' : !session ? 'Signed out. ' : isGuest(session) ? 'Signed in as the director of test tournaments. ' : `Logged in as ${session.email}. `}
          {tournament ? '' : 'Start a test tournament first.'}
        </p>
        {tournament && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => go(`/t/${tournament}/register`)}>
              Register page
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await auth.signInAsGuest();
                  setViewMode('admin');
                  go(`/t/${tournament}/players`);
                })
              }
            >
              Sign-ups, as director
            </Button>
            <Button
              size="sm"
              disabled={busy || !session || !isGuest(session)}
              onClick={() =>
                run(async () => {
                  await backToTestPlayer();
                })
              }
            >
              Back to player
            </Button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg">Activity</h3>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={log.length === 0}
              onClick={() => navigator.clipboard.writeText(JSON.stringify(log, null, 2)).then(() => setCopied(true))}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button size="sm" variant="ghost" disabled={log.length === 0} onClick={clearTestLog}>
              Clear
            </Button>
          </div>
        </div>
        {log.length === 0 ? (
          <p className="text-sm text-muted">Every change the app makes shows here, with any error.</p>
        ) : (
          <ul className="flex max-h-64 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border text-sm">
            {log.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <details>
                  <summary className={`cursor-pointer px-2.5 py-1.5 ${e.ok ? '' : 'font-semibold text-late'}`}>
                    <span className="font-mono">{e.call}</span> <span className="text-xs text-muted">{e.at} · {e.ms}ms</span>
                    {!e.ok && <span className="block font-normal">{String(e.result)}</span>}
                  </summary>
                  <pre className="overflow-x-auto bg-surface-2 p-2.5 text-xs">{JSON.stringify({ sent: e.args, got: e.result }, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  );
}
