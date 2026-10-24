// Row shapes of the tables and views the screens read. See docs/api.md.

export type TournamentStatus = 'draft' | 'registration' | 'live' | 'complete';
export type EventFormat = 'round_robin' | 'pools_to_bracket' | 'single_elim';
export type MatchStatus = 'waiting' | 'queued' | 'assigned' | 'in_progress' | 'completed';
export type BlockedReason =
  | 'on_hold'
  | 'event_not_started'
  | 'not_checked_in'
  | 'player_on_court'
  | 'resting'
  | 'player_needed_elsewhere'
  | null;

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
  min_rest_minutes: number;
  no_show_minutes: number;
  overdue_after_minutes: number;
  match_slot_minutes: number;
  auto_assign: boolean;
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
  playoff_games_to: number | null;
  playoff_best_of: number | null;
  not_before: string | null;
  sort_order: number;
  playoffs_seeded_at: string | null;
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
}

export interface MatchDetails {
  id: string;
  tournament_id: string;
  event_id: string;
  event_name: string;
  event_format: EventFormat;
  stage: 'pool' | 'bracket';
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
  points_for: number;
  points_against: number;
  point_diff: number;
  wins_vs_tied: number;
  pool_rank: number;
}
