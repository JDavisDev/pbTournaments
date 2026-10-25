// Typed wrappers for the engine's database functions (docs/api.md), talking to
// Supabase. Each one throws an Error with the database's message, which is
// written to be shown to the director as-is. Local mode has a matching
// handler for every function here in src/server/localOps.ts.
import { supabase } from './supabase';
import { parseTeams, teamName } from './teamText';
import type {
  CheckinPlayer,
  CodeMatch,
  CourtBoardRow,
  DemoText,
  DivisionCheckin,
  DuprResultRow,
  EligibilityRow,
  MessageScope,
  TeamRosterRow,
  MatchDetails,
  Organization,
  QueueRow,
  RegistrationForm,
  RegistrationRow,
  RegistrationView,
  StandingRow,
  Team,
  TextLogRow,
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
  const teams = parseTeams(text);
  let seed = firstSeed;
  for (const people of teams) {
    const players = await select<{ id: string }[]>(supabase().from('players').insert(people).select('id'));
    const team = await select<{ id: string }>(
      supabase()
        .from('teams')
        .insert({ event_id: eventId, name: teamName(people), seed })
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
  return teams.length;
}

export async function deleteTeam(id: string) {
  await select(supabase().from('teams').delete().eq('id', id).select('id'));
}

export const generateMatches = (eventId: string) => rpc<number>('generate_matches', { p_event: eventId });
export const clearMatches = (eventId: string) => rpc<void>('clear_matches', { p_event: eventId });
/** Cancels pool matches not yet on court; the bracket seeds once the rest finish. */
export const endPoolPlay = (eventId: string) => rpc<number>('end_pool_play', { p_event: eventId });
/** Releases a bracket held for seed review. */
/** Before seeding: change how many advance per pool; the bracket is rebuilt to match. */
export const setAdvancePerPool = (eventId: string, advance: number) =>
  rpc<number>('set_advance_per_pool', { p_event: eventId, p_advance: advance });
export const startBracket = (eventId: string) => rpc<void>('start_bracket', { p_event: eventId });
export const swapBracketTeams = (eventId: string, teamA: string, teamB: string) =>
  rpc<void>('swap_bracket_teams', { p_event: eventId, p_team_a: teamA, p_team_b: teamB });
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

// Registration ---------------------------------------------------------------

export const startRegistration = (tournamentId: string, f: RegistrationForm) =>
  rpc<{ registration_id: string; amount_cents: number; status: 'pending' | 'paid' }>('start_registration', {
    p_tournament: tournamentId,
    p_player: f.player,
    p_entries: f.entries,
  });

export const getRegistration = (id: string) => rpc<RegistrationView | null>('get_registration', { p_registration: id });

export const getRegistrations = (tournamentId: string) =>
  select<RegistrationRow[]>(
    supabase()
      .from('registration_details')
      .select('*')
      .eq('tournament_id', tournamentId)
      .order('created_at', { ascending: false }),
  );

export const pairRegistrations = (eventId: string, a: string, b: string) =>
  rpc('pair_registrations', { p_event: eventId, p_registration_a: a, p_registration_b: b });

// Score links and texts ------------------------------------------------------

export const getMatchByCode = (code: string) => rpc<CodeMatch | null>('get_match_by_code', { p_code: code });
export const confirmOnCourtByCode = (code: string) => rpc('confirm_on_court_by_code', { p_code: code });
export const reportScoreByCode = (code: string, games: [number, number][]) =>
  rpc('report_score_by_code', { p_code: code, p_games: games });

export const getTextLog = (tournamentId: string) =>
  select<TextLogRow[]>(
    supabase()
      .from('notification_log')
      .select('*')
      .eq('tournament_id', tournamentId)
      .order('id', { ascending: false })
      .limit(300),
  );

// Check-in desk, rosters, swaps and messages ---------------------------------

export const getCheckinRoster = (tournamentId: string) =>
  select<CheckinPlayer[]>(
    supabase().from('checkin_roster').select('*').eq('tournament_id', tournamentId).order('last_name').order('first_name'),
  );

export const getDivisionCheckin = (tournamentId: string) =>
  select<DivisionCheckin[]>(supabase().from('division_checkin').select('*').eq('tournament_id', tournamentId).order('sort_order'));

export const getTeamRoster = (tournamentId: string) =>
  select<TeamRosterRow[]>(
    supabase().from('team_roster').select('*').eq('tournament_id', tournamentId).order('event_sort_order').order('seed').order('name'),
  );

export const checkInPlayer = (tournamentId: string, playerId: string, checkedIn = true) =>
  rpc('check_in_player', { p_tournament: tournamentId, p_player: playerId, p_checked_in: checkedIn });

export const withdrawTeam = (teamId: string) => rpc<number>('withdraw_team', { p_team: teamId });

export const substitutePlayer = (teamId: string, oldPlayerId: string, p: { first_name: string; last_name: string; phone?: string; email?: string }) =>
  rpc('substitute_player', {
    p_team: teamId,
    p_old_player: oldPlayerId,
    p_first_name: p.first_name,
    p_last_name: p.last_name,
    p_phone: p.phone ?? null,
    p_email: p.email ?? null,
  });

export const replaceTeam = (oldTeamId: string, newTeamId: string) =>
  rpc('replace_team', { p_old_team: oldTeamId, p_new_team: newTeamId });

export async function renameTeam(teamId: string, name: string) {
  await select(supabase().from('teams').update({ name }).eq('id', teamId).select('id'));
}

export async function updatePlayer(
  playerId: string,
  changes: {
    first_name?: string;
    last_name?: string;
    phone?: string | null;
    email?: string | null;
    sms_opt_in?: boolean;
    dupr_id?: string | null;
    dupr_doubles?: number | null;
    dupr_singles?: number | null;
    rating_checked_at?: string | null;
  },
) {
  await select(supabase().from('players').update(changes).eq('id', playerId).select('id'));
}

// Demo ------------------------------------------------------------------------

/** A practice tournament with four divisions; returns its id. */
export const createDemoTournament = (arrived = true) => rpc<string>('create_demo_tournament', { p_arrived: arrived });
/** Plays a demo tournament forward; returns its new "now". */
export const advanceDemo = (tournamentId: string, minutes: number) =>
  rpc<string>('advance_demo', { p_tournament: tournamentId, p_minutes: minutes });
export const getDemoInbox = (teamId: string) => rpc<DemoText[]>('demo_inbox', { p_team: teamId });

// DUPR -----------------------------------------------------------------------

export const getDivisionEligibility = (tournamentId: string) =>
  rpc<EligibilityRow[]>('division_eligibility', { p_tournament: tournamentId });
/** Confirmed ratings from a pasted list, matched by DUPR ID. */
export const importDuprRatings = (tournamentId: string, list: { dupr_id: string; doubles?: number; singles?: number }[]) =>
  rpc<{ updated: number; unknown: string[] }>('import_dupr_ratings', { p_tournament: tournamentId, p_rows: list });
export const getDuprResults = (tournamentId: string) => rpc<DuprResultRow[]>('dupr_results', { p_tournament: tournamentId });
export const markDuprExported = (tournamentId: string, matchIds: string[], exported = true) =>
  rpc<number>('mark_dupr_exported', { p_tournament: tournamentId, p_matches: matchIds, p_exported: exported });

export const sendMessage = (
  tournamentId: string,
  scope: MessageScope,
  target: string | null,
  body: string,
  via: ('sms' | 'email')[],
  subject?: string,
) =>
  rpc<number>('send_message', {
    p_tournament: tournamentId,
    p_scope: scope,
    p_target: target,
    p_body: body,
    p_via: via,
    p_subject: subject ?? null,
  });

export async function renameCourt(courtId: string, name: string) {
  await select(supabase().from('courts').update({ name }).eq('id', courtId).select('id'));
}

export async function setCourtStream(courtId: string, url: string | null) {
  await select(supabase().from('courts').update({ stream_url: url || null }).eq('id', courtId).select('id'));
}
