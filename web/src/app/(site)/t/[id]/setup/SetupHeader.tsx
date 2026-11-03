'use client';

import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { Button, ErrorText } from '@/components/ui';
import { setTournamentStatus, updateTournament } from '@/lib/api';
import { registrationOpen } from '@/lib/format';
import { useAction, useNow } from '@/lib/hooks';
import type { Tournament, TournamentEvent, TournamentStatus } from '@/lib/types';

const stages: { value: TournamentStatus; label: string; hint: string; dot: string }[] = [
  { value: 'draft', label: 'Draft', hint: 'Only directors can see it.', dot: 'bg-text' },
  { value: 'registration', label: 'Registration', hint: 'Public: players can sign up. It goes live when you start the first division at Check-in.', dot: 'bg-called' },
  { value: 'live', label: 'Live', hint: 'Divisions are playing.', dot: 'bg-live' },
  { value: 'complete', label: 'Complete', hint: 'Results stay public.', dot: 'bg-info' },
];

/**
 * Where the tournament is, and its next step. It moves along on its own:
 * opening registration (here, in a draft), starting the first division, and
 * here again, marking it complete once every division is final.
 */
export function SetupHeader({ tournament, events, onChanged }: { tournament: Tournament; events: TournamentEvent[]; onChanged: () => void }) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const simple = tournament.simple;
  // Simple tournaments take no registrations: 'registration' is published.
  const steps = simple
    ? stages.map((s) =>
        s.value === 'registration'
          ? { ...s, label: 'Published', hint: 'Public: players can find their names and divisions. It goes live when you start the first division.' }
          : s,
      )
    : stages;
  const at = steps.findIndex((s) => s.value === tournament.status);
  const allFinal = events.length > 0 && events.every((e) => e.finalized_at);
  const ready = events.length > 0 && !!tournament.name.trim();

  let action: React.ReactNode = null;
  let note = steps[at].hint;
  if (tournament.status === 'draft' && simple) {
    note = ready
      ? 'Only directors can see it. Publish it when the teams are in, so players can find their names. Start each division from its page.'
      : 'Only directors can see it. Set up the tournament and add a division with its teams, then publish it.';
  } else if (tournament.status === 'draft') {
    note = ready
      ? 'Only directors can see it. Open registration when you’re ready; Check-in and Players show up then, and this page moves to More → Settings.'
      : 'Only directors can see it. Set up the tournament and add a division, then open registration.';
    action = (
      <Button
        variant="primary"
        disabled={busy || !ready}
        onClick={() => run(() => setTournamentStatus(tournament.id, 'registration'), () => router.push(`/t/${tournament.id}`))}
      >
        {simple ? 'Publish' : 'Open registration'}
      </Button>
    );
  } else if (tournament.status === 'live') {
    if (allFinal) {
      action = (
        <Button
          disabled={busy}
          onClick={() =>
            confirm('Mark the tournament complete? Results stay public.') && run(() => setTournamentStatus(tournament.id, 'complete'), onChanged)
          }
        >
          Mark complete
        </Button>
      );
    } else note = 'Divisions are playing. Mark it complete once every division’s results are final.';
  } else if (tournament.status === 'complete') {
    action = (
      <Button variant="ghost" disabled={busy} onClick={() => run(() => setTournamentStatus(tournament.id, 'live'), onChanged)}>
        Reopen
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          {tournament.status !== 'draft' && <h2 className="text-3xl">Settings</h2>}
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-label="Tournament status">
            {steps.map((s, i) => (
              <li key={s.value} aria-current={i === at ? 'step' : undefined} className="flex items-center gap-2">
                {i > 0 && <span className={`h-px w-5 ${i <= at ? 'bg-text' : 'bg-border'}`} aria-hidden />}
                {i < at ? (
                  <Icon name="check" className="h-4 w-4 text-live" />
                ) : (
                  <span className={`h-2.5 w-2.5 rounded-full ${i === at ? s.dot : 'border-2 border-border'}`} aria-hidden />
                )}
                <span className={i === at ? 'font-semibold' : 'text-muted'}>{s.label}</span>
              </li>
            ))}
          </ol>
          <p className="text-sm text-muted">{note}</p>
          <ErrorText>{error}</ErrorText>
      </div>
      {action && <div className="shrink-0">{action}</div>}
      </div>
      {!simple && (tournament.status === 'registration' || tournament.status === 'live') && (
        <RegistrationSwitch tournament={tournament} onChanged={onChanged} />
      )}
    </div>
  );
}

/**
 * Registration open or closed to players: close it now, or reopen it (also
 * once the tournament is live, and clearing a closing date that has passed).
 * Directors can register someone either way (More → Register a player).
 */
function RegistrationSwitch({ tournament: t, onChanged }: { tournament: Tournament; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const now = useNow(60_000);
  const open = registrationOpen(t, now);
  const closes = t.registration_closes_at;
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: t.time_zone });
  const live = t.status === 'live';
  const changes = open
    ? live
      ? { registration_reopened: false }
      : { registration_closes_at: new Date(now).toISOString() }
    : {
        ...(closes && new Date(closes).getTime() < now ? { registration_closes_at: null } : {}),
        ...(live ? { registration_reopened: true } : {}),
      };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <p className="text-sm">
        {open ? (
          <span className="font-semibold text-live">Registration is open{closes ? ` until ${day(closes)}` : ''}.</span>
        ) : (
          <>
            <span className="font-semibold">Registration is closed to players.</span>{' '}
            <span className="text-muted">You can still register someone from More → Register a player.</span>
          </>
        )}
      </p>
      <Button size="sm" disabled={busy} onClick={() => run(() => updateTournament(t.id, changes), onChanged)}>
        {open ? 'Close registration' : 'Reopen registration'}
      </Button>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
