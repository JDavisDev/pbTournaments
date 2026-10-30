// Row shapes of the tables and views the screens read. See docs/api.md.

export type TournamentStatus = 'draft' | 'registration' | 'live' | 'complete';
export type EventFormat = 'round_robin' | 'pools_to_bracket' | 'single_elim';
export type MatchStatus = 'waiting' | 'queued' | 'assigned' | 'in_progress' | 'completed' | 'cancelled';
/** 'medal': straight to the medal matches, seeds 1 v 2 for gold and 3 v 4 for bronze. */
export type BracketType = 'single' | 'double' | 'medal';
/** How pool play is drawn: everyone in a pool plays each other, or Swiss rounds. */
export type PoolPlay = 'round_robin' | 'swiss';
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
  | 'division_not_started'
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
  /** Minutes after a division starts for its teams to check in before they forfeit; null = never. */
  checkin_grace_minutes: number | null;
  overdue_after_minutes: number;
  match_slot_minutes: number;
  auto_assign: boolean;
  /** The registration fee, once per player (the regular price, after any price schedule). */
  entry_fee_cents: number;
  /** The fee for each event (the regular price). */
  extra_event_fee_cents: number;
  /** The registration fee covers one event whose division allows it (events.included_in_registration). */
  first_event_included: boolean;
  /** Prices that step up on dates; the regular price applies after the last. */
  price_schedule: PriceStep[];
  /** Registration reopened by a director while the tournament is live. */
  registration_reopened: boolean;
  /** Where players reach the organizer (Contact on the tournament's pages). */
  contact_email: string | null;
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
  /** Shown before players register and before they withdraw. */
  refund_policy: string | null;
  /** More about the event, on the tournament page. */
  details: string | null;
  /** A short notice for last-minute changes, at the top of the tournament's pages; announcement_at is when it changed. */
  announcement: string | null;
  announcement_at: string | null;
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

/** A tournament that takes sign-ups on another site, listed so players can find it. */
export interface TournamentListing {
  id: string;
  name: string;
  starts_on: string;
  /** Null for a one-day tournament. */
  ends_on: string | null;
  /** The listing shows until this day is over. */
  last_day: string;
  venue: string | null;
  city: string;
  /** Two-letter code, e.g. 'TX'. */
  state: string;
  signup_url: string;
  /** A logo or flyer as a data URL. */
  image_data: string | null;
  refund_policy: string | null;
  created_by: string;
  created_at: string;
}

export type ListingFields = Pick<
  TournamentListing,
  'name' | 'starts_on' | 'ends_on' | 'venue' | 'city' | 'state' | 'signup_url' | 'image_data' | 'refund_policy'
>;

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
    /** Agreed to the Terms of Service and Privacy Policy (required unless a director registers them). */
    terms_accepted?: boolean;
    answers?: { question_id: string; answer: string | string[] }[];
  };
  entries: { event_id: string; partner_name?: string; partner_email?: string; pay_for_partner?: boolean }[];
}

/** What a player sees about their own registration. */
export interface RegistrationView {
  id: string;
  tournament_id: string;
  tournament_name: string;
  tournament_status: TournamentStatus;
  refund_policy: string | null;
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
    /** What this player paid toward their partner's entry here. */
    partner_paid_cents: number;
    /** That partner has registered (so their entry fee is used). */
    partner_registered: boolean;
    /** Who paid this player's entry, if their partner did. */
    paid_by_name: string | null;
  }[];
  withdrawals: {
    event_name: string;
    withdrawn_at: string;
    withdrawn_by: 'player' | 'director';
    credit_cents: number;
    partner_paid_cents: number;
  }[];
  answers: { label: string; answer: string[] }[];
  /** Null until they've paid anything. */
  balance: Omit<PlayerBalance, 'tournament_id' | 'player_id'> | null;
  /** What withdrawing from one event (not the last) credits. */
  extra_event_fee_cents: number;
}

export type LedgerKind = 'entry_fees' | 'discount' | 'payment' | 'withdrawal' | 'refund' | 'fee' | 'credit';
export type PaymentMethod = 'stripe' | 'test' | 'cash' | 'check' | 'other';

/** One money event for a player (ledger_entries). Positive adds to what they owe. */
export interface LedgerEntry {
  id: number;
  tournament_id: string;
  player_id: string;
  registration_id: string | null;
  event_id: string | null;
  kind: LedgerKind;
  amount_cents: number;
  method: PaymentMethod | null;
  /** The Stripe Checkout session, for checkout payments. */
  payment_ref: string | null;
  note: string | null;
  created_at: string;
}

/** player_balances: amounts are positive; balance_cents > 0 the player owes, < 0 the tournament owes them. */
export interface PlayerBalance {
  tournament_id: string;
  player_id: string;
  entry_fees_cents: number;
  discount_cents: number;
  paid_cents: number;
  withdrawal_credit_cents: number;
  refunded_cents: number;
  fees_cents: number;
  credits_cents: number;
  balance_cents: number;
}

/** withdrawal_details: an entry a player (or an admin) withdrew. */
export interface WithdrawalRow {
  id: number;
  registration_id: string;
  event_id: string | null;
  event_name: string;
  partner_name: string | null;
  team_name: string | null;
  was_waitlisted: boolean;
  withdrawn_by: 'player' | 'director';
  credit_cents: number;
  withdrawn_at: string;
  tournament_id: string;
  player_id: string;
  status: RegistrationView['status'];
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  partner_paid_cents: number;
  cover_credit_cents: number;
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
  partner_paid_cents: number;
  partner_registered: boolean;
  paid_by_registration_id: string | null;
  paid_by_cents: number;
  paid_by_name: string | null;
}

/** A tournament's own question at registration. */
export interface RegistrationQuestion {
  id: string;
  tournament_id: string;
  label: string;
  /** text: a short answer; choice: one option; choices: any of them. */
  kind: 'text' | 'choice' | 'choices';
  options: string[];
  required: boolean;
  sort_order: number;
}

export interface RegistrationAnswer {
  registration_id: string;
  question_id: string;
  answer: string[];
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
  started_at: string | null;
  no_shows: number;
}

/** start_event's result. */
export interface StartedEvent {
  not_checked_in: number;
  /** Teams not checked in moved to their pool's round-1 sit-out. */
  sitting_out: number;
  /** When teams still not checked in forfeit; null when the tournament doesn't forfeit them. */
  deadline: string | null;
}

export type MessageScope = 'player' | 'team' | 'event' | 'everyone' | 'not_checked_in';

/** Prices through the end of `through` (YYYY-MM-DD) in the tournament's time zone. */
export interface PriceStep {
  through: string;
  registration_cents: number;
  event_cents: number;
}

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
  /** A director reviewed pool play and finalized it, seeding the bracket (finalize_pool_play). */
  pools_finalized_at: string | null;
  /** When a director started the division (start_event); its matches go on court only after. */
  started_at: string | null;
  /** When a director marked the results final (finalize_event): scores are locked and it can go to DUPR. */
  finalized_at: string | null;
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
  /** The gold and bronze matches' expected minutes; null = bracket_match_minutes. */
  gold_match_minutes: number | null;
  bronze_match_minutes: number | null;
  rating_tolerance: number;
  play_up_limit: number | null;
  require_dupr_id: boolean;
  /** Results go to DUPR (Results to DUPR leaves the rest out). */
  dupr_rated: boolean;
  /** Can be the event the registration fee covers (when the tournament includes one). */
  included_in_registration: boolean;
  /** Shown to its players on the division's player guide. */
  player_notes: string | null;
  /** Timeouts each team gets per game, and how long each lasts. */
  timeouts_per_game: number;
  timeout_minutes: number;
  team_rating_max: number | null;
  team_age_min: number | null;
  /** Round robin: stop after this many rounds (null = everyone plays everyone). Swiss: the number of rounds. */
  max_rounds: number | null;
  pool_play: PoolPlay;
  /** Teams in the bracket; null = pool_count × advance_per_pool. */
  bracket_size: number | null;
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
  /** Missed check-in after the division started: its matches are forfeited until it checks in. */
  no_show_at: string | null;
  created_at: string;
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
  round_key: RoundKey | null;
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
  stage: 'pool' | 'bracket';
  round_key: RoundKey;
}

/** A free championship court kept for a championship match about to be ready. */
export interface ChampionshipHold {
  court_id: string;
  court_name: string;
  match_id: string;
  event_name: string;
  label: string;
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
