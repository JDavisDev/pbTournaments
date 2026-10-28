'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { getEvents, getTournament } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { auth } from '@/lib/auth';
import { useAction, useLiveTournament, useNow, useSession, useStaffAccess } from '@/lib/hooks';
import { isBackendConfigured, isDemoMode } from '@/lib/config';
import { setViewMode, type ViewMode } from '@/lib/viewMode';
import { Announcement } from './Announcement';
import { DemoClock } from './DemoTools';
import { useMyTeam } from './MatchDay';
import { ShareDialog } from './ShareDialog';
import { Icon, type IconName } from './Icon';
import { WatchChip } from './StreamEmbed';
import { Badge, Button, Modal } from './ui';

const statusTone = { draft: 'neutral', registration: 'called', live: 'live', complete: 'info' } as const;
const statusText = { draft: 'Draft', registration: 'Registration', live: 'Live', complete: 'Complete' };

type Tab = { href: string; label: string };
/** A page in the More sheet: used less often than the tabs. */
type MoreItem = Tab & { icon: IconName; hint: string; newTab?: boolean };

export function TournamentNav({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pathname = usePathname();
  // Live: the tabs change as the tournament moves along (a division starting shows the court desk).
  const tournament = useLiveTournament(id, () => Promise.all([getTournament(id), getEvents(id)]));
  const [sharing, setSharing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const staff = useStaffAccess(id);
  const [myTeam] = useMyTeam(id);
  const router = useRouter();
  const now = useNow(15_000);
  const session = useSession();
  const switching = useAction();

  if (!isBackendConfigured || !tournament.data) return null;
  const [t, events] = tournament.data;
  const base = `/t/${id}`;
  const draft = t.status === 'draft';
  // The court desk is for play: it shows once a director starts a division.
  const playing = events.some((e) => e.started_at) && t.status !== 'complete';
  const desk = playing ? [{ href: `${base}/desk`, label: 'Court desk' }] : [];
  const register = t.status === 'registration' ? [{ href: `${base}/register`, label: 'Register' }] : [];
  const tv: MoreItem = { href: `/tv/${id}`, label: 'TV board', icon: 'tv', hint: 'Courts and results for a big screen', newTab: true };
  let tabs: Tab[];
  let more: MoreItem[] = [];
  if (staff.data) {
    // A draft is set up first; the other tabs come once registration opens.
    tabs = draft
      ? [{ href: `${base}/setup`, label: 'Setup' }, { href: base, label: 'Overview' }]
      : [{ href: base, label: 'Overview' }, { href: `${base}/checkin`, label: 'Check-in' }, ...desk, { href: `${base}/players`, label: 'Players' }];
    more = [
      draft
        ? { href: `${base}/players`, label: 'Players', icon: 'people', hint: 'Everyone entered so far' }
        : { href: `${base}/setup`, label: 'Settings', icon: 'sliders', hint: 'Details, divisions, prices and registration' },
      { href: `${base}/planner`, label: 'Planner', icon: 'calendar', hint: 'Plan the day’s divisions and courts' },
      { href: `${base}/messages`, label: 'Messages', icon: 'message', hint: 'Text and email players' },
      ...(draft ? [] : [{ href: `${base}/dupr`, label: 'DUPR', icon: 'upload', hint: 'Send final results to DUPR' } as MoreItem]),
      ...(t.status === 'registration'
        ? [{ href: `${base}/register`, label: 'Register a player', icon: 'pen', hint: 'The registration form' } as MoreItem]
        : []),
      tv,
    ];
  } else if (staff.monitor) {
    tabs = [{ href: base, label: 'Overview' }, { href: `${base}/checkin`, label: 'Check-in' }, ...desk];
    more = [tv];
  } else {
    tabs = [
      { href: base, label: 'Overview' },
      ...(myTeam ? [{ href: `${base}/teams/${myTeam}`, label: 'My matches' }] : []),
      ...register,
    ];
  }
  const isActive = (href: string) => (href === base ? pathname === base : pathname.startsWith(href));
  const moreActive = more.find((m) => !m.newTab && isActive(m.href));

  // Director view needs a session: on a practice tournament anyone signed in
  // (a guest too, which demo sites make automatically) is a director.
  const view: ViewMode = staff.data ? 'admin' : 'player';
  const switchTo = (mode: ViewMode) =>
    switching.run(async () => {
      if (mode === 'admin' && !session) await auth.signInAsGuest();
      setViewMode(mode);
      router.push(mode === 'player' ? (myTeam ? `${base}/teams/${myTeam}` : base) : draft ? `${base}/setup` : playing ? `${base}/desk` : `${base}/checkin`);
    });
  const showDemoBar = isDemoMode && (staff.account || t.is_demo);

  return (
    <div className="mb-8">
      {showDemoBar && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-dashed border-called/60 px-4 py-3">
          <p className="text-sm">
            <span className="font-semibold">Demo: </span>
            {view === 'player'
              ? 'you’re seeing what a player sees: their own matches, the schedule and results. No director tools.'
              : 'you’re seeing the director’s tools. Switch to see what a player sees.'}
          </p>
          <div className="flex gap-1 rounded-full bg-surface-2 p-1" role="radiogroup" aria-label="View as">
            {(
              [
                ['admin', 'View as director'],
                ['player', 'View as player'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                role="radio"
                aria-checked={view === mode}
                disabled={switching.busy}
                onClick={() => view !== mode && switchTo(mode)}
                className={`h-10 rounded-full px-4 text-sm font-semibold whitespace-nowrap ${
                  view === mode ? 'bg-accent text-accent-text' : 'text-muted hover:text-text'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {switching.error && <p className="w-full text-sm text-late">{switching.error}</p>}
          {view === 'player' && staff.account && t.is_demo && (
            <div className="w-full">
              <DemoClock tournamentId={id} now={now} timeZone={t.time_zone} onChanged={() => {}} />
            </div>
          )}
        </div>
      )}
      {/* On every page of the tournament; directors post one from the Overview. */}
      {(t.announcement || (staff.data && pathname === base)) && (
        <div className="mb-5 flex flex-col">
          <Announcement tournament={t} editable={!!staff.data} onChanged={tournament.reload} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone[t.status]}>{statusText[t.status]}</Badge>
        {t.status === 'live' && !t.auto_assign && <Badge tone="called">Paused</Badge>}
        <span className="text-sm text-muted">{formatDate(t.starts_on)}</span>
        {t.stream_url && <WatchChip url={t.stream_url} label="Watch live" />}
      </div>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-5xl sm:text-7xl">{t.name}</h1>
        <Button size="sm" onClick={() => setSharing(true)}>
          <Icon name="share" /> Share
        </Button>
      </div>
      <ShareDialog open={sharing} onClose={() => setSharing(false)} tournament={t} events={events} />
      <nav className="mt-6 flex gap-6 overflow-x-auto overflow-y-hidden border-b border-border [scrollbar-width:none]">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`-mb-px border-b-2 py-3 font-medium whitespace-nowrap ${
              isActive(tab.href) ? 'border-text text-text' : 'border-transparent text-muted hover:text-text'
            }`}
          >
            {tab.label}
          </Link>
        ))}
        {more.length > 0 ? (
          <button
            onClick={() => setMoreOpen(true)}
            aria-haspopup="dialog"
            className={`-mb-px inline-flex items-center gap-1 border-b-2 py-3 font-medium whitespace-nowrap ${
              moreActive ? 'border-text text-text' : 'border-transparent text-muted hover:text-text'
            }`}
          >
            {moreActive ? moreActive.label : 'More'}
            <Icon name="chevron" className="h-4 w-4" />
          </button>
        ) : (
          <a
            href={`/tv/${id}`}
            target="_blank"
            className="-mb-px border-b-2 border-transparent py-3 font-medium whitespace-nowrap text-muted hover:text-text"
          >
            <span className="inline-flex items-center gap-1">
              TV board <Icon name="external" className="h-4 w-4" />
            </span>
          </a>
        )}
      </nav>
      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <ul className="flex flex-col gap-2">
          {more.map((m) => (
            <li key={m.href}>
              <Link
                href={m.href}
                target={m.newTab ? '_blank' : undefined}
                onClick={() => setMoreOpen(false)}
                className={`flex min-h-16 items-center gap-4 rounded-2xl px-4 py-3 ${
                  moreActive === m ? 'bg-accent-soft' : 'bg-surface-2 hover:bg-border'
                }`}
              >
                <Icon name={m.icon} className="h-6 w-6" />
                <span className="min-w-0 flex-1">
                  <span className="block text-lg font-semibold">{m.label}</span>
                  <span className="block text-sm text-muted">{m.hint}</span>
                </span>
                <Icon name={m.newTab ? 'external' : 'arrow'} className="h-5 w-5 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
        <Button className="mt-4 w-full" onClick={() => setMoreOpen(false)}>
          Cancel
        </Button>
      </Modal>
    </div>
  );
}
