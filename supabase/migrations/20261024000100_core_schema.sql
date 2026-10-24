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
-- completed:   score reported (or forfeit)
create type public.match_status as enum ('waiting', 'queued', 'assigned', 'in_progress', 'completed');

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
  -- Bracket scoring when it differs from pool play (null = same as pools).
  playoff_games_to int check (playoff_games_to in (11, 15, 21)),
  playoff_best_of int check (playoff_best_of in (1, 3)),
  -- Matches in this event are not put on a court before this time.
  not_before timestamptz,
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
  dupr_id text,
  dupr_doubles numeric(4, 3),
  dupr_singles numeric(4, 3),
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

create table public.courts (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  -- Paused by the director: nothing new is sent here.
  out_of_service boolean not null default false,
  -- Removed from this tournament but kept for match history.
  retired_at timestamptz,
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
  unique (event_id, stage, pool, round, position),
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

-- Outbox for texts and push notifications. A sender (Twilio now, Firebase
-- push later) picks up unsent rows and decides the channel per player.
create table public.notifications (
  id bigint generated always as identity primary key,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  match_id uuid references public.matches (id) on delete cascade,
  kind text not null,
  body text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  channel text,
  error text
);
create index notifications_unsent on public.notifications (created_at) where sent_at is null;

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
language plpgsql set search_path = '' as $$
begin
  insert into public.tournament_live (tournament_id) values (new.id);
  return null;
end $$;

create trigger tournaments_create_live after insert on public.tournaments
  for each row execute function private.tournaments_create_live();

-- Update only: during a cascade delete the tournament_live row is already gone.
create function private.bump_tournament_live() returns trigger
language plpgsql set search_path = '' as $$
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
language plpgsql set search_path = '' as $$
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
