'use client';

import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { MessageComposer, type Recipient } from '@/components/MessageComposer';
import { Badge, Card, Empty, Input, Spinner } from '@/components/ui';
import { getEvents, getTextLog, getTournament } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { useLiveTournament, useLoad, useStaffAccess } from '@/lib/hooks';
import type { TextLogRow, TwilioCheck } from '@/lib/types';

async function load(id: string) {
  const [tournament, events, messages] = await Promise.all([getTournament(id), getEvents(id), getTextLog(id)]);
  return { tournament, events, messages };
}

type Outcome = 'queued' | 'skipped' | 'failed' | 'logged' | 'sent' | 'delivered';

/** Where a message ended up, using Twilio's delivery report when there is one. */
function outcome(m: TextLogRow): Outcome {
  if (!m.channel) return 'queued';
  if (m.channel === 'none') return 'skipped';
  if (m.error || m.delivery_status === 'failed' || m.delivery_status === 'undelivered') return 'failed';
  if (m.channel === 'log') return 'logged';
  return m.delivery_status === 'delivered' ? 'delivered' : 'sent';
}

const outcomeBadge: Record<Outcome, [string, 'info' | 'neutral' | 'late' | 'called' | 'live']> = {
  queued: ['Queued', 'info'],
  skipped: ['Not sent', 'neutral'],
  failed: ['Failed', 'late'],
  logged: ['Test log', 'called'],
  sent: ['Sent', 'live'],
  delivered: ['Delivered', 'live'],
};

function Status({ m }: { m: TextLogRow }) {
  const [label, tone] = outcomeBadge[outcome(m)];
  return <Badge tone={tone}>{label}</Badge>;
}

/** Texting setup at a glance: mode, sender, account, delivery reports, and anything to fix. */
function TextingHealth({ check, messages }: { check: TwilioCheck | undefined; messages: TextLogRow[] }) {
  const texts = messages.filter((m) => m.via === 'sms');
  const counts = Object.fromEntries((['delivered', 'sent', 'failed', 'skipped', 'logged', 'queued'] as Outcome[]).map((o) => [o, 0]));
  for (const m of texts) counts[outcome(m)]++;
  const reasons = new Map<string, number>();
  for (const m of texts) {
    const o = outcome(m);
    if ((o === 'failed' || o === 'skipped') && m.error) reasons.set(m.error, (reasons.get(m.error) ?? 0) + 1);
  }
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-2xl">Texting</h2>
        {check && <Badge tone={check.error ? 'late' : check.mode === 'live' ? 'live' : 'called'}>{check.error ? 'Problem' : check.mode === 'live' ? 'Twilio live' : 'Test log'}</Badge>}
      </div>
      {check?.mode === 'live' ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">Sender</dt>
          <dd className="tnum">{check.sender}</dd>
          <dt className="text-muted">Account</dt>
          <dd>{check.account ? `${check.account.type} · ${check.account.status}` : '—'}</dd>
          <dt className="text-muted">Reports</dt>
          <dd>{check.callbackUrl ? 'Delivery reports on' : 'Off'}</dd>
        </dl>
      ) : (
        <p className="text-sm text-muted">Texts are written to the log below instead of being sent. Add Twilio keys to send them (docs/twilio.md).</p>
      )}
      {check?.error && <p className="rounded-lg bg-late-soft px-3 py-2 text-sm text-late">Twilio: {check.error}</p>}
      {check?.warnings.map((w) => (
        <p key={w} className="rounded-lg bg-called-soft px-3 py-2 text-sm text-called">
          {w}
        </p>
      ))}
      <dl className="grid grid-cols-3 gap-2 text-center">
        {(check?.mode === 'live' ? (['delivered', 'sent', 'failed'] as Outcome[]) : (['logged', 'skipped', 'queued'] as Outcome[])).map((o) => (
          <div key={o} className="rounded-xl bg-surface p-2">
            <dd className={`tnum font-display text-3xl leading-none font-bold ${o === 'failed' && counts[o] ? 'text-late' : ''}`}>{counts[o]}</dd>
            <dt className="text-xs text-muted">{outcomeBadge[o][0]}</dt>
          </div>
        ))}
      </dl>
      {reasons.size > 0 && (
        <div className="text-sm">
          <p className="mb-1 font-medium">Why texts didn’t arrive</p>
          <ul className="flex flex-col gap-0.5 text-muted">
            {[...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, n]) => (
              <li key={reason}>
                <span className="tnum font-semibold text-text">{n}×</span> {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function Messages({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const modes = useLoad(
    () => fetch('/api/status', { method: 'POST' }).then((r) => r.json() as Promise<{ texts: 'live' | 'log'; email: 'live' | 'log' }>),
    [],
  );
  const twilio = useLoad(() => fetch('/api/twilio/check', { method: 'POST' }).then((r) => r.json() as Promise<TwilioCheck>), []);
  const { data, error, reload } = useLiveTournament(id, () => load(id));
  const [filter, setFilter] = useState<'all' | 'problems' | Outcome>('all');
  const [search, setSearch] = useState('');

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>Messages are for this tournament’s directors.</Empty>;

  const recipients: Recipient[] = [
    { scope: 'everyone', target: null, label: 'Everyone' },
    { scope: 'not_checked_in', target: null, label: 'Everyone not checked in yet' },
    ...data.events.map((e) => ({ scope: 'event' as const, target: e.id, label: e.name })),
  ];
  const testModes = [modes.data?.texts === 'log' ? 'texts' : '', modes.data?.email === 'log' ? 'emails' : ''].filter(Boolean);

  return (
    <div className="grid gap-6 lg:grid-cols-[24rem_1fr]">
      <aside className="flex flex-col gap-3">
        <Card className="p-5">
          <h2 className="mb-3 text-2xl">New message</h2>
          <MessageComposer tournamentId={id} recipients={recipients} onSent={reload} />
          <p className="mt-3 text-xs text-muted">
            For one team or player, use Team actions on the Players page. Texts only go to players who opted in.
          </p>
        </Card>
        {!data.tournament.texts_enabled && (
          <p className="rounded-xl bg-called-soft px-3 py-2 text-sm text-called">
            Texting is off for this tournament (Settings → Fees), so only emails go out.
          </p>
        )}
        <TextingHealth check={twilio.data} messages={data.messages} />
        {testModes.length > 0 && (
          <p className="rounded-xl bg-called-soft px-3 py-2 text-sm text-called">
            Test mode: {testModes.join(' and ')} are written to this log instead of being sent.
          </p>
        )}
      </aside>

      <section className="flex flex-col gap-2">
        <h2 className="text-2xl">Log</h2>
        <p className="text-sm text-muted">
          {data.messages.length} messages · {data.messages.filter((m) => m.channel === 'none').length} skipped (no phone,
          no email or no opt-in)
        </p>
        <div className="flex flex-wrap gap-2">
          <Input className="h-9 min-w-0 flex-1" placeholder="Search name, phone or text" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="flex gap-1 rounded-lg bg-surface-2 p-1 text-sm">
            {(
              [
                ['all', 'All'],
                ['problems', 'Problems'],
                ['delivered', 'Delivered'],
                ['logged', 'Test log'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`rounded-md px-2.5 py-1 font-medium ${filter === key ? 'bg-surface shadow-sm' : 'text-muted hover:text-text'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {data.messages.length === 0 ? (
          <Empty>No messages yet. Players get a text each time their match is called to a court.</Empty>
        ) : (
          data.messages
            .filter((m) => {
              const o = outcome(m);
              if (filter === 'problems' && o !== 'failed' && o !== 'skipped') return false;
              if (filter !== 'all' && filter !== 'problems' && o !== filter) return false;
              const q = search.trim().toLowerCase();
              return !q || [m.player_name, m.to_phone, m.to_email, m.body].some((v) => v?.toLowerCase().includes(q));
            })
            .map((m) => (
            <Card key={m.id} className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge>{m.via === 'email' ? 'Email' : 'Text'}</Badge>
                  <span className="font-medium">{m.player_name}</span>
                  <span className="tnum truncate text-sm text-muted">{m.via === 'email' ? m.to_email : m.to_phone}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">{formatTime(m.sent_at ?? m.created_at, data.tournament.time_zone)}</span>
                  <Status m={m} />
                </div>
              </div>
              {m.subject && <p className="mt-2 text-sm font-semibold">{m.subject}</p>}
              <p className="mt-2 rounded-2xl rounded-tl-sm bg-surface px-3 py-2 text-sm break-words">{m.body}</p>
              {m.error && <p className="mt-1 text-xs text-muted">{m.error}</p>}
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
