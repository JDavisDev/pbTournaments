'use client';

// Everyone in the tournament, one row per player: their profile, their
// registration and money, and their teams. Fix names and contact details,
// swap a player, drop a team, put in an alternate, or message them.
import Link from 'next/link';
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Icon } from '@/components/Icon';
import { MessageComposer } from '@/components/MessageComposer';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Modal, Select, Spinner } from '@/components/ui';
import {
  checkInTeam,
  getDivisionEligibility,
  getEvents,
  getMoney,
  getRegistrationAnswers,
  getRegistrationQuestions,
  getRegistrations,
  getTeamRoster,
  getTournament,
  renameTeam,
  replaceTeam,
  substitutePlayer,
  updatePlayer,
  withdrawTeam,
} from '@/lib/api';
import { poolName } from '@/lib/format';
import { useAction, useLiveTournament, useStaffAccess } from '@/lib/hooks';
import type { EligibilityRow, RegistrationRow, RosterPlayer, TeamRosterRow, WithdrawalRow } from '@/lib/types';
import { AnswerCounts, RegistrationTotals, Unpaired, Waitlist } from './RegistrationCards';
import { BalanceBadge, RegistrantDetails, type Registrant } from './RegistrantDetails';

const statusTone = { paid: 'live', pending: 'called', cancelled: 'neutral', refunded: 'neutral', waitlisted: 'info' } as const;

async function load(id: string) {
  const [tournament, events, roster, eligibility, registrations, money, questions, answers] = await Promise.all([
    getTournament(id),
    getEvents(id),
    getTeamRoster(id),
    getDivisionEligibility(id),
    getRegistrations(id),
    getMoney(id),
    getRegistrationQuestions(id),
    getRegistrationAnswers(id),
  ]);
  return { tournament, events, roster, eligibility, registrations, money, questions, answers };
}

/** One player: their profile (from a team when they're on one), teams and registration entries. */
interface Person {
  playerId: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  profile: RosterPlayer | null;
  teams: TeamRosterRow[];
  entries: RegistrationRow[];
  withdrawals: WithdrawalRow[];
}

type Sheet = 'profile' | 'registration' | 'teams';

export function PlayersView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, () => load(id));
  // ?q= comes from a division's Teams list ("Manage").
  const [search, setSearch] = useState(() =>
    typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get('q') ?? ''),
  );
  const [division, setDivision] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [open, setOpen] = useState<{ playerId: string; sheet: Sheet } | null>(null);

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>Players and teams are managed by this tournament’s directors.</Empty>;

  const people = new Map<string, Person>();
  const person = (
    playerId: string,
    who: { first_name: string; last_name: string; email: string | null; phone: string | null },
  ) => {
    let p = people.get(playerId);
    if (!p) {
      p = { playerId, ...who, profile: null, teams: [], entries: [], withdrawals: [] };
      people.set(playerId, p);
    }
    return p;
  };
  for (const team of data.roster) {
    for (const player of team.players) {
      const p = person(player.player_id, player);
      p.profile ??= player;
      p.teams.push(team);
    }
  }
  for (const r of data.registrations) person(r.player_id, r).entries.push(r);
  for (const w of data.money.withdrawals) person(w.player_id, w).withdrawals.push(w);

  const eligibility = new Map(data.eligibility.map((e) => [e.team_id, e]));
  const problemsOf = (p: Person) => p.teams.flatMap((t) => eligibility.get(t.team_id)?.problems ?? []);
  const flagged = [...people.values()].filter((p) => problemsOf(p).length > 0).length;
  const balanceOf = (playerId: string) => data.money.balances.find((b) => b.player_id === playerId) ?? null;
  const query = search.trim().toLowerCase();
  const list = [...people.values()]
    .filter((p) => !division || p.teams.some((t) => t.event_id === division) || p.entries.some((e) => e.event_id === division))
    .filter((p) => !onlyProblems || problemsOf(p).length > 0)
    .filter(
      (p) =>
        !query ||
        [p.first_name, p.last_name, p.email, p.phone, p.profile?.dupr_id, ...p.teams.map((t) => t.name)]
          .join(' ')
          .toLowerCase()
          .includes(query),
    )
    .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));

  const registrant = (p: Person): Registrant | null => {
    const who = p.entries[0] ?? p.withdrawals[0];
    if (!who) return null;
    const registrationIds = new Set([...p.entries.map((e) => e.registration_id), ...p.withdrawals.map((w) => w.registration_id)]);
    return {
      playerId: p.playerId,
      answers: data.questions.flatMap((q) => {
        const a = data.answers.find((x) => x.question_id === q.id && registrationIds.has(x.registration_id));
        return a ? [{ label: q.label, answer: a.answer }] : [];
      }),
      name: `${who.first_name} ${who.last_name}`,
      email: who.email,
      phone: who.phone,
      entries: p.entries,
      withdrawals: p.withdrawals,
      ledger: data.money.ledger.filter((l) => l.player_id === p.playerId),
      balance: balanceOf(p.playerId),
    };
  };
  const selected = open ? people.get(open.playerId) : undefined;
  const done = () => reload();

  return (
    <div className="flex flex-col gap-6">
      {data.registrations.length > 0 && <RegistrationTotals rows={data.registrations} balances={data.money.balances} />}
      <Waitlist rows={data.registrations} events={data.events} onChanged={reload} />
      <Unpaired rows={data.registrations} events={data.events} onChanged={reload} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-12 min-w-0 flex-1 basis-60 text-lg"
            placeholder="Search a name, team or DUPR ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            className="h-12 min-w-0 flex-1 basis-40"
            aria-label="Division"
            value={division}
            onChange={(e) => setDivision(e.target.value)}
          >
            <option value="">All divisions</option>
            {data.events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
          <Button variant={onlyProblems ? 'primary' : 'secondary'} onClick={() => setOnlyProblems(!onlyProblems)}>
            {flagged ? `${flagged} to check` : 'All eligible'}
          </Button>
        </div>
        <p className="text-sm text-muted">
          {list.length} player{list.length === 1 ? '' : 's'}
          {query || division || onlyProblems ? ` (of ${people.size})` : ''}
        </p>
        {list.length === 0 ? (
          <Empty>
            {people.size === 0 ? 'No players yet. Share the Register link once registration is open.' : 'No one matches.'}
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
            {list.map((p) => (
              <PersonRow
                key={p.playerId}
                person={p}
                problems={problemsOf(p)}
                balance={<BalanceBadge balance={balanceOf(p.playerId)} />}
                onOpen={() => setOpen({ playerId: p.playerId, sheet: 'profile' })}
              />
            ))}
          </ul>
        )}
      </section>

      <AnswerCounts
        questions={data.questions}
        answers={data.answers}
        live={new Set(data.registrations.map((r) => r.registration_id))}
      />

      <Modal
        open={!!selected}
        onClose={() => setOpen(null)}
        title={selected ? `${selected.first_name} ${selected.last_name}` : ''}
      >
        {selected && open && (
          <PersonSheet
            key={selected.playerId}
            tournamentId={id}
            person={selected}
            sheet={open.sheet}
            onSheet={(sheet) => setOpen({ ...open, sheet })}
            registration={
              registrant(selected) && (
                <RegistrantDetails
                  who={registrant(selected)!}
                  tournament={data.tournament}
                  events={data.events}
                  onChanged={reload}
                />
              )
            }
            eligibility={eligibility}
            alternatesFor={(team) =>
              data.roster.filter(
                (t) => t.event_id === team.event_id && t.match_count === 0 && !t.withdrawn_at && t.team_id !== team.team_id,
              )
            }
            onDone={done}
          />
        )}
      </Modal>
    </div>
  );
}

function PersonRow({
  person: p,
  problems,
  balance,
  onOpen,
}: {
  person: Person;
  problems: string[];
  balance: React.ReactNode;
  onOpen: () => void;
}) {
  const status = p.entries[0]?.status;
  const here = p.profile?.checked_in;
  const rating = p.profile?.dupr_doubles ?? p.entries[0]?.dupr_doubles;
  // One line per division: the team they're on, or where their entry stands.
  const divisions = [
    ...p.teams.map((t) => ({
      key: t.team_id,
      event: t.event_name,
      text: t.withdrawn_at ? `${t.name} (dropped)` : t.name,
      tone: '',
    })),
    ...p.entries
      .filter((e) => !p.teams.some((t) => t.event_id === e.event_id))
      .map((e) => ({
        key: `${e.registration_id}:${e.event_id}`,
        event: e.event_name,
        text: e.waitlisted ? 'on the waitlist' : e.status !== 'paid' ? 'checkout not finished' : 'waiting for a partner',
        tone: 'text-called',
      })),
  ];
  return (
    <li>
      <button onClick={onOpen} className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-surface-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-semibold">
            {p.first_name} {p.last_name}
          </span>
          {p.teams.length > 0 && (here ? <Badge tone="live">Here</Badge> : <Badge>Not here</Badge>)}
          {status && status !== 'paid' && <Badge tone={statusTone[status]}>{status}</Badge>}
          {!status && p.withdrawals.length > 0 && <Badge>withdrawn</Badge>}
          {balance}
          {problems.length > 0 && <Badge tone="late">Check eligibility</Badge>}
        </span>
        <span className="truncate text-sm text-muted">
          {[
            p.phone,
            p.email,
            rating != null ? `DUPR ${Number(rating).toFixed(2)}` : '',
            p.profile ? (p.profile.dupr_id ?? 'no DUPR ID') : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {divisions.map((d) => (
          <span key={d.key} className="text-sm">
            {d.event}: <span className={d.tone || 'text-accent'}>{d.text}</span>
          </span>
        ))}
      </button>
    </li>
  );
}

/** A player's sheet: profile, registration and money, and their teams. */
function PersonSheet({
  tournamentId,
  person,
  sheet,
  onSheet,
  registration,
  eligibility,
  alternatesFor,
  onDone,
}: {
  tournamentId: string;
  person: Person;
  sheet: Sheet;
  onSheet: (sheet: Sheet) => void;
  registration: React.ReactNode;
  eligibility: Map<string, EligibilityRow>;
  alternatesFor: (team: TeamRosterRow) => TeamRosterRow[];
  onDone: () => void;
}) {
  const [teamId, setTeamId] = useState(person.teams[0]?.team_id ?? '');
  const team = person.teams.find((t) => t.team_id === teamId);
  const tabs: [Sheet, string][] = [
    ['profile', 'Profile'],
    ...(registration ? ([['registration', 'Registration']] as [Sheet, string][]) : []),
    ...(person.teams.length
      ? ([['teams', person.teams.length === 1 ? 'Team' : `Teams ${person.teams.length}`]] as [Sheet, string][])
      : []),
  ];
  const profile: RosterPlayer = person.profile ?? {
    player_id: person.playerId,
    first_name: person.first_name,
    last_name: person.last_name,
    phone: person.phone,
    email: person.email,
    sms_opt_in: person.entries[0]?.sms_opt_in ?? false,
    checked_in: false,
    dupr_id: null,
    dupr_doubles: person.entries[0]?.dupr_doubles != null ? Number(person.entries[0].dupr_doubles) : null,
    dupr_singles: person.entries[0]?.dupr_singles != null ? Number(person.entries[0].dupr_singles) : null,
    self_rating: person.entries[0]?.self_rating != null ? Number(person.entries[0].self_rating) : null,
    rating_checked_at: null,
  };

  return (
    <div className="flex flex-col gap-5">
      {tabs.length > 1 && (
        <div className="flex gap-1 rounded-lg bg-surface-2 p-1" role="tablist">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={sheet === key}
              onClick={() => onSheet(key)}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap ${
                sheet === key ? 'bg-surface shadow-sm' : 'text-muted hover:text-text'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {sheet === 'profile' && <PlayerProfile tournamentId={tournamentId} player={profile} onDone={onDone} />}
      {sheet === 'registration' && registration}
      {sheet === 'teams' && team && (
        <div className="flex flex-col gap-5">
          {person.teams.length > 1 && (
            <Select aria-label="Team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {person.teams.map((t) => (
                <option key={t.team_id} value={t.team_id}>
                  {t.event_name}: {t.name}
                </option>
              ))}
            </Select>
          )}
          <TeamSummary team={team} eligibility={eligibility.get(team.team_id)} />
          {!team.withdrawn_at && (
            <>
              <TeamActions
                key={team.team_id}
                tournamentId={tournamentId}
                team={team}
                alternates={alternatesFor(team)}
                onDone={onDone}
              />
              <Substitute key={`sub-${team.team_id}`} team={team} player={profile} onDone={onDone} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TeamSummary({ team, eligibility }: { team: TeamRosterRow; eligibility?: EligibilityRow }) {
  const dropped = !!team.withdrawn_at;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-muted">{team.event_name}</p>
          <h3 className={`truncate text-2xl ${dropped ? 'line-through' : ''}`}>{team.name}</h3>
          <p className="text-sm text-muted">
            {[
              team.seed ? `Seed ${team.seed}` : '',
              poolName(team.pool),
              team.match_count ? `${team.match_count} matches` : 'Not scheduled (alternate)',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {dropped ? (
          <Badge tone="late">Dropped</Badge>
        ) : team.checked_in_at ? (
          <Badge tone="live">Here</Badge>
        ) : (
          <Badge>Not here</Badge>
        )}
      </div>
      <ul className="mt-3 flex flex-col gap-1">
        {team.players.map((p) => (
          <li key={p.player_id} className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.checked_in ? 'bg-live' : 'bg-border'}`}
              title={p.checked_in ? 'Here' : 'Not here'}
            />
            <span className="font-medium">
              {p.first_name} {p.last_name}
            </span>
            <span className="ml-auto shrink-0 text-right text-sm">
              {p.dupr_doubles != null ? (
                <span
                  className="tnum font-semibold"
                  title={p.rating_checked_at ? 'Rating confirmed' : 'Rating not confirmed yet'}
                >
                  {Number(p.dupr_doubles).toFixed(2)}
                  {p.rating_checked_at && <Icon name="check" className="ml-1 inline h-4 w-4 text-live" />}
                </span>
              ) : p.self_rating != null ? (
                <span className="tnum text-muted">{Number(p.self_rating).toFixed(1)} self</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {eligibility && eligibility.problems.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 rounded-lg bg-late-soft px-3 py-2 text-sm text-late">
          {eligibility.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {/* For questions about the division when the player doesn't know which one they're in. */}
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-sm">
        <Link href={`/t/${team.tournament_id}/events/${team.event_id}`} className="inline-flex min-h-10 items-center gap-1 font-medium underline">
          {team.event_name} <Icon name="arrow" className="h-4 w-4" />
        </Link>
        <Link href={`/t/${team.tournament_id}/teams/${team.team_id}`} className="inline-flex min-h-10 items-center gap-1 font-medium underline">
          Team’s matches <Icon name="arrow" className="h-4 w-4" />
        </Link>
      </div>
    </Card>
  );
}

function TeamActions({
  tournamentId,
  team,
  alternates,
  onDone,
}: {
  tournamentId: string;
  team: TeamRosterRow;
  alternates: TeamRosterRow[];
  onDone: () => void;
}) {
  const [name, setName] = useState(team.name);
  const [alternate, setAlternate] = useState('');
  const { busy, error, run } = useAction();

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Rename</h3>
        <div className="flex gap-2">
          <Input className="flex-1" value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            disabled={busy || !name.trim() || name === team.name}
            onClick={() => run(() => renameTeam(team.team_id, name.trim()), onDone)}
          >
            Save
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Check-in</h3>
        <Button disabled={busy} onClick={() => run(() => checkInTeam(team.team_id, !team.checked_in_at), onDone)}>
          {team.checked_in_at ? 'Mark the whole team not here' : 'Check in both players'}
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Message this team</h3>
        <MessageComposer tournamentId={tournamentId} recipients={[{ scope: 'team', target: team.team_id, label: team.name }]} />
      </section>

      {team.match_count > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-lg">Put an alternate in their place</h3>
          {alternates.length === 0 ? (
            <p className="text-sm text-muted">
              No alternates in this event. Add a team in Settings (it stays unscheduled) to use it here.
            </p>
          ) : (
            <div className="flex gap-2">
              <Select className="flex-1" value={alternate} onChange={(e) => setAlternate(e.target.value)}>
                <option value="">Choose an alternate…</option>
                {alternates.map((a) => (
                  <option key={a.team_id} value={a.team_id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              <Button
                disabled={busy || !alternate}
                onClick={() =>
                  confirm(`${team.name} will be dropped and the alternate takes over their remaining matches.`) &&
                  run(() => replaceTeam(team.team_id, alternate), onDone)
                }
              >
                Swap in
              </Button>
            </div>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Drop this team</h3>
        <p className="text-sm text-muted">Their remaining matches are forfeited and opponents move on. This can’t be undone.</p>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => confirm(`Drop ${team.name} from the tournament?`) && run(() => withdrawTeam(team.team_id), onDone)}
        >
          Drop {team.name}
        </Button>
      </section>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function PlayerProfile({ tournamentId, player, onDone }: { tournamentId: string; player: RosterPlayer; onDone: () => void }) {
  const [edit, setEdit] = useState({
    first_name: player.first_name,
    last_name: player.last_name,
    phone: player.phone ?? '',
    email: player.email ?? '',
    sms_opt_in: player.sms_opt_in,
    dupr_id: player.dupr_id ?? '',
    dupr_doubles: player.dupr_doubles != null ? String(Number(player.dupr_doubles)) : '',
    dupr_singles: player.dupr_singles != null ? String(Number(player.dupr_singles)) : '',
    confirmed: !!player.rating_checked_at,
  });
  const { busy, error, run } = useAction();

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h3 className="text-lg">Details</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input value={edit.first_name} onChange={(e) => setEdit({ ...edit, first_name: e.target.value })} />
          </Field>
          <Field label="Last name">
            <Input value={edit.last_name} onChange={(e) => setEdit({ ...edit, last_name: e.target.value })} />
          </Field>
          <Field label="Mobile">
            <Input type="tel" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
          </Field>
          <Field label="DUPR ID">
            <Input
              className="font-mono"
              autoCapitalize="characters"
              placeholder="e.g. 7K2QXW"
              value={edit.dupr_id}
              onChange={(e) => setEdit({ ...edit, dupr_id: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="DUPR doubles">
            <Input
              type="number"
              step="0.001"
              inputMode="decimal"
              value={edit.dupr_doubles}
              onChange={(e) => setEdit({ ...edit, dupr_doubles: e.target.value, confirmed: true })}
            />
          </Field>
          <Field label="DUPR singles">
            <Input
              type="number"
              step="0.001"
              inputMode="decimal"
              value={edit.dupr_singles}
              onChange={(e) => setEdit({ ...edit, dupr_singles: e.target.value, confirmed: true })}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[var(--accent)]"
            checked={edit.confirmed}
            onChange={(e) => setEdit({ ...edit, confirmed: e.target.checked })}
          />
          I checked these ratings on DUPR
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[var(--accent)]"
            checked={edit.sms_opt_in}
            onChange={(e) => setEdit({ ...edit, sms_opt_in: e.target.checked })}
          />
          Wants texts
        </label>
        <Button
          disabled={busy}
          onClick={() =>
            run(
              () =>
                updatePlayer(player.player_id, {
                  first_name: edit.first_name,
                  last_name: edit.last_name,
                  sms_opt_in: edit.sms_opt_in,
                  phone: edit.phone || null,
                  email: edit.email || null,
                  dupr_id: edit.dupr_id.trim() || null,
                  dupr_doubles: edit.dupr_doubles === '' ? null : Number(edit.dupr_doubles),
                  dupr_singles: edit.dupr_singles === '' ? null : Number(edit.dupr_singles),
                  rating_checked_at: edit.confirmed ? (player.rating_checked_at ?? new Date().toISOString()) : null,
                }),
              onDone,
            )
          }
        >
          Save details
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Message {player.first_name}</h3>
        <MessageComposer
          tournamentId={tournamentId}
          recipients={[{ scope: 'player', target: player.player_id, label: `${player.first_name} ${player.last_name}` }]}
        />
      </section>

      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** Someone else plays for this player on the team from now on. */
function Substitute({ team, player, onDone }: { team: TeamRosterRow; player: RosterPlayer; onDone: () => void }) {
  const [sub, setSub] = useState({ first_name: '', last_name: '', phone: '', email: '' });
  const { busy, error, run } = useAction();
  return (
    <div className="flex flex-col gap-2">
      <section className="flex flex-col gap-3">
        <h3 className="text-lg">Substitute</h3>
        <p className="text-sm text-muted">
          Someone else plays for {player.first_name} on {team.name} from now on. They’ll need to check in.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input value={sub.first_name} onChange={(e) => setSub({ ...sub, first_name: e.target.value })} />
          </Field>
          <Field label="Last name">
            <Input value={sub.last_name} onChange={(e) => setSub({ ...sub, last_name: e.target.value })} />
          </Field>
          <Field label="Mobile (optional)">
            <Input type="tel" value={sub.phone} onChange={(e) => setSub({ ...sub, phone: e.target.value })} />
          </Field>
          <Field label="Email (optional)">
            <Input type="email" value={sub.email} onChange={(e) => setSub({ ...sub, email: e.target.value })} />
          </Field>
        </div>
        <Button
          variant="primary"
          disabled={busy || !sub.last_name.trim()}
          onClick={() => run(() => substitutePlayer(team.team_id, player.player_id, sub), onDone)}
        >
          Substitute {player.first_name}
        </Button>
      </section>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
