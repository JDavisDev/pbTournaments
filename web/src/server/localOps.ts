// Server side of local mode: one handler per function in src/lib/remoteApi.ts,
// running the same SQL against the local database as the signed-in user, plus
// local sign-in and demo tools.
import type { Transaction } from '@electric-sql/pglite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { parseTeams, teamName } from '@/lib/teamText';
import type { RegistrationForm } from '@/lib/types';
import { runAs } from './localDb';

type Row = Record<string, unknown>;
type Op = (tx: Transaction, ...args: never[]) => Promise<unknown>;

async function all<T = Row>(tx: Transaction, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query<T>(sql, params)).rows;
}

async function one<T = Row>(tx: Transaction, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await all<T>(tx, sql, params);
  if (rows.length === 0) throw new Error('Not found');
  return rows[0];
}

/** `update table set a = $2, b = $3 where id = $1` for the allowed columns present in changes. */
async function updateColumns(tx: Transaction, table: string, id: string, changes: Row, allowed: string[]) {
  const columns = allowed.filter((c) => c in changes);
  if (columns.length === 0) return one(tx, `select * from public.${table} where id = $1`, [id]);
  const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
  return one(tx, `update public.${table} set ${sets} where id = $1 returning *`, [id, ...columns.map((c) => changes[c])]);
}

const EVENT_COLUMNS = [
  'name',
  'kind',
  'format',
  'pool_count',
  'advance_per_pool',
  'games_to',
  'best_of',
  'point_cap',
  'playoff_games_to',
  'playoff_best_of',
  'playoff_point_cap',
  'gender',
  'min_age',
  'max_age',
  'age_basis',
  'skill_rule',
  'skill_level',
  'skill_level_to',
  'rating_source',
  'allow_play_up',
  'max_teams',
  'partner_required',
  'pool_match_minutes',
  'bracket_match_minutes',
  'rating_tolerance',
  'play_up_limit',
  'require_dupr_id',
  'team_rating_max',
  'team_age_min',
  'max_rounds',
  'bracket_type',
  'third_place_match',
  'grand_final_reset',
  'confirm_seeds',
  'round_formats',
  'not_before',
  'sort_order',
];

async function addTeams(tx: Transaction, eventId: string, text: string, firstSeed: number) {
  const teams = parseTeams(text);
  for (const [i, players] of teams.entries()) {
    const ids: string[] = [];
    for (const p of players) {
      const row = await one<{ id: string }>(
        tx,
        'insert into public.players (first_name, last_name) values ($1, $2) returning id',
        [p.first_name, p.last_name],
      );
      ids.push(row.id);
    }
    const team = await one<{ id: string }>(
      tx,
      'insert into public.teams (event_id, name, seed) values ($1, $2, $3) returning id',
      [eventId, teamName(players), firstSeed + i],
    );
    for (const id of ids) {
      await tx.query('insert into public.team_players (team_id, player_id) values ($1, $2)', [team.id, id]);
    }
  }
  return teams.length;
}

const games = (g: unknown) => JSON.stringify(g);

/** Same names and results as src/lib/remoteApi.ts. */
const ops: Record<string, Op> = {
  getTournament: (tx, id: string) => one(tx, 'select * from public.tournaments where id = $1', [id]),
  getEvents: (tx, id: string) => all(tx, 'select * from public.events where tournament_id = $1 order by sort_order', [id]),
  getTeams: (tx, id: string) => all(tx, 'select * from public.teams where tournament_id = $1 order by seed, name', [id]),
  getCourtBoard: (tx, id: string) =>
    all(tx, 'select * from public.court_board where tournament_id = $1 order by sort_order, court_name', [id]),
  getQueue: (tx, id: string) => all(tx, 'select * from public.up_next($1)', [id]),
  getMatches: (tx, id: string) =>
    all(tx, 'select * from public.match_details where tournament_id = $1 order by queue_seq', [id]),
  getStandings: (tx, id: string) =>
    all(tx, 'select * from public.standings where tournament_id = $1 order by pool, pool_rank', [id]),
  isStaff: async (tx, id: string) => (await one<{ v: boolean }>(tx, 'select public.is_tournament_staff($1) as v', [id])).v,
  getMyOrganizations: (tx) =>
    all(
      tx,
      `select o.* from public.organization_members m join public.organizations o on o.id = m.organization_id
       where m.user_id = auth.uid() order by o.name`,
    ),
  getOrganizationBySlug: (tx, slug: string) => one(tx, 'select * from public.organizations where slug = $1', [slug]),
  getOrganizationTournaments: (tx, id: string) =>
    all(tx, 'select * from public.tournaments where organization_id = $1 order by starts_on desc', [id]),
  getLiveTournaments: (tx) =>
    all(tx, `select * from public.tournaments where status in ('registration', 'live') order by starts_on limit 50`),

  createOrganization: (tx, name: string, slug: string) =>
    one(tx, 'select * from public.create_organization($1, $2)', [name, slug]),
  addOrganizationMember: (tx, org: string, email: string, role = 'director') =>
    tx.query('select public.add_organization_member($1, $2, $3)', [org, email, role]).then(() => null),
  createTournament: (tx, org: string, name: string, startsOn: string, courts: number) =>
    one(tx, 'select * from public.create_tournament($1, $2, $3, $4)', [org, name, startsOn, courts]),
  setTournamentStatus: (tx, id: string, status: string) =>
    one(tx, 'select * from public.set_tournament_status($1, $2::public.tournament_status)', [id, status]),
  setAutoAssign: (tx, id: string, on: boolean) => one(tx, 'select * from public.set_auto_assign($1, $2)', [id, on]),
  setCourtCount: async (tx, id: string, count: number) =>
    (await one<{ n: number }>(tx, 'select public.set_court_count($1, $2) as n', [id, count])).n,
  updateTournament: (tx, id: string, changes: Row) =>
    updateColumns(tx, 'tournaments', id, changes, [
      'name',
      'starts_on',
      'time_zone',
      'no_show_minutes',
      'overdue_after_minutes',
      'match_slot_minutes',
      'entry_fee_cents',
      'extra_event_fee_cents',
      'early_entry_fee_cents',
      'early_extra_event_fee_cents',
      'early_until',
      'refund_fee_cents',
      'stream_url',
      'location',
      'dupr_score_type',
      'max_players',
      'registration_closes_at',
      'waiver_text',
      'image_data',
      'times_published_at',
      'texts_enabled',
    ]).then(() => null),

  saveEvent: async (tx, event: Row) => {
    if ('round_formats' in event) event = { ...event, round_formats: JSON.stringify(event.round_formats ?? []) };
    if (event.id) return updateColumns(tx, 'events', event.id as string, event, EVENT_COLUMNS);
    const columns = ['tournament_id', ...EVENT_COLUMNS.filter((c) => c in event)];
    const params = columns.map((_, i) => `$${i + 1}`).join(', ');
    return one(tx, `insert into public.events (${columns.join(', ')}) values (${params}) returning *`, columns.map((c) => event[c]));
  },
  deleteEvent: (tx, id: string) => tx.query('delete from public.events where id = $1', [id]).then(() => null),
  addTeamsFromText: (tx, eventId: string, text: string, firstSeed: number) => addTeams(tx, eventId, text, firstSeed),
  deleteTeam: (tx, id: string) => tx.query('delete from public.teams where id = $1', [id]).then(() => null),
  generateMatches: async (tx, id: string) => (await one<{ n: number }>(tx, 'select public.generate_matches($1) as n', [id])).n,
  clearMatches: (tx, id: string) => tx.query('select public.clear_matches($1)', [id]).then(() => null),
  endPoolPlay: async (tx, id: string) => (await one<{ n: number }>(tx, 'select public.end_pool_play($1) as n', [id])).n,
  setAdvancePerPool: async (tx, id: string, advance: number) =>
    (await one<{ n: number }>(tx, 'select public.set_advance_per_pool($1, $2) as n', [id, advance])).n,
  startBracket: (tx, id: string) => tx.query('select public.start_bracket($1)', [id]).then(() => null),
  swapBracketTeams: (tx, eventId: string, a: string, b: string) =>
    tx.query('select public.swap_bracket_teams($1, $2, $3)', [eventId, a, b]).then(() => null),
  checkInTeam: (tx, id: string, checkedIn = true) => one(tx, 'select * from public.check_in_team($1, $2)', [id, checkedIn]),

  confirmOnCourt: (tx, id: string) => one(tx, 'select * from public.confirm_on_court($1)', [id]),
  reportScore: (tx, id: string, g: unknown) => one(tx, 'select * from public.report_score($1, $2::jsonb)', [id, games(g)]),
  correctScore: (tx, id: string, g: unknown) => one(tx, 'select * from public.correct_score($1, $2::jsonb)', [id, games(g)]),
  forfeitMatch: (tx, id: string, winner: string) => one(tx, 'select * from public.forfeit_match($1, $2)', [id, winner]),
  requeueMatch: (tx, id: string, absent: string | null) =>
    one(tx, 'select * from public.requeue_match($1, $2)', [id, absent]),
  setCourtPaused: (tx, id: string, paused: boolean) =>
    one(tx, 'select * from public.set_court_out_of_service($1, $2)', [id, paused]),
  assignMatchToCourt: (tx, id: string, court: string) =>
    one(tx, 'select * from public.assign_match_to_court($1, $2)', [id, court]),
  moveMatchToCourt: (tx, id: string, court: string) => one(tx, 'select * from public.move_match_to_court($1, $2)', [id, court]),
  moveInQueue: (tx, id: string, before: string | null) => one(tx, 'select * from public.move_in_queue($1, $2)', [id, before]),
  holdMatch: (tx, id: string, hold: boolean) => one(tx, 'select * from public.hold_match($1, $2)', [id, hold]),
  rebuildQueue: (tx, id: string) => tx.query('select public.rebuild_queue($1)', [id]).then(() => null),
  assignCourtsNow: async (tx, id: string) => (await one<{ n: number }>(tx, 'select public.assign_courts($1) as n', [id])).n,
  renameCourt: (tx, id: string, name: string) =>
    tx.query('update public.courts set name = $2 where id = $1', [id, name]).then(() => null),
  setCourtStream: (tx, id: string, url: string | null) =>
    tx.query('update public.courts set stream_url = $2 where id = $1', [id, url || null]).then(() => null),

  startRegistration: async (tx, tournamentId: string, f: RegistrationForm) =>
    (
      await one<{ r: unknown }>(tx, 'select public.start_registration($1, $2::jsonb, $3::jsonb) as r', [
        tournamentId,
        JSON.stringify(f.player),
        JSON.stringify(f.entries),
      ])
    ).r,
  getRegistration: async (tx, id: string) => (await one<{ r: unknown }>(tx, 'select public.get_registration($1) as r', [id])).r,
  getRegistrations: (tx, id: string) =>
    all(tx, 'select * from public.registration_details where tournament_id = $1 order by created_at desc', [id]),
  pairRegistrations: (tx, eventId: string, a: string, b: string) =>
    one(tx, 'select * from public.pair_registrations($1, $2, $3)', [eventId, a, b]),
  getMatchByCode: async (tx, code: string) => (await one<{ m: unknown }>(tx, 'select public.get_match_by_code($1) as m', [code])).m,
  confirmOnCourtByCode: (tx, code: string) => one(tx, 'select public.confirm_on_court_by_code($1) as r', [code]),
  reportScoreByCode: (tx, code: string, g: unknown) =>
    one(tx, 'select public.report_score_by_code($1, $2::jsonb) as r', [code, games(g)]),
  getTextLog: (tx, id: string) =>
    all(tx, 'select * from public.notification_log where tournament_id = $1 order by id desc limit 300', [id]),

  getCheckinRoster: (tx, id: string) =>
    all(tx, 'select * from public.checkin_roster where tournament_id = $1 order by last_name, first_name', [id]),
  getDivisionCheckin: (tx, id: string) =>
    all(tx, 'select * from public.division_checkin where tournament_id = $1 order by sort_order', [id]),
  getTeamRoster: (tx, id: string) =>
    all(tx, 'select * from public.team_roster where tournament_id = $1 order by event_sort_order, seed, name', [id]),
  checkInPlayer: (tx, tournamentId: string, playerId: string, checkedIn = true) =>
    tx.query('select public.check_in_player($1, $2, $3)', [tournamentId, playerId, checkedIn]).then(() => null),
  withdrawTeam: async (tx, id: string) => (await one<{ n: number }>(tx, 'select public.withdraw_team($1) as n', [id])).n,
  substitutePlayer: (tx, teamId: string, oldPlayer: string, p: { first_name: string; last_name: string; phone?: string; email?: string }) =>
    one(tx, 'select * from public.substitute_player($1, $2, $3, $4, $5, $6)', [
      teamId,
      oldPlayer,
      p.first_name,
      p.last_name,
      p.phone ?? null,
      p.email ?? null,
    ]),
  replaceTeam: (tx, oldTeam: string, newTeam: string) => one(tx, 'select * from public.replace_team($1, $2)', [oldTeam, newTeam]),
  renameTeam: (tx, id: string, name: string) =>
    tx.query('update public.teams set name = $2 where id = $1', [id, name]).then(() => null),
  updatePlayer: (tx, id: string, changes: Row) =>
    updateColumns(tx, 'players', id, changes, [
      'first_name',
      'last_name',
      'phone',
      'email',
      'sms_opt_in',
      'dupr_id',
      'dupr_doubles',
      'dupr_singles',
      'rating_checked_at',
    ]).then(() => null),
  offerWaitlistSpot: async (tx, reg: string, event: string) =>
    (await one<{ r: unknown }>(tx, 'select public.offer_waitlist_spot($1, $2) as r', [reg, event])).r,
  removeWaitlistEntry: (tx, reg: string, event: string) =>
    tx.query('select public.remove_waitlist_entry($1, $2)', [reg, event]).then(() => null),
  getRegistrationAvailability: (tx, id: string) => all(tx, 'select * from public.registration_availability($1)', [id]),
  checkDiscountCode: async (tx, id: string, code: string, amount: number) =>
    (await one<{ r: unknown }>(tx, 'select public.check_discount_code($1, $2, $3) as r', [id, code, amount])).r,
  getDiscountCodes: (tx, id: string) => all(tx, 'select * from public.discount_codes where tournament_id = $1 order by code', [id]),
  addDiscountCode: (tx, c: Row) =>
    tx
      .query(
        `insert into public.discount_codes (tournament_id, code, percent_off, amount_off_cents, max_uses, expires_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [c.tournament_id, c.code, c.percent_off ?? null, c.amount_off_cents ?? null, c.max_uses ?? null, c.expires_at ?? null],
      )
      .then(() => null),
  deleteDiscountCode: (tx, id: string) => tx.query('delete from public.discount_codes where id = $1', [id]).then(() => null),
  getPlatformPricing: async (tx) => (await one<{ r: unknown }>(tx, 'select public.platform_pricing() as r')).r,
  getTournamentFees: async (tx, id: string) => (await one<{ r: unknown }>(tx, 'select public.tournament_fees($1) as r', [id])).r,
  getMyRole: async (tx, id: string) => (await one<{ r: string | null }>(tx, 'select public.my_tournament_role($1) as r', [id])).r,
  getTournamentTeam: (tx, id: string) => all(tx, 'select * from public.tournament_team($1)', [id]),
  addTournamentStaff: async (tx, id: string, email: string, role: string) =>
    (await one<{ r: string }>(tx, 'select public.add_tournament_staff($1, $2, $3) as r', [id, email, role])).r,
  removeTournamentStaff: (tx, id: string, email: string) =>
    tx.query('select public.remove_tournament_staff($1, $2)', [id, email]).then(() => null),
  claimStaffInvites: async (tx) => (await one<{ n: number }>(tx, 'select public.claim_staff_invites() as n')).n,
  getDemoInbox: (tx, id: string) => all(tx, 'select * from public.demo_inbox($1)', [id]),
  getDivisionEligibility: (tx, id: string) => all(tx, 'select * from public.division_eligibility($1)', [id]),
  importDuprRatings: async (tx, id: string, list: unknown) =>
    (await one<{ r: unknown }>(tx, 'select public.import_dupr_ratings($1, $2::jsonb) as r', [id, JSON.stringify(list)])).r,
  getDuprResults: (tx, id: string) => all(tx, 'select * from public.dupr_results($1)', [id]),
  markDuprExported: async (tx, id: string, matchIds: string[], exported = true) =>
    (await one<{ n: number }>(tx, 'select public.mark_dupr_exported($1, $2::uuid[], $3) as n', [id, matchIds, exported])).n,
  sendMessage: async (tx, tournamentId: string, scope: string, target: string | null, body: string, via: string[], subject?: string) =>
    (
      await one<{ n: number }>(tx, 'select public.send_message($1, $2, $3, $4, $5, $6) as n', [
        tournamentId,
        scope,
        target,
        body,
        via,
        subject ?? null,
      ])
    ).n,
};

// ---------------------------------------------------------------------------
// Local sign-in (stands in for Supabase Auth)
// ---------------------------------------------------------------------------

const hashPassword = (password: string, salt: string) => scryptSync(password, salt, 32).toString('hex');

const authOps: Record<string, Op> = {
  signUp: async (tx, email: string, password: string) => {
    const address = email.trim().toLowerCase();
    if (password.length < 6) throw new Error('Use at least 6 characters for the password');
    if ((await all(tx, 'select 1 from auth.users where email = $1', [address])).length) {
      throw new Error('An account with this email already exists. Sign in instead.');
    }
    const user = await one<{ id: string; email: string }>(tx, 'insert into auth.users (email) values ($1) returning id, email', [address]);
    const salt = randomBytes(16).toString('hex');
    await tx.query('insert into local_meta.passwords (user_id, salt, hash) values ($1, $2, $3)', [
      user.id,
      salt,
      hashPassword(password, salt),
    ]);
    return user;
  },
  signIn: async (tx, email: string, password: string) => {
    const rows = await all<{ id: string; email: string; salt: string; hash: string }>(
      tx,
      `select u.id, u.email, p.salt, p.hash from auth.users u join local_meta.passwords p on p.user_id = u.id
       where u.email = $1`,
      [email.trim().toLowerCase()],
    );
    const user = rows[0];
    if (!user || !timingSafeEqual(Buffer.from(hashPassword(password, user.salt), 'hex'), Buffer.from(user.hash, 'hex'))) {
      throw new Error('Wrong email or password');
    }
    return { id: user.id, email: user.email };
  },
  // Demo sites: a session with no email or password. Every visitor shares one
  // guest, like the hosted demo's shared guest account.
  signInGuest: async (tx) =>
    (await all<{ id: string; email: null }>(tx, 'select id, email from auth.users where email is null limit 1'))[0] ??
    one<{ id: string; email: null }>(tx, 'insert into auth.users (email) values (null) returning id, email'),
  // A saved session can outlive the local database (it's rebuilt when migrations change).
  currentUser: async (tx, id: string) => (await all(tx, 'select id, email from auth.users where id = $1', [id]))[0] ?? null,
  // The screens poll this instead of a Realtime subscription.
  getLiveState: async (tx, id: string) =>
    (
      await all(
        tx,
        `select (select revision::text from public.tournament_live where tournament_id = $1) as revision,
                coalesce(nullif(current_setting('engine.sim_now', true), '')::timestamptz, now()) as now`,
        [id],
      )
    )[0],
};

// ---------------------------------------------------------------------------
// Demo tools (the same database functions the hosted demo uses)
// ---------------------------------------------------------------------------

const demoOps: Record<string, Op> = {
  createDemoTournament: async (tx, arrived: boolean = true) =>
    (await one<{ id: string }>(tx, 'select public.create_demo_tournament($1) as id', [arrived])).id,
  advanceDemo: async (tx, tournamentId: string, minutes: number) =>
    (await one<{ now: string }>(tx, 'select public.advance_demo($1, $2) as now', [tournamentId, minutes])).now,
};

/** Runs one local-mode operation for the signed-in user (userId from the browser's local session). */
export async function runOp(op: string, args: unknown[], userId: string | null): Promise<unknown> {
  if (op in authOps) {
    return runAs(null, (tx) => authOps[op](tx, ...(args as never[])), { system: true });
  }
  if (op in demoOps) {
    if (!userId) throw new Error('Sign in first');
    return runAs(userId, (tx) => demoOps[op](tx, ...(args as never[])), { system: true });
  }
  const handler = ops[op];
  if (!handler) throw new Error(`Unknown operation: ${op}`);
  return runAs(userId, (tx) => handler(tx, ...(args as never[])));
}
