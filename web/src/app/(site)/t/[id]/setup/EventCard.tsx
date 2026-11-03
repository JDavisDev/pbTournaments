'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DivisionStatus, divisionState } from '@/components/DivisionStatus';
import { Icon } from '@/components/Icon';
import { Badge, Button, Card, ErrorText, Select, Textarea } from '@/components/ui';
import {
  addMockTeams,
  addTeamsFromText,
  clearMatches,
  copyEvent,
  deleteEvent,
  deleteTeam,
  mergeEvents,
  setTeamSeed,
  unmergeEvent,
} from '@/lib/api';
import { describeDivision } from '@/lib/eligibility';
import { courtsLabel, formatSummary, poolName, shortFormat, wasPlayed } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { CourtBoardRow, EventMerge, MatchDetails, Team, TournamentEvent } from '@/lib/types';
import { EventForm } from './EventForm';

/** A division in Setup: its summary and teams (seed order, paste more), or its form while editing. */
export function EventCard({
  event,
  timeZone,
  firstEventIncluded,
  simple,
  courts,
  teams,
  matches,
  isDemo,
  others,
  merges,
  onChanged,
}: {
  event: TournamentEvent;
  /** Divisions this one could merge into. */
  others: TournamentEvent[];
  /** Divisions merged into this one. */
  merges: EventMerge[];
  timeZone: string;
  firstEventIncluded: boolean;
  /** A simple tournament: no registrations, players page or emails. */
  simple: boolean;
  courts: CourtBoardRow[];
  teams: Team[];
  matches: MatchDetails[];
  /** A practice tournament: mock players can fill the division. */
  isDemo: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const { busy, error, run } = useAction();
  const scheduled = matches.length > 0;
  const played = matches.some((m) => m.status === 'completed' && wasPlayed(m));
  const nextSeed = Math.max(0, ...teams.map((t) => t.seed ?? 0)) + 1;
  const section = courts.filter((c) => event.court_ids.includes(c.court_id)).map((c) => c.court_name);

  if (editing) {
    return (
      <Card className="p-4">
        <EventForm
          tournamentId={event.tournament_id}
          timeZone={timeZone}
          courts={courts}
          firstEventIncluded={firstEventIncluded}
          simple={simple}
          event={event}
          scheduled={scheduled}
          onDone={() => (setEditing(false), onChanged())}
          onCancel={() => setEditing(false)}
        />
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xl">{event.name}</h3>
          <p className="text-sm">{describeDivision(event)}</p>
          <p className="text-sm text-muted">
            {formatSummary(event)} · {shortFormat(event)}
            {event.third_place_match ? ' · bronze match' : ''}
            {event.confirm_seeds ? ' · seeds reviewed' : ''} · {teams.length} teams
          </p>
          {section.length > 0 && <p className="text-sm font-medium">Plays on {courtsLabel(section)}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <DivisionStatus state={divisionState(event, matches)} startedAt={event.started_at} timeZone={timeZone} />
          {scheduled && <Badge>{matches.length} matches</Badge>}
          <Link
            href={`/t/${event.tournament_id}/events/${event.id}/guide`}
            className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium hover:bg-surface"
          >
            Player guide
          </Link>
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button size="sm" disabled={busy} onClick={() => run(() => copyEvent(event.id), onChanged)}>
            Copy division
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <h4 className="mb-2 text-sm font-medium">Teams (in seed order)</h4>
          {teams.length === 0 ? (
            <p className="text-sm text-muted">No teams yet.</p>
          ) : (
            <ol className="flex max-h-72 flex-col overflow-y-auto rounded-lg border border-border text-sm">
              {[...teams]
                .sort((a, b) => (a.seed ?? 999) - (b.seed ?? 999))
                .map((t, i, sorted) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5 last:border-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="tnum w-5 text-right text-xs text-muted">{t.seed}</span>
                      <span className="truncate">{t.name}</span>
                      {t.pool && <span className="text-xs text-muted">{poolName(t.pool)}</span>}
                    </span>
                    {!scheduled && (
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          aria-label={`Move ${t.name} up`}
                          title="Better seed"
                          className="text-muted hover:text-text disabled:opacity-30"
                          disabled={busy || i === 0}
                          onClick={() => run(() => setTeamSeed(t.id, i), onChanged)}
                        >
                          <Icon name="up" />
                        </button>
                        <button
                          aria-label={`Move ${t.name} down`}
                          title="Worse seed"
                          className="text-muted hover:text-text disabled:opacity-30"
                          disabled={busy || i === sorted.length - 1}
                          onClick={() => run(() => setTeamSeed(t.id, i + 2), onChanged)}
                        >
                          <Icon name="down" />
                        </button>
                        <button
                          className="text-xs text-muted hover:text-late"
                          disabled={busy}
                          onClick={() => run(() => deleteTeam(t.id), onChanged)}
                        >
                          Remove
                        </button>
                      </span>
                    )}
                  </li>
                ))}
            </ol>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">{scheduled ? 'Add alternates' : 'Add teams'}</h4>
          {scheduled && (
            <p className="text-xs text-muted">
              The schedule is built, so new teams aren’t in it. Put one in a pool from the division’s Teams tab
              {simple ? '.' : ', or swap one in for a dropped team on the Players page.'}
            </p>
          )}
          <Textarea
            rows={scheduled ? 3 : 6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              event.kind === 'singles'
                ? 'One player per line, best seed first:\nPat Davis\nJo Park'
                : 'One team per line, best seed first:\nPat Davis / Sam Lee\nJo Park / Ana Cho'
            }
          />
          <Button disabled={busy || !text.trim()} onClick={() => run(() => addTeamsFromText(event.id, text, nextSeed), () => (setText(''), onChanged()))}>
            {scheduled ? 'Add alternates' : 'Add teams'}
          </Button>
          {isDemo && !scheduled && (
            <Button variant="primary" disabled={busy} onClick={() => run(() => addMockTeams(event.id, 4), onChanged)}>
              Fill division with mock players
            </Button>
          )}
        </div>
      </div>

      <ErrorText>{error}</ErrorText>
      {merges.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1 text-sm">
          {merges.map((m) => (
            <li key={m.source_event_id} className="flex flex-wrap items-center gap-2">
              <span>
                <strong>{m.source_name}</strong> is merged in here.
              </span>
              {!scheduled && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    confirm(`Bring ${m.source_name} back as its own division?${simple ? '' : ' Its players are emailed.'}`) && run(() => unmergeEvent(m.source_event_id), onChanged)
                  }
                >
                  Unmerge
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!scheduled && others.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-sm font-medium">Too few teams?</span>
          <Select aria-label={`Merge ${event.name} into`} className="min-w-48" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
            <option value="">Merge into…</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            disabled={busy || !mergeInto}
            onClick={() => {
              const target = others.find((o) => o.id === mergeInto)?.name;
              if (confirm(`Merge ${event.name} into ${target}? Its ${teams.length} team${teams.length === 1 ? '' : 's'} move there${simple ? '' : ' and its players are emailed'}. You can unmerge until ${target} has a schedule.`)) {
                run(() => mergeEvents(event.id, mergeInto), onChanged);
              }
            }}
          >
            Merge
          </Button>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
        {!scheduled ? (
          <p className="text-sm text-muted">
            The schedule is built when the division starts, from the teams entered then.{' '}
            <Link href={`/t/${event.tournament_id}/events/${event.id}`} className="font-medium text-text underline">
              Preview it
            </Link>
          </p>
        ) : (
          <Button
            disabled={busy || played}
            title={played ? 'Matches have already been played' : undefined}
            onClick={() =>
              confirm('Delete this event’s schedule so you can change teams or format? Any match on court is called off.') &&
              run(() => clearMatches(event.id), onChanged)
            }
          >
            Clear schedule
          </Button>
        )}
        {!scheduled && merges.length === 0 && (
          <Button
            variant="ghost"
            className="ml-auto text-late"
            disabled={busy}
            onClick={() => confirm(`Delete ${event.name} and its teams?`) && run(() => deleteEvent(event.id), onChanged)}
          >
            Delete division
          </Button>
        )}
      </div>
    </Card>
  );
}
