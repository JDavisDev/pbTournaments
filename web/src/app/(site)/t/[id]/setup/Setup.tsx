'use client';

// Setup: the tournament's settings (cards in BasicsCard, PricesCard,
// SetupCards and CourtCards), then its divisions (EventCard, EventForm).
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Icon } from '@/components/Icon';
import { Button, Card, Empty, ErrorText, Spinner } from '@/components/ui';
import { getCourtBoard, getEventMerges, getEvents, getMatches, getTeams, getTournament } from '@/lib/api';
import { useAction, useLiveTournament, useStaffAccess } from '@/lib/hooks';
import { BasicsCard, ScoresCard } from './BasicsCard';
import { ChampionshipCard, StreamsCard } from './CourtCards';
import { EventCard } from './EventCard';
import { EventForm } from './EventForm';
import { PricesCard } from './PricesCard';
import { SaveAllProvider, useSaveAll, useUnsavedSections } from './SaveAll';
import { AboutCard, DiscountCodesCard, FeesCard, PaymentsCard, QuestionsCard, RegistrationCard, SharingCard } from './SetupCards';
import { SetupHeader } from './SetupHeader';

async function load(id: string) {
  const [tournament, events, teams, matches, courts] = await Promise.all([
    getTournament(id),
    getEvents(id),
    getTeams(id),
    getMatches(id),
    getCourtBoard(id),
  ]);
  const merges = await getEventMerges(events.map((e) => e.id)).catch(() => []);
  return { tournament, events, teams, matches, courts, merges };
}

type Step = 'settings' | 'divisions';

export function Setup({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => load(id));
  const [adding, setAdding] = useState(false);
  // ?step=divisions opens the divisions (a division page's "Division settings" link).
  const [step, setStep] = useState<Step>(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('step') === 'divisions' ? 'divisions' : 'settings',
  );

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>Setup is for this tournament’s directors.</Empty>;

  // A draft starts here: its name, date and venue come first.
  const draft = data.tournament.status === 'draft';
  // Simple: no prices, registration, payments or texts.
  const simple = data.tournament.simple;
  const go = (next: Step) => {
    setStep(next);
    window.history.replaceState(null, '', next === 'divisions' ? '?step=divisions' : window.location.pathname);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <SetupHeader tournament={data.tournament} events={data.events} onChanged={reload} />
      <Steps step={step} divisions={data.events.length} onStep={go} />

      {/* Both steps stay mounted, so switching keeps what's typed. */}
      <SaveAllProvider>
        <section className={step === 'settings' ? 'flex flex-col' : 'hidden'}>
          <BasicsCard
            key={`details-${data.tournament.id}`}
            tournament={data.tournament}
            courtCount={data.courts.length}
            startHere={draft}
          />
          <AboutCard key={`about-${data.tournament.id}`} tournament={data.tournament} />
          {simple ? (
            <ScoresCard key={`scores-${data.tournament.id}`} tournament={data.tournament} />
          ) : (
            <>
              <PricesCard key={`prices-${data.tournament.id}`} tournament={data.tournament} />
              <RegistrationCard
                key={`reg-${data.tournament.id}-${data.tournament.registration_closes_at}`}
                tournament={data.tournament}
                onChanged={reload}
              />
            </>
          )}
          {/* Optional: folded to a line each. */}
          <div className="mt-2 border-b border-border">
            {!simple && (
              <>
                <QuestionsCard tournament={data.tournament} />
                <DiscountCodesCard tournament={data.tournament} />
                <PaymentsCard tournament={data.tournament} />
                <FeesCard tournament={data.tournament} onChanged={reload} />
              </>
            )}
            <SharingCard tournament={data.tournament} />
            <StreamsCard tournament={data.tournament} courts={data.courts} />
            <ChampionshipCard key={`champ-${data.tournament.id}`} tournament={data.tournament} courts={data.courts} />
          </div>
          <ContinueToDivisions onDone={() => (reload(), go('divisions'))} />
          <SaveBar onSaved={reload} />
        </section>
      </SaveAllProvider>

      <section className={`flex flex-col gap-4 ${step === 'divisions' ? '' : 'hidden'}`}>
        <div className="flex items-center justify-between">
          <h2 className="text-3xl">Divisions</h2>
          {!adding && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add division
            </Button>
          )}
        </div>
        {adding && (
          <Card className="p-4">
            <EventForm
              tournamentId={id}
              timeZone={data.tournament.time_zone}
              courts={data.courts}
              simple={simple}
              firstEventIncluded={!simple && data.tournament.first_event_included}
              onDone={() => (setAdding(false), reload())}
              onCancel={() => setAdding(false)}
            />
          </Card>
        )}
        {data.events.length === 0 && !adding && <Empty>Add your first division, e.g. “Men’s Doubles 3.5”.</Empty>}
        {data.events.map((e) => (
          <EventCard
            key={e.id}
            event={e}
            timeZone={data.tournament.time_zone}
            firstEventIncluded={!simple && data.tournament.first_event_included}
            simple={simple}
            courts={data.courts}
            teams={data.teams.filter((t) => t.event_id === e.id)}
            matches={data.matches.filter((m) => m.event_id === e.id)}
            isDemo={data.tournament.is_demo}
            others={data.events.filter((o) => o.id !== e.id && o.kind === e.kind && !o.started_at)}
            merges={data.merges.filter((m) => m.into_event_id === e.id)}
            onChanged={reload}
          />
        ))}
        <Button variant="ghost" className="self-start" onClick={() => go('settings')}>
          ← Back to tournament settings
        </Button>
      </section>
    </div>
  );
}

/** Setup's two steps: the tournament's settings, then its divisions. */
function Steps({ step, divisions, onStep }: { step: Step; divisions: number; onStep: (step: Step) => void }) {
  const steps: [Step, string][] = [
    ['settings', 'Tournament'],
    ['divisions', divisions ? `Divisions · ${divisions}` : 'Divisions'],
  ];
  return (
    <nav className="flex gap-1 self-start rounded-full bg-surface-2 p-1" aria-label="Setup steps">
      {steps.map(([key, label]) => (
        <button
          key={key}
          onClick={() => onStep(key)}
          aria-current={step === key ? 'step' : undefined}
          className={`h-11 rounded-full px-5 font-semibold whitespace-nowrap ${
            step === key ? 'bg-accent text-accent-text' : 'text-muted hover:text-text'
          }`}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

/** The end of the settings step: save anything unsaved, then on to the divisions. */
function ContinueToDivisions({ onDone }: { onDone: () => void }) {
  const saveAll = useSaveAll();
  const { busy, error, run } = useAction();
  return (
    <div className="flex flex-col items-end gap-2 pt-8">
      <Button variant="primary" className="w-full sm:w-auto" disabled={busy} onClick={() => run(saveAll, onDone)}>
        {busy ? 'Saving…' : 'Continue to divisions'} <Icon name="arrow" />
      </Button>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

const sectionNames: Record<string, string> = {
  details: 'Basics',
  about: 'About',
  prices: 'Prices',
  registration: 'Registration',
  scores: 'Scores',
  streams: 'Live streams',
  championship: 'Championship courts',
};

/** One Save for every section: shows while any of them has unsaved changes, and briefly after saving. */
function SaveBar({ onSaved }: { onSaved: () => void }) {
  const unsaved = useUnsavedSections();
  const saveAll = useSaveAll();
  const { busy, error, run } = useAction();
  const [justSaved, setJustSaved] = useState(false);
  const names = [...unsaved].map((n) => sectionNames[n] ?? n);
  if (names.length === 0 && !justSaved) return null;
  return (
    <div className="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur" role="status">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={`min-w-0 ${names.length ? '' : 'text-live'}`}>
          {names.length ? (
            <>
              <span className="font-semibold">Unsaved changes</span>
              <span className="text-muted"> · {names.join(', ')}</span>
            </>
          ) : (
            'Saved.'
          )}
        </p>
        {names.length > 0 && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              run(saveAll, () => {
                setJustSaved(true);
                setTimeout(() => setJustSaved(false), 2500);
                onSaved();
              })
            }
          >
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
