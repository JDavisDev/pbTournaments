'use client';

// Teams and players during the day: fix names and contact details, swap a
// player, drop a team, put in an alternate, or message them.
import { use, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { Icon } from '@/components/Icon';
import { MessageComposer } from '@/components/MessageComposer';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Modal, Select, Spinner } from '@/components/ui';
import {
  checkInTeam,
  getDivisionEligibility,
  getTeamRoster,
  renameTeam,
  replaceTeam,
  substitutePlayer,
  updatePlayer,
  withdrawTeam,
} from '@/lib/api';
import { poolName } from '@/lib/format';
import { useAction, useLiveTournament, useStaffAccess } from '@/lib/hooks';
import type { EligibilityRow, RosterPlayer, TeamRosterRow } from '@/lib/types';

type Dialog =
  | { kind: 'team'; team: TeamRosterRow }
  | { kind: 'player'; team: TeamRosterRow; player: RosterPlayer }
  | null;

export function PlayersView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaffAccess(id);
  const { data, error, reload } = useLiveTournament(id, async () => {
    const [roster, eligibility] = await Promise.all([getTeamRoster(id), getDivisionEligibility(id)]);
    return { roster, eligibility };
  });
  const [search, setSearch] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data || staff.data === undefined) return <Spinner />;
  if (!staff.data) return <Empty>Players and teams are managed by this tournament’s directors.</Empty>;

  const query = search.trim().toLowerCase();
  const eligibility = new Map(data.eligibility.map((e) => [e.team_id, e]));
  const flagged = data.eligibility.filter((e) => e.problems.length > 0).length;
  const teams = data.roster.filter(
    (t) =>
      (!onlyProblems || (eligibility.get(t.team_id)?.problems.length ?? 0) > 0) &&
      (!query || `${t.name} ${t.players.map((p) => `${p.first_name} ${p.last_name} ${p.dupr_id ?? ''}`).join(' ')}`.toLowerCase().includes(query)),
  );
  const events = [...new Map(teams.map((t) => [t.event_id, t.event_name])).entries()];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="h-12 min-w-0 flex-1 text-lg"
          placeholder="Search a team, player or DUPR ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button variant={onlyProblems ? 'primary' : 'secondary'} onClick={() => setOnlyProblems(!onlyProblems)}>
          {flagged ? `${flagged} team${flagged === 1 ? '' : 's'} to check` : 'All teams eligible'}
        </Button>
      </div>
      {events.length === 0 && <Empty>No teams{query ? ' match' : ' yet'}.</Empty>}
      {events.map(([eventId, eventName]) => (
        <section key={eventId}>
          <h2 className="mb-3 text-3xl">{eventName}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {teams
              .filter((t) => t.event_id === eventId)
              .map((t) => (
                <TeamCard
                  key={t.team_id}
                  team={t}
                  eligibility={eligibility.get(t.team_id)}
                  onTeam={() => setDialog({ kind: 'team', team: t })}
                  onPlayer={(p) => setDialog({ kind: 'player', team: t, player: p })}
                />
              ))}
          </div>
        </section>
      ))}

      <Modal open={dialog?.kind === 'team'} onClose={() => setDialog(null)} title={dialog?.team.name ?? ''}>
        {dialog?.kind === 'team' && (
          <TeamActions
            key={dialog.team.team_id}
            tournamentId={id}
            team={dialog.team}
            alternates={data.roster.filter(
              (t) => t.event_id === dialog.team.event_id && t.match_count === 0 && !t.withdrawn_at && t.team_id !== dialog.team.team_id,
            )}
            onDone={() => (setDialog(null), reload())}
          />
        )}
      </Modal>
      <Modal
        open={dialog?.kind === 'player'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'player' ? `${dialog.player.first_name} ${dialog.player.last_name}` : ''}
      >
        {dialog?.kind === 'player' && (
          <PlayerActions
            key={dialog.player.player_id}
            tournamentId={id}
            team={dialog.team}
            player={dialog.player}
            onDone={() => (setDialog(null), reload())}
          />
        )}
      </Modal>
    </div>
  );
}

function TeamCard({
  team,
  eligibility,
  onTeam,
  onPlayer,
}: {
  team: TeamRosterRow;
  eligibility?: EligibilityRow;
  onTeam: () => void;
  onPlayer: (p: RosterPlayer) => void;
}) {
  const dropped = !!team.withdrawn_at;
  return (
    <Card className={`p-4 ${dropped ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className={`truncate text-2xl ${dropped ? 'line-through' : ''}`}>{team.name}</h3>
          <p className="text-sm text-muted">
            {[team.seed ? `Seed ${team.seed}` : '', poolName(team.pool), team.match_count ? `${team.match_count} matches` : 'Not scheduled (alternate)']
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {dropped ? <Badge tone="late">Dropped</Badge> : team.checked_in_at ? <Badge tone="live">Here</Badge> : <Badge>Not here</Badge>}
      </div>
      <ul className="mt-3 flex flex-col gap-1">
        {team.players.map((p) => (
          <li key={p.player_id}>
            <button onClick={() => onPlayer(p)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.checked_in ? 'bg-live' : 'bg-border'}`} title={p.checked_in ? 'Here' : 'Not here'} />
              <span className="font-medium">
                {p.first_name} {p.last_name}
              </span>
              <span className="truncate text-sm text-muted">{p.phone ?? p.email ?? 'no contact'}</span>
              <span className="ml-auto shrink-0 text-right text-sm">
                {p.dupr_doubles != null ? (
                  <span className="tnum font-semibold" title={p.rating_checked_at ? 'Rating confirmed' : 'Rating not confirmed yet'}>
                    {Number(p.dupr_doubles).toFixed(2)}
                    {p.rating_checked_at && <Icon name="check" className="ml-1 inline h-4 w-4 text-live" />}
                  </span>
                ) : p.self_rating != null ? (
                  <span className="tnum text-muted" title="Self-rating">
                    {Number(p.self_rating).toFixed(1)} self
                  </span>
                ) : null}
                <span className="block font-mono text-xs text-muted">{p.dupr_id ?? 'no DUPR ID'}</span>
              </span>
            </button>
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
      {!dropped && (
        <Button size="sm" className="mt-3" onClick={onTeam}>
          Team actions
        </Button>
      )}
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
          <Button disabled={busy || !name.trim() || name === team.name} onClick={() => run(() => renameTeam(team.team_id, name.trim()), onDone)}>
            Save
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg">Check-in</h3>
        <Button
          disabled={busy}
          onClick={() => run(() => checkInTeam(team.team_id, !team.checked_in_at), onDone)}
        >
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
              No alternates in this event. Add a team in Setup (it stays unscheduled) to use it here.
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

function PlayerActions({
  tournamentId,
  team,
  player,
  onDone,
}: {
  tournamentId: string;
  team: TeamRosterRow;
  player: RosterPlayer;
  onDone: () => void;
}) {
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
  const [sub, setSub] = useState({ first_name: '', last_name: '', phone: '', email: '' });
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
