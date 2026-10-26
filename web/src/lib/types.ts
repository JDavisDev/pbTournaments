// Row shapes of the tables and views the screens read. See docs/api.md.

export type TournamentStatus = 'draft' | 'registration' | 'live' | 'complete';
export type EventFormat = 'round_robin' | 'pools_to_bracket' | 'single_elim';
export type MatchStatus = 'waiting' | 'queued' | 'assigned' | 'in_progress' | 'completed' | 'cancelled';
export type BracketType = 'single' | 'double';
/** Which format a match uses (see TournamentEvent.round_formats). */
export type RoundKey =
  | 'pool'
  | 'final'
  | 'semifinal'
  | 'quarterfinal'
  | 'earlier'
  | 'bronze'
  | 'winners'
  | 'losers'
  | 'grand_final';

export interface RoundFormat {
  key: RoundKey;
  games_to: number;
  best_of: number;
  point_cap?: number | null;
}
export type BlockedReason =
  | 'on_hold'
  | 'event_not_started'
  | 'not_checked_in'
  | 'player_on_court'
  | 'player_needed_elsewhere'
  | 'waiting_for_championship_court'
  | null;

/** What a championship match does when every championship court is busy (see docs/api.md). */
export type ChampionshipMode = 'off' | 'wait' | 'first_available';

export interface Organization {
  id: string;
  name: string;
  slug: string;
}

export interface Tournament {
  id: string;
  organization_id: string;
  name: string;
  starts_on: string;
  time_zone: string;
  status: TournamentStatus;
  no_show_minutes: number;
  overdue_after_minutes: number;
  match_slot_minutes: number;
  auto_assign: boolean;
  entry_fee_cents: number;
  extra_event_fee_cents: number;
  early_entry_fee_cents: number | null;
  early_extra_event_fee_cents: number | null;
  early_until: string | null;
  refund_fee_cents: number;
  stream_url: string | null;
  location: string | null;
  dupr_score_type: 'SIDEOUT' | 'RALLY';
  championship_mode: ChampionshipMode;
  /** Bracket rounds that go to championship courts first. */
  championship_rounds: RoundKey[];
  /** How long a championship match waits for a championship court in Wait mode (null = no limit). */
  championship_wait_minutes: number | null;
  /** The same for finals, which wait for the Main court. */
  final_wait_minutes: number | null;
  /** A practice tournament: the demo clock works and its texts show on team pages. */
  is_demo: boolean;
  /** Players across the tournament; more go on the waitlist. */
  max_players: number | null;
  registration_closes_at: string | null;
  /** Players must agree to this to register. */
  waiver_text: string | null;
  /** One image (logo or banner) as a data URL. */
  image_data: string | null;
  /** Division start times show to players only once published. */
  times_published_at: string | null;
  /** Off: no texts (and no texting fee); emails still go out. */
  texts_enabled: boolean;
  /** The one-time setup fee; needed before registration opens or play starts. */
  setup_paid_at: string | null;
}

export interface PlatformPricing {
  setup_fee_cents: number;
  per_player_cents: number;
  texting_per_player_cents: number;
}

/** tournament_fees(): what the director owes the platform. */
export interface TournamentFees extends PlatformPricing {
  is_demo: boolean;
  setup_due_cents: number;
  setup_paid_at: string | null;
  players: number;
  texts_enabled: boolean;
  player_fees_cents: number;
}

export type StaffRole = 'admin' | 'monitor';

/** tournament_team(): who can run a tournament. */
export interface StaffMember {
  /** Null for a guest (demo sites). */
  email: string | null;
  role: StaffRole;
  /** organization: always an admin; tournament: added here; invite: not signed up yet. */
  source: 'organization' | 'tournament' | 'invite';
  is_me: boolean;
}

export interface DiscountCode {
  id: string;
  tournament_id: string;
  code: string;
  percent_off: number | null;
  amount_off_cents: number | null;
  max_uses: number | null;
  expires_at: string | null;
}

/** demo_inbox(): a text sent to a demo team's player; links are paths (/s/<code>). */
export interface DemoText {
  id: number;
  created_at: string;
  player_name: string;
  body: string;
}

export interface RegistrationForm {
  player: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    sms_opt_in: boolean;
    gender: 'male' | 'female' | null;
    birth_date: string | null;
    dupr_doubles: number | null;
    dupr_singles: number | null;
    self_rating: number | null;
    dupr_id?: string | null;
    discount_code?: string | null;
    waiver_accepted?: boolean;
  };
  entries: { event_id: string; partner_name?: string; partner_email?: string }[];
}

/** What a player sees about their own registration. */
export interface RegistrationView {
  id: string;
  tournament_id: string;
  tournament_name: string;
  status: 'pending' | 'paid' | 'cancelled' | 'refunded' | 'waitlisted';
  amount_cents: number;
  discount_cents?: number;
  player_name: string;
  email: string;
  entries: {
    event_id: string;
    event_name: string;
    partner_name: string | null;
    team_id: string | null;
    team_name: string | null;
    waitlisted?: boolean;
    offered?: boolean;
  }[];
}

/** One row per registration entry (registration_details view), for directors. */
export interface RegistrationRow {
  registration_id: string;
  tournament_id: string;
  status: RegistrationView['status'];
  amount_cents: number;
  payment_provider: string | null;
  created_at: string;
  paid_at: string | null;
  player_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  sms_opt_in: boolean;
  gender: 'male' | 'female' | null;
  birth_date: string | null;
  dupr_doubles: string | null;
  dupr_singles: string | null;
  self_rating: string | null;
  event_id: string;
  event_name: string;
  partner_name: string | null;
  partner_email: string | null;
  team_id: string | null;
  team_name: string | null;
  waitlisted: boolean;
  waitlisted_at: string | null;
  offered_at: string | null;
  discount_code: string | null;
  discount_cents: number;
}

export interface TextLogRow {
  id: number;
  tournament_id: string;
  kind: string;
  via: 'sms' | 'email';
  subject: string | null;
  created_at: string;
  sent_at: string | null;
  channel: 'sms' | 'email' | 'log' | 'none' | null;
  to_phone: string | null;
  to_email: string | null;
  body: string;
  error: string | null;
  /** Twilio's message id and latest delivery report (queued, sent, delivered, undelivered, failed). */
  provider_id: string | null;
  delivery_status: string | null;
  player_name: string;
  court_name: string | null;
}

/** The Twilio setup, as checked by /api/twilio/check. */
export interface TwilioCheck {
  mode: 'live' | 'log';
  sender: string | null;
  callbackUrl: string | null;
  account: { status: string; type: string; name: string } | null;
  error: string | null;
  warnings: string[];
}

export interface RosterPlayer {
  player_id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  sms_opt_in: boolean;
  checked_in: boolean;
  dupr_id: string | null;
  dupr_doubles: number | null;
  dupr_singles: number | null;
  self_rating: number | null;
  /** Set when a director confirmed the ratings (by hand or from a DUPR list). */
  rating_checked_at: string | null;
}

/** division_eligibility(): one row per team; problems is empty when it's fine. */
export interface EligibilityRow {
  event_id: string;
  team_id: string;
  team_name: string;
  problems: string[];
  /** Players in a rated division whose rating no director has confirmed. */
  unchecked_ratings: number;
}

/** dupr_results(): a played match with what DUPR's club CSV upload needs. */
export interface DuprResultRow {
  match_id: string;
  event_id: string;
  event_name: string;
  label: string;
  completed_at: string;
  match_type: 'S' | 'D';
  event: string;
  date: string;
  player_a1: string;
  player_a1_dupr_id: string | null;
  player_a2: string | null;
  player_a2_dupr_id: string | null;
  player_b1: string;
  player_b1_dupr_id: string | null;
  player_b2: string | null;
  player_b2_dupr_id: string | null;
  games: [number, number][];
  location: string | null;
  score_type: 'SIDEOUT' | 'RALLY';
  missing_ids: string[];
  exported_at: string | null;
}

/** team_roster view */
export interface TeamRosterRow {
  team_id: string;
  tournament_id: string;
  event_id: string;
  event_name: string;
  event_sort_order: number;
  name: string;
  seed: number | null;
  pool: number | null;
  checked_in_at: string | null;
  withdrawn_at: string | null;
  match_count: number;
  players: RosterPlayer[];
}

/** checkin_roster view: one row per player */
export interface CheckinPlayer {
  tournament_id: string;
  player_id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  checked_in_at: string | null;
  teams: { team_id: string; team_name: string; event_id: string; event_name: string }[];
}

/** division_checkin view */
export interface DivisionCheckin {
  tournament_id: string;
  event_id: string;
  event_name: string;
  sort_order: number;
  not_before: string | null;
  teams: number;
  teams_ready: number;
  players: number;
  players_in: number;
}

export type MessageScope = 'player' | 'team' | 'event' | 'everyone' | 'not_checked_in';

export interface TournamentEvent {
  id: string;
  tournament_id: string;
  name: string;
  kind: 'doubles' | 'singles';
  format: EventFormat;
  pool_count: number;
  advance_per_pool: number;
  games_to: number;
  best_of: number;
  point_cap: number | null;
  playoff_games_to: number | null;
  playoff_best_of: number | null;
  playoff_point_cap: number | null;
  not_before: string | null;
  sort_order: number;
  playoffs_seeded_at: string | null;
  gender: 'open' | 'mens' | 'womens' | 'mixed';
  min_age: number | null;
  max_age: number | null;
  age_basis: 'tournament_day' | 'year_end';
  skill_rule: 'open' | 'only' | 'and_under' | 'and_above' | 'range';
  skill_level: string | null;
  skill_level_to: string | null;
  rating_source: 'dupr' | 'dupr_or_self';
  allow_play_up: boolean;
  max_teams: number | null;
  partner_required: boolean;
  /** Expected minutes per match (court time included); null = the tournament's match_slot_minutes. */
  pool_match_minutes: number | null;
  bracket_match_minutes: number | null;
  rating_tolerance: number;
  play_up_limit: number | null;
  require_dupr_id: boolean;
  team_rating_max: number | null;
  team_age_min: number | null;
  max_rounds: number | null;
  bracket_type: BracketType;
  third_place_match: boolean;
  grand_final_reset: boolean;
  confirm_seeds: boolean;
  round_formats: RoundFormat[];
  /** Court section: this division plays only here (and holds these courts until it's done). Empty = any open court. */
  court_ids: string[];
}

export interface Team {
  id: string;
  event_id: string;
  tournament_id: string;
  name: string;
  seed: number | null;
  pool: number | null;
  checked_in_at: string | null;
  withdrawn_at: string | null;
}

export interface CourtBoardRow {
  tournament_id: string;
  court_id: string;
  court_name: string;
  sort_order: number;
  out_of_service: boolean;
  match_id: string | null;
  match_status: 'assigned' | 'in_progress' | null;
  event_id: string | null;
  event_name: string | null;
  label: string | null;
  team1_id: string | null;
  team1_name: string | null;
  team2_id: string | null;
  team2_name: string | null;
  assigned_at: string | null;
  started_at: string | null;
  no_show_deadline: string | null;
  stream_url: string | null;
  stage: 'pool' | 'bracket' | null;
  games_to: number | null;
  best_of: number | null;
  point_cap: number | null;
  format_text: string | null;
  /** 1 = the Main championship court, 2 = the next, ...; null = an ordinary court. */
  championship_rank: number | null;
}

export interface QueueRow {
  queue_rank: number;
  match_id: string;
  event_id: string;
  event_name: string;
  label: string;
  team1_id: string;
  team1_name: string;
  team2_id: string;
  team2_name: string;
  blocked_reason: BlockedReason;
  overdue: boolean;
  waiting_since: string | null;
  /** The division's court section; empty = any court outside the sections. */
  court_names: string[];
  /** A bracket round that goes to championship courts first. */
  championship: boolean;
  /** With waiting_for_championship_court: the court it waits for (null = any championship court). */
  waiting_for_court: string | null;
  /** With waiting_for_championship_court: when it stops waiting and takes any court (null = never). */
  wait_until: string | null;
}

export interface MatchDetails {
  id: string;
  tournament_id: string;
  event_id: string;
  event_name: string;
  event_format: EventFormat;
  stage: 'pool' | 'bracket';
  /** main: pools, single elimination, the winners bracket; losers; final: grand final and bronze. */
  side: 'main' | 'losers' | 'final';
  round_key: RoundKey;
  is_bye: boolean;
  /** A slot no team will fill: the other team goes through without playing. */
  team1_bye: boolean;
  team2_bye: boolean;
  pool: number;
  pool_letter: string | null;
  round: number;
  position: number;
  label: string;
  wave: number;
  queue_seq: string;
  on_hold: boolean;
  status: MatchStatus;
  team1_id: string | null;
  team1_name: string;
  team2_id: string | null;
  team2_name: string;
  team1_seed: number | null;
  team2_seed: number | null;
  court_id: string | null;
  court_name: string | null;
  queued_at: string | null;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  games: [number, number][] | null;
  winner_team_id: string | null;
  forfeit: boolean;
  winner_to_match_id: string | null;
  loser_to_match_id: string | null;
  court_stream_url: string | null;
  games_to: number;
  best_of: number;
  point_cap: number | null;
  /** e.g. "one game to 15, win by 2" */
  format_text: string;
}

/** The match behind a score link. */
export interface CodeMatch extends MatchDetails {
  tournament_name: string;
}

export interface StandingRow {
  tournament_id: string;
  event_id: string;
  pool: number;
  pool_letter: string;
  team_id: string;
  team_name: string;
  seed: number | null;
  played: number;
  wins: number;
  losses: number;
  win_pct: number;
  points_for: number;
  points_against: number;
  point_diff: number;
  wins_vs_tied: number;
  pool_rank: number;
}
