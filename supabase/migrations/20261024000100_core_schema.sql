-- Core data. One platform, many tournament directors: every tournament
-- belongs to an organization (a club, gym or TD), and organization members
-- run its tournaments.
--
-- Every rule that changes tournament state lives in database functions (see
-- the court_engine migration) so the website and the Kotlin apps share one
-- source of truth.

create schema if not exists private;

create type public.tournament_status as enum ('draft', 'registration', 'live', 'complete');
create type public.event_kind as enum ('doubles', 'singles');
-- round_robin:      one or more pools, everyone in a pool plays each other
-- pools_to_bracket: pools, then the top advance_per_pool from each pool play a bracket
-- single_elim:      seeded bracket only
create type public.event_format as enum ('round_robin', 'pools_to_bracket', 'single_elim');
create type public.match_stage as enum ('pool', 'bracket');
-- waiting:     at least one team still unknown (bracket feeder not finished)
-- queued:      both teams known, in the queue for a court
-- assigned:    on a court, players notified, waiting for "we're here"
-- in_progress: players confirmed on court
-- completed:   score reported (or forfeit, or a bye)
-- cancelled:   not played: pool play ended early, or a grand-final reset
--              that wasn't needed
create type public.match_status as enum ('waiting', 'queued', 'assigned', 'in_progress', 'completed', 'cancelled');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'director' check (role in ('owner', 'admin', 'director')),
  primary key (organization_id, user_id)
);
create index on public.organization_members (user_id);

create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  starts_on date not null,
  time_zone text not null default 'America/New_York',
  status public.tournament_status not null default 'draft',
  min_rest_minutes int not null default 10 check (min_rest_minutes >= 0),
  no_show_minutes int not null default 10 check (no_show_minutes > 0),
  -- A team's next match that has been ready this long holds its players, so
  -- other events stop taking them (see private.plan_queue). 45 cut the worst
  -- in-event wait from ~4 hours to ~2 in the 200-player simulation.
  overdue_after_minutes int not null default 45 check (overdue_after_minutes > 0),
  -- Typical match length. The queue is ordered by each match's expected start
  -- (event start + wave x this), so later-starting events slot in sensibly.
  match_slot_minutes int not null default 20 check (match_slot_minutes > 0),
  -- Off = paused: nothing is sent to courts until the director turns it back on.
  auto_assign boolean not null default true,
  -- Optional live stream for the whole event (YouTube link).
  stream_url text,
  -- Registration prices, all-in (processing and texting costs baked in).
  -- The early prices apply until early_until.
  entry_fee_cents int not null default 0 check (entry_fee_cents >= 0),
  extra_event_fee_cents int not null default 0 check (extra_event_fee_cents >= 0),
  early_entry_fee_cents int check (early_entry_fee_cents >= 0),
  early_extra_event_fee_cents int check (early_extra_event_fee_cents >= 0),
  early_until timestamptz,
  -- Kept from a refund to cover processing fees.
  refund_fee_cents int not null default 500 check (refund_fee_cents >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.tournaments (organization_id);
create index tournaments_live on public.tournaments (id) where status = 'live';

-- Extra staff for one tournament (organization members are staff for all of
-- the organization's tournaments).
create table public.tournament_staff (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (tournament_id, user_id)
);
create index on public.tournament_staff (user_id);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  name text not null,
  kind public.event_kind not null default 'doubles',
  format public.event_format not null default 'round_robin',
  pool_count int not null default 1 check (pool_count between 1 and 26),
  advance_per_pool int not null default 2 check (advance_per_pool >= 1),
  games_to int not null default 11 check (games_to in (11, 15, 21)),
  best_of int not null default 1 check (best_of in (1, 3)),
  -- Hard cap: the game ends when a team reaches this, even by 1 point (to 11
  -- cap 13: 13-12 is final). Null = no cap, win by 2. Used to flag unusual
  -- scores at entry; any finished score is accepted.
  point_cap int check (point_cap is null or point_cap >= games_to),
  -- Bracket scoring when it differs from pool play (null = same as pools).
  playoff_games_to int check (playoff_games_to in (11, 15, 21)),
  playoff_best_of int check (playoff_best_of in (1, 3)),
  playoff_point_cap int,
  -- Matches in this event are not put on a court before this time.
  not_before timestamptz,
  -- Who can enter (checked at registration; see private.entry_problem).
  -- Gender: open, mens, womens, or mixed (one man and one woman).
  gender text not null default 'open' check (gender in ('open', 'mens', 'womens', 'mixed')),
  -- Every player must be within the age range, counted on tournament day or
  -- on December 31 of the tournament's year.
  min_age int check (min_age >= 0),
  max_age int check (max_age >= min_age),
  age_basis text not null default 'tournament_day' check (age_basis in ('tournament_day', 'year_end')),
  -- Skill, like PickleballTournaments.com: 3.5 'only' = 3.50-3.99,
  -- 'and_under' = below 4.0, 'and_above' = 3.50 up, 'range' 3.0 to 4.0 =
  -- 3.00-4.49, 'open' = anyone. Nobody may play down; allow_play_up lets
  -- players rated below the level enter.
  skill_rule text not null default 'open' check (skill_rule in ('open', 'only', 'and_under', 'and_above', 'range')),
  skill_level numeric(3, 1) check (skill_rule = 'open' or skill_level is not null),
  skill_level_to numeric(3, 1) check (skill_rule <> 'range' or skill_level_to >= skill_level),
  rating_source text not null default 'dupr_or_self' check (rating_source in ('dupr', 'dupr_or_self')),
  allow_play_up boolean not null default false,
  max_teams int check (max_teams > 0),
  -- Off: players may register without a partner and the desk pairs them.
  partner_required boolean not null default true,
  -- Fine-tuning the rating rule. rating_tolerance: how far over the top a
  -- player may be (0.25 lets a 4.20 into 3.5–4.0). play_up_limit: with
  -- allow_play_up, how far under the bottom (null = any).
  rating_tolerance numeric(3, 2) not null default 0 check (rating_tolerance >= 0),
  play_up_limit numeric(3, 2) check (play_up_limit >= 0),
  -- Every player must give a DUPR ID (needed to submit results to DUPR).
  require_dupr_id boolean not null default false,
  -- Doubles: the two players' ratings added together must be under this
  -- (e.g. 7.5), and/or their ages must add up to at least this (e.g. 110).
  team_rating_max numeric(4, 2),
  team_age_min int check (team_age_min > 0),
  -- Round robin: stop after this many rounds (an 8-team pool can play 6
  -- rounds instead of 7). Null = everyone plays everyone.
  max_rounds int check (max_rounds > 0),
  -- Bracket stage: single or double elimination.
  bracket_type text not null default 'single' check (bracket_type in ('single', 'double')),
  -- Single elimination: semifinal losers play for bronze.
  third_place_match boolean not null default false,
  -- Double elimination: if the losers-bracket team wins the grand final,
  -- a second (reset) final decides it.
  grand_final_reset boolean not null default false,
  -- Hold the bracket after seeding so the director can rearrange seeds,
  -- then start it (start_bracket).
  confirm_seeds boolean not null default false,
  -- Game format per bracket round, overriding the event's playoff format:
  -- [{"key": "final", "games_to": 15, "best_of": 3, "point_cap": null}, ...].
  -- Keys: final, semifinal, quarterfinal, earlier, bronze, winners, losers,
  -- grand_final.
  round_formats jsonb not null default '[]'::jsonb,
  -- Order of events within a queue wave; set automatically when left null.
  sort_order int,
  playoffs_seeded_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.events (tournament_id);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete set null,
  first_name text not null,
  last_name text not null,
  email text,
  phone text, -- E.164, e.g. +15551234567
  sms_opt_in boolean not null default false,
  -- For gender and age divisions.
  gender text check (gender in ('male', 'female')),
  birth_date date,
  dupr_id text,
  dupr_doubles numeric(4, 3),
  dupr_singles numeric(4, 3),
  -- Used when an event accepts self-ratings and the player has no DUPR.
  self_rating numeric(3, 2),
  added_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  -- Copied from the event by trigger, for per-tournament queries and filters.
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  -- Public display name, e.g. "Davis/Lee". Player contact details stay private.
  name text not null,
  seed int,
  -- 1 = Pool A. Set when matches are generated.
  pool int,
  checked_in_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.teams (event_id);
create index on public.teams (tournament_id);

create table public.team_players (
  team_id uuid not null references public.teams (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete restrict,
  primary key (team_id, player_id)
);
create index on public.team_players (player_id);

-- Who has arrived. A team is ready (teams.checked_in_at) once all of its
-- players are in; see private.sync_team_checkins.
create table public.player_checkins (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  checked_in_at timestamptz not null default now(),
  primary key (tournament_id, player_id)
);

create table public.courts (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  -- Paused by the director: nothing new is sent here.
  out_of_service boolean not null default false,
  -- Removed from this tournament but kept for match history.
  retired_at timestamptz,
  -- YouTube link for this court's stream.
  stream_url text,
  unique (tournament_id, name)
);
create index on public.courts (tournament_id);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  stage public.match_stage not null default 'pool',
  pool int not null default 0, -- 0 for bracket matches
  round int not null,
  position int not null,
  label text,
  team1_id uuid references public.teams (id) on delete set null,
  team2_id uuid references public.teams (id) on delete set null,
  -- Bracket seed that fills each slot (shown as "Seed 3" until it's known).
  team1_seed int,
  team2_seed int,
  winner_to_match_id uuid references public.matches (id) on delete set null,
  winner_to_slot smallint check (winner_to_slot in (1, 2)),
  -- Matches play in waves: every event's round 1, then every round 2, ...
  wave int not null,
  -- Place in the court queue (lowest first). Directors can reorder it.
  queue_seq numeric not null,
  on_hold boolean not null default false,
  status public.match_status not null default 'waiting',
  court_id uuid references public.courts (id) on delete set null,
  queued_at timestamptz,
  assigned_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  -- Game scores with team 1 first, e.g. [[11, 7], [9, 11], [11, 5]].
  games jsonb,
  winner_team_id uuid references public.teams (id) on delete set null,
  forfeit boolean not null default false,
  -- main (pools, single elimination, the winners bracket), losers (double
  -- elimination), final (grand final, bronze).
  side text not null default 'main' check (side in ('main', 'losers', 'final')),
  -- Which round format applies (see events.round_formats): pool, final,
  -- semifinal, quarterfinal, earlier, bronze, winners, losers, grand_final.
  round_key text not null default 'pool',
  -- Double elimination / bronze: where the loser goes.
  loser_to_match_id uuid references public.matches (id) on delete set null,
  loser_to_slot smallint check (loser_to_slot in (1, 2)),
  -- A bye fills a slot when the bracket isn't a power of two. A match with a
  -- bye completes by itself (is_bye) and isn't shown as played.
  team1_bye boolean not null default false,
  team2_bye boolean not null default false,
  is_bye boolean not null default false,
  -- Private code in the text players get; the link lets them report the
  -- score without an account. 40 random bits.
  report_code text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
  unique (event_id, stage, side, pool, round, position),
  check (team1_id is null or team1_id is distinct from team2_id),
  check (status not in ('assigned', 'in_progress') or court_id is not null)
);
create index on public.matches (tournament_id, status, queue_seq);
create index on public.matches (event_id);
create index on public.matches (team1_id);
create index on public.matches (team2_id);
create index on public.matches (winner_to_match_id);
-- A court can only hold one live match.
create unique index matches_one_live_match_per_court
  on public.matches (court_id) where status in ('assigned', 'in_progress');

-- Outbox for texts and push notifications. The sender (web/src/server/texts.ts:
-- Twilio, or a test log) claims unsent rows, fills in the score link, and
-- records what happened.
create table public.notifications (
  id bigint generated always as identity primary key,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  match_id uuid references public.matches (id) on delete cascade,
  kind text not null,
  via text not null default 'sms' check (via in ('sms', 'email')),
  subject text,
  -- May contain {url}, replaced with the match's score link when sent.
  body text not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  -- How it went out: 'sms' / 'email' (real), 'log' (test mode), 'none'
  -- (no phone or email, or not opted in to texts).
  channel text,
  to_phone text,
  to_email text,
  sent_body text,
  -- Twilio's message id and its latest delivery report (queued, sent,
  -- delivered, undelivered, failed).
  provider_id text,
  delivery_status text,
  error text
);
create index notifications_unsent on public.notifications (created_at) where claimed_at is null;

-- One row per tournament whose revision goes up on every change. Screens
-- subscribe to this single row over Realtime and refetch, instead of
-- subscribing to every table.
create table public.tournament_live (
  tournament_id uuid primary key references public.tournaments (id) on delete cascade,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Bookkeeping triggers
-- ---------------------------------------------------------------------------

create function private.teams_set_tournament() returns trigger
language plpgsql set search_path = '' as $$
begin
  select e.tournament_id into new.tournament_id from public.events e where e.id = new.event_id;
  return new;
end $$;

create trigger teams_set_tournament
  before insert or update of event_id on public.teams
  for each row execute function private.teams_set_tournament();

create function private.events_set_sort_order() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.sort_order is null then
    select coalesce(max(e.sort_order), 0) + 1 into new.sort_order
    from public.events e where e.tournament_id = new.tournament_id;
  end if;
  return new;
end $$;

create trigger events_set_sort_order
  before insert on public.events
  for each row execute function private.events_set_sort_order();

create function private.tournaments_create_live() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.tournament_live (tournament_id) values (new.id);
  return null;
end $$;

create trigger tournaments_create_live after insert on public.tournaments
  for each row execute function private.tournaments_create_live();

-- These run as the owner: directors edit tournaments, events, teams and courts
-- directly, but can't write tournament_live themselves.
-- Update only: during a cascade delete the tournament_live row is already gone.
create function private.bump_tournament_live() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tournament uuid;
begin
  if tg_op = 'DELETE' then
    v_tournament := old.tournament_id;
  else
    v_tournament := new.tournament_id;
  end if;
  update public.tournament_live
  set revision = revision + 1, updated_at = now()
  where tournament_id = v_tournament;
  return null;
end $$;

create function private.tournaments_bump_live() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.tournament_live
  set revision = revision + 1, updated_at = now()
  where tournament_id = new.id;
  return null;
end $$;

create trigger tournaments_bump_live after update on public.tournaments
  for each row execute function private.tournaments_bump_live();
create trigger matches_bump_live after insert or update or delete on public.matches
  for each row execute function private.bump_tournament_live();
create trigger courts_bump_live after insert or update or delete on public.courts
  for each row execute function private.bump_tournament_live();
create trigger teams_bump_live after insert or update or delete on public.teams
  for each row execute function private.bump_tournament_live();
create trigger events_bump_live after insert or update or delete on public.events
  for each row execute function private.bump_tournament_live();
create trigger player_checkins_bump_live after insert or update or delete on public.player_checkins
  for each row execute function private.bump_tournament_live();
