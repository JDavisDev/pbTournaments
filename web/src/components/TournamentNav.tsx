'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { use } from 'react';
import { getTournament, isStaff } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useLoad, useSession } from '@/lib/hooks';
import { isSupabaseConfigured } from '@/lib/supabase';
import { Badge } from './ui';

const statusTone = { draft: 'neutral', registration: 'info', live: 'live', complete: 'neutral' } as const;
const statusText = { draft: 'Draft', registration: 'Registration', live: 'Live', complete: 'Complete' };

export function TournamentNav({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pathname = usePathname();
  const session = useSession();
  const tournament = useLoad(() => getTournament(id), [id]);
  const staff = useLoad(() => (session ? isStaff(id) : Promise.resolve(false)), [id, session?.user.id]);

  if (!isSupabaseConfigured || !tournament.data) return null;
  const t = tournament.data;
  const base = `/t/${id}`;
  const tabs = [
    { href: base, label: 'Overview' },
    ...(staff.data
      ? [
          { href: `${base}/desk`, label: 'Court desk' },
          { href: `${base}/setup`, label: 'Setup' },
        ]
      : []),
  ];

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t.name}</h1>
        <Badge tone={statusTone[t.status]}>{statusText[t.status]}</Badge>
        {t.status === 'live' && !t.auto_assign && <Badge tone="called">Paused</Badge>}
      </div>
      <p className="mt-1 text-sm text-muted">{formatDate(t.starts_on)}</p>
      <nav className="mt-4 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((tab) => {
          const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${
                active ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
        <a
          href={`/tv/${id}`}
          target="_blank"
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium whitespace-nowrap text-muted hover:text-text"
        >
          TV board ↗
        </a>
      </nav>
    </div>
  );
}
