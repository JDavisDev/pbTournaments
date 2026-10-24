// Typed wrappers for the engine's database functions (docs/api.md). Each one
// throws an Error with the database's message, which is written to be shown
// to the director as-is.
import { supabase } from './supabase';
import type {
  CourtBoardRow,
  MatchDetails,
  Organization,
  QueueRow,
  StandingRow,
  Team,
  Tournament,
  TournamentEvent,
  TournamentStatus,
} from './types';

function toError(error: { message: string }) {
  // PostgREST's "not in the schema cache" means the migrations haven't been pushed.
  if (/schema cache/.test(error.message)) {
    return new Error('The database isn’t set up yet. Run `npx supabase db push` in the project folder.');
  }
  return new Error(error.message);
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase().rpc(fn, args);
  if (error) throw toError(error);
  return data as T;
}

async function select<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw toError(error);
  return data as T;
}

// Reads -----------------------------------------------------------------

export const getTournament = (id: string) =>
  select<Tournament>(supabase().from('tournaments').select('*').eq('id', id).single());

export const getEvents = (tournamentId: string) =>
  select<TournamentEvent[]>(supabase().from('events').select('*').eq('tournament_id', tournamentId).order('sort_order'));

export const getTeams = (tournamentId: string) =>
  select<Team[]>(supabase().from('teams').select('*').eq('tournament_id', tournamentId).order('seed').order('name'));

export const getCourtBoard = (tournamentId: string) =>
  select<CourtBoardRow[]>(
    supabase().from('court_board').select('*').eq('tournament_id', tournamentId).order('sort_order').order('court_name'),
  );

export const getQueue = (tournamentId: string) => rpc<QueueRow[]>('up_next', { p_tournament: tournamentId });

export const getMatches = (tournamentId: string) =>
  select<MatchDetails[]>(
    supabase().from('match_details').select('*').eq('tournament_id', tournamentId).order('queue_seq'),
  );

export const getStandings = (tournamentId: string) =>
  select<StandingRow[]>(
    supabase().from('standings').select('*').eq('tournament_id', tournamentId).order('pool').order('pool_rank'),
  );

export const isStaff = (tournamentId: string) => rpc<boolean>('is_tournament_staff', { p_tournament: tournamentId });

export async function getMyOrganizations(): Promise<Organization[]> {
  const { data: auth } = await supabase().auth.getUser();
  if (!auth.user) return [];
  const rows = await select<{ organizations: Organization }[]>(
    supabase().from('organization_members').select('organizations(*)').eq('user_id', auth.user.id),
  );
  return rows.map((r) => r.organizations);
}

export const getOrganizationBySlug = (slug: string) =>
  select<Organization>(supabase().from('organizations').select('*').eq('slug', slug).single());

export const getOrganizationTournaments = (organizationId: string) =>
  select<Tournament[]>(
    supabase().from('tournaments').select('*').eq('organization_id', organizationId).order('starts_on', { ascending: false }),
  );

export const getLiveTournaments = () =>
  select<Tournament[]>(
    supabase().from('tournaments').select('*').in('status', ['registration', 'live']).order('starts_on').limit(50),
  );

// Organizations and tournaments ------------------------------------------

export const createOrganization = (name: string, slug: string) =>
  rpc<Organization>('create_organization', { p_name: name, p_slug: slug });

export const addOrganizationMember = (organizationId: string, email: string, role = 'director') =>
  rpc<void>('add_organization_member', { p_organization: organizationId, p_email: email, p_role: role });

export const createTournament = (organizationId: string, name: string, startsOn: string, courts: number) =>
  rpc<Tournament>('create_tournament', {
    p_organization: organizationId,
    p_name: name,
    p_starts_on: startsOn,
    p_court_count: courts,
  });

export const setTournamentStatus = (tournamentId: string, status: TournamentStatus) =>
  rpc<Tournament>('set_tournament_status', { p_tournament: tournamentId, p_status: status });

export const setAutoAssign = (tournamentId: string, on: boolean) =>
  rpc<Tournament>('set_auto_assign', { p_tournament: tournamentId, p_on: on });

export const setCourtCount = (tournamentId: string, count: number) =>
  rpc<number>('set_court_count', { p_tournament: tournamentId, p_count: count });

export async function updateTournament(id: string, changes: Partial<Tournament>) {
  await select(supabase().from('tournaments').update(changes).eq('id', id).select('id'));
}

// Events and teams ---------------------------------------------------------

export async function saveEvent(event: Partial<TournamentEvent> & { tournament_id: string }) {
  const { id, ...fields } = event;
  if (id) {
    // Only columns directors may update (see the access migration).
    const editable = Object.fromEntries(
      Object.entries(fields).filter(([key]) => key !== 'tournament_id' && key !== 'playoffs_seeded_at'),
    );
    return select<TournamentEvent>(supabase().from('events').update(editable).eq('id', id).select().single());
  }
  return select<TournamentEvent>(supabase().from('events').insert(fields).select().single());
}

export async function deleteEvent(id: string) {
  await select(supabase().from('events').delete().eq('id', id).select('id'));
}

/** Adds teams from lines like "Pat Davis / Sam Lee" or "Davis/Lee"; line order = seed order. */
export async function addTeamsFromText(eventId: string, text: string, firstSeed: number) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let seed = firstSeed;
  for (const line of lines) {
    const people = line.split(/\s*[\/&,]\s*|\s+and\s+/i).filter(Boolean);
    const players = await select<{ id: string; last_name: string }[]>(
      supabase()
        .from('players')
        .insert(
          people.map((full) => {
            const parts = full.split(/\s+/);
            const last = parts.pop()!;
            return { first_name: parts.join(' ') || '-', last_name: last };
          }),
        )
        .select('id, last_name'),
    );
    const team = await select<{ id: string }>(
      supabase()
        .from('teams')
        .insert({ event_id: eventId, name: players.map((p) => p.last_name).join('/'), seed })
        .select('id')
        .single(),
    );
    await select(
      supabase()
        .from('team_players')
        .insert(players.map((p) => ({ team_id: team.id, player_id: p.id })))
        .select('team_id'),
    );
    seed += 1;
  }
  return lines.length;
}

export async function deleteTeam(id: string) {
  await select(supabase().from('teams').delete().eq('id', id).select('id'));
}

export const generateMatches = (eventId: string) => rpc<number>('generate_matches', { p_event: eventId });
export const clearMatches = (eventId: string) => rpc<void>('clear_matches', { p_event: eventId });
export const checkInTeam = (teamId: string, checkedIn = true) =>
  rpc<Team>('check_in_team', { p_team: teamId, p_checked_in: checkedIn });

// Courts and matches -------------------------------------------------------

export const confirmOnCourt = (matchId: string) => rpc('confirm_on_court', { p_match: matchId });
export const reportScore = (matchId: string, games: [number, number][]) =>
  rpc('report_score', { p_match: matchId, p_games: games });
export const correctScore = (matchId: string, games: [number, number][]) =>
  rpc('correct_score', { p_match: matchId, p_games: games });
export const forfeitMatch = (matchId: string, winnerTeamId: string) =>
  rpc('forfeit_match', { p_match: matchId, p_winner_team: winnerTeamId });
export const requeueMatch = (matchId: string, absentTeamId: string | null) =>
  rpc('requeue_match', { p_match: matchId, p_absent_team: absentTeamId });
export const setCourtPaused = (courtId: string, paused: boolean) =>
  rpc('set_court_out_of_service', { p_court: courtId, p_out_of_service: paused });
export const assignMatchToCourt = (matchId: string, courtId: string) =>
  rpc('assign_match_to_court', { p_match: matchId, p_court: courtId });
export const moveMatchToCourt = (matchId: string, courtId: string) =>
  rpc('move_match_to_court', { p_match: matchId, p_court: courtId });
export const moveInQueue = (matchId: string, beforeMatchId: string | null) =>
  rpc('move_in_queue', { p_match: matchId, p_before_match: beforeMatchId });
export const holdMatch = (matchId: string, hold: boolean) => rpc('hold_match', { p_match: matchId, p_hold: hold });
export const rebuildQueue = (tournamentId: string) => rpc('rebuild_queue', { p_tournament: tournamentId });
export const assignCourtsNow = (tournamentId: string) => rpc<number>('assign_courts', { p_tournament: tournamentId });

export async function renameCourt(courtId: string, name: string) {
  await select(supabase().from('courts').update({ name }).eq('id', courtId).select('id'));
}
