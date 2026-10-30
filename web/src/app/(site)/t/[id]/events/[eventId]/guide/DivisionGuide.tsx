'use client';

// A division's player guide: how it runs, before it starts. Format, scoring,
// standings, the bracket, check-in and match day, the director's notes, and
// (from a team's page, ?team=) that team's pool and opponents. Linked only
// from its teams' pages and Setup, so it's what its own players see; it trims
// the morning announcements to what's new.
import Link from 'next/link';
import { use, type ReactNode } from 'react';
import { Linked } from '@/components/Announcement';
import { ConnectNotice } from '@/components/ConnectNotice';
import { dayHeading } from '@/components/DivisionStatus';
import { Empty, Spinner } from '@/components/ui';
import { getEvents, getMatches, getTeams, getTournament } from '@/lib/api';
import { advanceRule, bracketSeeds, formatTime, isPlayable, poolName, toZonedInput } from '@/lib/format';
import { useLiveTournament } from '@/lib/hooks';
import { previewSchedule } from '@/lib/preview';
import { describeRules } from '@/lib/scoring';
import type { MatchDetails, RoundKey, Team, Tournament, TournamentEvent } from '@/lib/types';

async function load(id: string) {
  const [tournament, events, teams, matches] = await Promise.all([getTournament(id), getEvents(id), getTeams(id), getMatches(id)]);
  return { tournament, events, teams, matches };
}

export function DivisionGuide({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; eventId: string }>;
  searchParams: Promise<{ team?: string | string[] }>;
}) {
  const { id, eventId } = use(params);
  const teamParam = use(searchParams).team;
  const { data, error } = useLiveTournament(id, () => load(id), 60_000);

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Spinner />;
  const t = data.tournament;
  const e = data.events.find((x) => x.id === eventId);
  if (!e) return <Empty>Division not found.</Empty>;
  const teams = data.teams.filter((x) => x.event_id === e.id && !x.withdrawn_at);
  const team = teams.find((x) => x.id === (Array.isArray(teamParam) ? teamParam[0] : teamParam));
  const matches = data.matches.filter((m) => m.event_id === e.id);

  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-10">
      <header>
        <p className="font-semibold text-muted">Before you play</p>
        <h2 className="text-4xl">{e.name}</h2>
        <p className="mt-1 text-lg text-muted">
          How your division runs, so the morning announcements can stay short.
          {team && (
            <>
              {' '}
              <Link href={`/t/${id}/teams/${team.id}`} className="font-medium text-text underline">
                Back to {team.name}
              </Link>
            </>
          )}
        </p>
      </header>

      <Section title="When">
        <Item>{startLine(e, t)}</Item>
        <Item>Check in at the desk when you arrive. Your division can start before every team is here.</Item>
        {t.checkin_grace_minutes !== null && (
          <Item>
            Once it starts, a team that isn’t checked in has {t.checkin_grace_minutes} minutes to check in, or it forfeits its
            matches until it does. A team that isn’t here sits out round 1 when there’s a sit-out.
          </Item>
        )}
        <Item>
          When your match is called, go straight to the court: after {t.no_show_minutes} minutes the desk is told you haven’t
          arrived.
        </Item>
      </Section>

      <Section title="Format">
        {formatItems(e, teams.length).map((line, i) => (
          <Item key={i}>{line}</Item>
        ))}
      </Section>

      {team && <YourTeam event={e} team={team} teams={teams} matches={matches} />}

      <Section title="On match day">
        <Item>You’ll get a text when your match is called, with your court. Your team page shows where you are in line.</Item>
        <Item>Play your match, then enter the score from the link in your text or on your team page. That frees the court for the next match.</Item>
        <Item>If you need to leave or can’t play on, tell the desk: they can drop a team or bring in an alternate.</Item>
      </Section>

      {e.player_notes?.trim() && (
        <Section title="From the director">
          <p className="text-lg whitespace-pre-wrap">
            <Linked text={e.player_notes} />
          </p>
        </Section>
      )}

      {t.details?.trim() && (
        <Section title="About the tournament">
          <p className="whitespace-pre-wrap">
            <Linked text={t.details} />
          </p>
        </Section>
      )}
    </article>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-6">
      <h3 className="text-2xl">{title}</h3>
      <ul className="flex flex-col gap-2 text-lg">{children}</ul>
    </section>
  );
}

function Item({ children }: { children: ReactNode }) {
  return <li className="relative pl-5 before:absolute before:top-3 before:left-0 before:h-1.5 before:w-1.5 before:rounded-full before:bg-text">{children}</li>;
}

function startLine(e: TournamentEvent, t: Tournament) {
  if (e.started_at) return `Started at ${formatTime(e.started_at, t.time_zone)}.`;
  if (e.not_before && t.times_published_at) {
    return `Starts ${dayHeading(toZonedInput(e.not_before, t.time_zone).slice(0, 10))} at ${formatTime(e.not_before, t.time_zone)}.`;
  }
  return 'The start time will be posted here and on the tournament page.';
}

/** "Timeouts: 2 per team per game, 1 minute each." */
function timeouts(e: TournamentEvent) {
  if (e.timeouts_per_game === 0) return 'No timeouts.';
  return `Timeouts: ${e.timeouts_per_game} per team per game, ${e.timeout_minutes} minute${e.timeout_minutes === 1 ? '' : 's'} each.`;
}

/** A bracket round's format: its own, else the bracket's, else pool play's. */
function roundRules(e: TournamentEvent, key: RoundKey) {
  const f = e.round_formats.find((r) => r.key === key);
  return describeRules({
    gamesTo: f?.games_to ?? e.playoff_games_to ?? e.games_to,
    bestOf: f?.best_of ?? e.playoff_best_of ?? e.best_of,
    cap: f?.point_cap ?? e.playoff_point_cap ?? e.point_cap,
  }).toLowerCase();
}

/** The division's format in plain words, a line per step. */
function formatItems(e: TournamentEvent, teamCount: number): string[] {
  const lines: string[] = [];
  const poolRules = describeRules({ gamesTo: e.games_to, bestOf: e.best_of, cap: e.point_cap });
  const swiss = e.pool_play === 'swiss';
  const pools = Math.max(1, e.pool_count);

  if (e.format !== 'single_elim') {
    if (swiss) {
      lines.push(
        `Pool play is ${e.max_rounds ?? 'a few'} Swiss rounds: each round pairs teams with similar records who haven’t played each other yet.`,
      );
    } else {
      // The biggest pool's round robin; with uneven pools, some play one fewer.
      const each = teamCount >= 2 * pools ? Math.ceil(teamCount / pools) - 1 : null;
      const split = pools === 1 ? 'Everyone plays in one pool' : `Teams are split into ${pools} pools by seed`;
      lines.push(
        e.max_rounds
          ? `${split}, and you play ${e.max_rounds} matches against teams in your pool.`
          : `${split}, and you play everyone in your pool${
              each ? ` (${teamCount % pools ? 'about ' : ''}${each} match${each === 1 ? '' : 'es'})` : ''
            }.`,
      );
    }
    lines.push(`Pool matches: ${poolRules.toLowerCase()}.`);
    lines.push(timeouts(e));
    lines.push('Standings: win percentage, then head-to-head among tied teams, then point differential.');
  }

  if (e.format === 'round_robin') {
    lines.push(swiss ? 'Final places come from the standings after the last round.' : 'Final places come from the pool standings.');
    return lines;
  }

  if (e.format === 'single_elim') lines.push('A bracket by seed from the start.', timeouts(e));
  else if (e.bracket_type === 'medal') {
    lines.push(
      pools === 2
        ? 'Then the medal matches: the two pool winners play for gold, the runners-up for bronze.'
        : 'Then the medal matches: the top two play for gold, the next two for bronze.',
    );
  } else lines.push(`Then the bracket: ${advanceRule(pools, bracketSeeds(e)).replace(/^./, (c) => c.toLowerCase())}`);

  if (e.bracket_type === 'double') {
    lines.push(`Double elimination: you’re out after two losses. Bracket matches: ${roundRules(e, 'winners')}.`);
    lines.push(
      `The grand final${e.grand_final_reset ? ' (played again if the team from the losers’ side wins it)' : ''}: ${roundRules(e, 'grand_final')}.`,
    );
  } else if (e.bracket_type === 'single') {
    lines.push(`Single elimination: one loss and you’re out. Bracket matches: ${roundRules(e, 'earlier')}.`);
    lines.push(`The gold match: ${roundRules(e, 'final')}.`);
    if (e.third_place_match) lines.push(`Semifinal losers play for bronze: ${roundRules(e, 'bronze')}.`);
  } else {
    lines.push(`Gold: ${roundRules(e, 'final')}. Bronze: ${roundRules(e, 'bronze')}.`);
  }
  if (e.format === 'pools_to_bracket') lines.push('When pool play ends, the director checks the results before the bracket starts.');
  else if (e.confirm_seeds) lines.push('The director reviews the bracket seeds before it starts.');
  return lines;
}

/** This team's pool, seed and opponents: the real schedule once built, else what it would be now. */
function YourTeam({ event, team, teams, matches }: { event: TournamentEvent; team: Team; teams: Team[]; matches: MatchDetails[] }) {
  const built = matches.length > 0;
  // Only worth saying with more than one pool.
  const pools = event.format !== 'single_elim' && event.pool_play !== 'swiss' && event.pool_count > 1;
  let pool: number | null = pools ? team.pool : null;
  let rounds: { round: number; opponent: string | null }[] = [];

  if (built) {
    const mine = matches.filter((m) => m.stage === 'pool' && isPlayable(m) && (m.team1_id === team.id || m.team2_id === team.id));
    rounds = mine
      .sort((a, b) => a.round - b.round)
      .map((m) => ({ round: m.round, opponent: (m.team1_id === team.id ? m.team2_name : m.team1_name) ?? null }));
  } else {
    const preview = previewSchedule(event, teams);
    const p = preview.pools.find((x) => x.teams.some((y) => y.id === team.id));
    pool = pools ? (p?.pool ?? null) : null;
    rounds = (p?.rounds ?? []).map((r) => {
      const m = r.matches.find(([a, b]) => a.id === team.id || b.id === team.id);
      return { round: r.round, opponent: m ? (m[0].id === team.id ? m[1].name : m[0].name) : null };
    });
  }
  if (event.format === 'single_elim' && !built) return null;

  return (
    <Section title={`Your team: ${team.name}`}>
      {(pool || team.seed) && (
        <Item>
          {[pool && poolName(pool), team.seed && `seed ${team.seed}`].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase())}.
        </Item>
      )}
      {rounds.length > 0 && (
        <Item>
          {built ? 'Your pool matches' : 'Your pool matches if it started now (pools are set when the division starts)'}:
          <ol className="mt-2 flex flex-col gap-1 text-base">
            {rounds.map((r) => (
              <li key={r.round}>
                <span className="font-semibold">Round {r.round}: </span>
                {r.opponent ? `v ${r.opponent}` : <span className="text-muted">you sit out</span>}
              </li>
            ))}
          </ol>
        </Item>
      )}
      {event.pool_play === 'swiss' && !built && <Item>Swiss rounds after the first are drawn from results, so your later opponents aren’t known yet.</Item>}
    </Section>
  );
}
