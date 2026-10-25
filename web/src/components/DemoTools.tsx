'use client';

// Practice tournaments: build one in a click, play it forward with the demo
// clock, and (on team pages) read the texts its players were sent.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { advanceDemo, createDemoTournament, getDemoInbox } from '@/lib/api';
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
        <ErrorText>{error}</ErrorText>
      </div>
      {signedIn ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const id = await createDemoTournament(true);
                router.push(`/t/${id}/desk`);
              })
            }
          >
            {busy ? 'Building…' : 'Start one in play'}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const id = await createDemoTournament(false);
                router.push(`/t/${id}/checkin`);
              })
            }
          >
            Start at check-in
          </Button>
        </div>
      ) : (
        <Link href="/login" className="inline-flex h-12 items-center rounded-full bg-accent px-6 font-medium text-accent-text">
          Create a free test account
        </Link>
      )}
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
  const advance = (minutes: number) => run(() => advanceDemo(tournamentId, minutes), onChanged);
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
export function DemoInbox({ tournamentId, teamId }: { tournamentId: string; teamId: string }) {
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
              To {t.player_name} · {formatTime(t.created_at)}
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
