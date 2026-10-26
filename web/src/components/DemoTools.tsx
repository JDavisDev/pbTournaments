'use client';

// Practice tournaments: build one in a click, play it forward with the demo
// clock, and (on team pages) read the texts its players were sent.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { advanceDemo, createDemoTournament, getDemoInbox } from '@/lib/api';
import { auth } from '@/lib/auth';
import { setViewMode } from '@/lib/viewMode';
import { formatTime } from '@/lib/format';
import { useAction, useLiveTournament } from '@/lib/hooks';
import { Icon } from './Icon';
import { Button, Card, ErrorText } from './ui';

export function DemoCard({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  return (
    <Card className="mb-12 flex flex-wrap items-center justify-between gap-4 border-2 border-dashed border-called/60 p-6">
      <div className="max-w-xl">
        <h2 className="text-3xl">Try it with a practice tournament</h2>
        <p className="mt-1 text-muted">
          Build a full tournament in one click: 11 courts, 36 teams in four divisions with different start times. Run the
          court desk, check players in, enter scores, and fast-forward the clock to watch the day play out. Nothing is
          charged and no real texts are sent.
        </p>
        {!signedIn && <p className="mt-2 text-sm text-muted">No account needed: you’ll be signed in as a guest.</p>}
        <ErrorText>{error}</ErrorText>
      </div>
      <div className="flex flex-wrap gap-2">
        {(
          [
            [true, 'Start one in play', 'desk'],
            [false, 'Start at check-in', 'checkin'],
          ] as const
        ).map(([arrived, label, page]) => (
          <Button
            key={page}
            variant={arrived ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (!signedIn) await auth.signInAsGuest();
                setViewMode('admin');
                const id = await createDemoTournament(arrived);
                router.push(`/t/${id}/${page}`);
              })
            }
          >
            {busy && arrived ? 'Building…' : label}
          </Button>
        ))}
      </div>
    </Card>
  );
}

/** Fast-forward for a demo tournament. */
export function DemoClock({
  tournamentId,
  now,
  timeZone,
  onChanged,
}: {
  tournamentId: string;
  now: number;
  timeZone: string;
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  // Hosted databases stop a call after a few seconds, so go 10 minutes at a time.
  const advance = (minutes: number) =>
    run(async () => {
      for (let left = minutes; left > 0; left -= 10) await advanceDemo(tournamentId, Math.min(10, left));
    }, onChanged);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border-2 border-dashed border-called/50 bg-called-soft/40 px-4 py-3">
      <Icon name="clock" className="h-6 w-6 text-called" />
      <span className="font-semibold">Practice tournament</span>
      <span className="tnum text-muted">{formatTime(new Date(now).toISOString(), timeZone)}</span>
      <span className="text-sm text-muted">Fast-forward: players arrive, matches finish with made-up scores, courts refill.</span>
      <div className="ml-auto flex flex-wrap gap-1.5">
        {[5, 15, 60].map((m) => (
          <Button key={m} size="sm" disabled={busy} onClick={() => advance(m)}>
            +{m === 60 ? '1 hr' : `${m} min`}
          </Button>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** Demo tournaments only: the texts this team's players got, so a tester can play the team. */
export function DemoInbox({ tournamentId, teamId, timeZone }: { tournamentId: string; teamId: string; timeZone: string }) {
  const { data } = useLiveTournament(tournamentId, () => getDemoInbox(teamId));
  if (!data || data.length === 0) return null;
  return (
    <section className="rounded-2xl border-2 border-dashed border-called/50 p-4">
      <h3 className="text-2xl">Texts this team got</h3>
      <p className="mb-3 text-sm text-muted">Practice tournament: shown here instead of sent. Tap a link to play the part of this team.</p>
      <ul className="flex flex-col gap-2">
        {data.slice(0, 6).map((t) => (
          <li key={t.id} className="rounded-2xl rounded-tl-sm bg-surface-2 px-4 py-3">
            <p className="text-xs text-muted">
              To {t.player_name} · {formatTime(t.created_at, timeZone)}
            </p>
            <p className="break-words">
              {t.body.split(/(\/s\/\w+)/).map((part, i) =>
                part.startsWith('/s/') ? (
                  <Link key={i} href={part} className="font-semibold underline">
                    {typeof window === 'undefined' ? part : `${window.location.host}${part}`}
                  </Link>
                ) : (
                  part
                ),
              )}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
