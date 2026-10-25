'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { getEvents, getTournament } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useLoad, useNow, useStaffAccess } from '@/lib/hooks';
import { isBackendConfigured, isDemoMode } from '@/lib/config';
import { setViewMode, type ViewMode } from '@/lib/viewMode';
import { DemoClock } from './DemoTools';
import { useMyTeam } from './MatchDay';
import { ShareDialog } from './ShareDialog';
import { Icon } from './Icon';
import { WatchChip } from './StreamEmbed';
import { Badge, Button } from './ui';

const statusTone = { draft: 'neutral', registration: 'info', live: 'live', complete: 'neutral' } as const;
const statusText = { draft: 'Draft', registration: 'Registration', live: 'Live', complete: 'Complete' };

export function TournamentNav({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pathname = usePathname();
  const tournament = useLoad(() => Promise.all([getTournament(id), getEvents(id)]), [id]);
  const [sharing, setSharing] = useState(false);
  const staff = useStaffAccess(id);
  const [myTeam] = useMyTeam(id);
  const router = useRouter();
  const now = useNow(15_000);

  if (!isBackendConfigured || !tournament.data) return null;
  const [t, events] = tournament.data;
  const base = `/t/${id}`;
  const tabs = [
    { href: base, label: 'Overview' },
    ...(!staff.data && myTeam ? [{ href: `${base}/teams/${myTeam}`, label: 'My matches' }] : []),
    ...(t.status === 'registration' ? [{ href: `${base}/register`, label: 'Register' }] : []),
    ...(staff.data
      ? [
          { href: `${base}/checkin`, label: 'Check-in' },
          { href: `${base}/desk`, label: 'Court desk' },
          { href: `${base}/players`, label: 'Players' },
          { href: `${base}/messages`, label: 'Messages' },
          { href: `${base}/registrations`, label: 'Registrations' },
          { href: `${base}/dupr`, label: 'DUPR' },
          { href: `${base}/setup`, label: 'Setup' },
          { href: `${base}/planner`, label: 'Planner' },
        ]
      : []),
  ];

  const switchTo = (mode: ViewMode) => {
    setViewMode(mode);
    router.push(mode === 'player' ? (myTeam ? `${base}/teams/${myTeam}` : base) : `${base}/desk`);
  };

  return (
    <div className="mb-8">
      {isDemoMode && staff.account && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-dashed border-called/60 px-4 py-3">
          <p className="text-sm">
            <span className="font-semibold">Demo: </span>
            {staff.view === 'player'
              ? 'you’re seeing what a player sees: their own matches, the schedule and results. No director tools.'
              : 'you’re seeing the director’s tools. Switch to see what a player sees.'}
          </p>
          <div className="flex gap-1 rounded-full bg-surface-2 p-1" role="radiogroup" aria-label="View as">
            {(
              [
                ['admin', 'View as admin'],
                ['player', 'View as player'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                role="radio"
                aria-checked={staff.view === mode}
                onClick={() => staff.view !== mode && switchTo(mode)}
                className={`h-10 rounded-full px-4 text-sm font-semibold whitespace-nowrap ${
                  staff.view === mode ? 'bg-accent text-accent-text' : 'text-muted hover:text-text'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {staff.view === 'player' && t.is_demo && (
            <div className="w-full">
              <DemoClock tournamentId={id} now={now} timeZone={t.time_zone} onChanged={() => {}} />
            </div>
          )}
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
        {tabs.map((tab) => {
          const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`-mb-px border-b-2 py-3 font-medium whitespace-nowrap ${
                active ? 'border-text text-text' : 'border-transparent text-muted hover:text-text'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
        <a
          href={`/tv/${id}`}
          target="_blank"
          className="-mb-px border-b-2 border-transparent py-3 font-medium whitespace-nowrap text-muted hover:text-text"
        >
          <span className="inline-flex items-center gap-1">TV board <Icon name="external" className="h-4 w-4" /></span>
        </a>
      </nav>
    </div>
  );
}
