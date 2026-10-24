-- The court engine: an ordered queue of matches that keeps every court full.
--
-- Generating an event puts its matches in the queue in waves (every event's
-- round 1, then every round 2, ...). Whenever a court is free, the engine walks
-- the queue from the top and sends the first playable matches out. A score
-- report frees the court and the next playable match is pulled. Directors can
-- reorder the queue, hold matches, send a match to a specific court, swap
-- courts, pause courts or the whole tournament, and change the court count.
--
-- A queued match is playable when it isn't on hold, its event has started,
-- both teams are checked in, none of its players is on another court, and
-- every player has rested min_rest_minutes. Matches that aren't playable stay
-- in place and are skipped until they are.
--
-- Overdue holds: a doubles match needs four players free at once, while a
-- match in another event may share only one of them, so it can starve (a
-- pool's last match waits all afternoon while its players keep getting called
-- to mixed). Once a team's next match has been ready in its event for
-- overdue_after_minutes, it holds its players: matches further down the queue
-- can't take them until it has been played.
--
-- Public functions are the API the website and the mobile apps call
-- (supabase.rpc(...)). They check permissions themselves and run as the
-- table owner. Helpers live in the private schema, which the API doesn't
-- expose. See docs/api.md.

-- ---------------------------------------------------------------------------
-- Clock
-- ---------------------------------------------------------------------------

-- All engine timestamps come from here so the simulator can run a full
-- tournament in seconds. Only a direct SQL session can set engine.sim_now;
-- API clients can't, so production always uses now().
create function private.clock() returns timestamptz
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('engine.sim_now', true), '')::timestamptz, now())
$$;

-- ---------------------------------------------------------------------------
-- Permissions and locking
-- ---------------------------------------------------------------------------

create function public.is_organization_member(p_organization uuid, p_roles text[] default null)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members om
    where om.organization_id = p_organization and om.user_id = auth.uid()
      and (p_roles is null or om.role = any (p_roles))
  )
$$;

-- Staff = members of the tournament's organization, plus anyone added to
-- tournament_staff for this one tournament.
create function public.is_tournament_staff(p_tournament uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tournament_staff s
    where s.tournament_id = p_tournament and s.user_id = auth.uid()
  ) or exists (
    select 1 from public.tournaments t
    join public.organization_members om on om.organization_id = t.organization_id
    where t.id = p_tournament and om.user_id = auth.uid()
  )
$$;

create function private.plays_in_match(p_match uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1
    from public.matches m
    join public.team_players tp on tp.team_id in (m.team1_id, m.team2_id)
    join public.players p on p.id = tp.player_id
    where m.id = p_match and p.user_id = auth.uid()
  )
$$;

create function private.plays_on_team(p_team uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1
    from public.team_players tp
    join public.players p on p.id = tp.player_id
    where tp.team_id = p_team and p.user_id = auth.uid()
  )
$$;

create function private.require_staff(p_tournament uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if not public.is_tournament_staff(p_tournament) then
    raise exception 'Only tournament staff can do this' using errcode = '42501';
  end if;
end $$;

-- Every engine change for a tournament takes this row lock first, so score
-- reports, check-ins, queue edits and assignment runs never race each other.
create function private.lock_tournament(p_tournament uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform 1 from public.tournaments where id = p_tournament for update;
  if not found then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
end $$;

create function private.lock_match(p_match uuid) returns public.matches
language plpgsql set search_path = '' as $$
declare
  v_tournament uuid;
  m public.matches;
begin
  select tournament_id into v_tournament from public.matches where id = p_match;
  if v_tournament is null then
    raise exception 'Match not found' using errcode = 'P0002';
  end if;
  perform private.lock_tournament(v_tournament);
  select * into m from public.matches where id = p_match for update;
  return m;
end $$;

-- ---------------------------------------------------------------------------
-- Queue order
-- ---------------------------------------------------------------------------

-- Default place in the queue: the match's expected start (its event's start
-- time + wave x match_slot_minutes), then event order, pool and position. An
-- event without a start time counts from the tournament's earliest one.
-- Directors' moves put a match between two others, so queue_seq is numeric.
create function private.default_queue_seq(p_event uuid, p_wave int, p_pool int, p_position int)
returns numeric
language sql stable set search_path = '' as $$
  select (floor(extract(epoch from coalesce(
            e.not_before,
            (select min(e2.not_before) from public.events e2 where e2.tournament_id = e.tournament_id),
            t.starts_on::timestamp at time zone t.time_zone)) / 60)
          + p_wave * t.match_slot_minutes) * 1000000::numeric
         + coalesce(e.sort_order, 0) * 1000 + p_pool * 36 + p_position
  from public.events e
  join public.tournaments t on t.id = e.tournament_id
  where e.id = p_event
$$;

-- A match joins the queue as soon as both of its teams are known.
create function private.matches_set_queue_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'waiting' and new.team1_id is not null and new.team2_id is not null then
    new.status := 'queued';
    new.queued_at := private.clock();
  end if;
  return new;
end $$;

create trigger matches_set_queue_status
  before insert or update of team1_id, team2_id, status on public.matches
  for each row execute function private.matches_set_queue_status();

-- ---------------------------------------------------------------------------
-- Scoring
-- ---------------------------------------------------------------------------

-- Checks a list of game scores and returns the winning slot (1 or 2).
-- Games go to games_to, win by 2: 11-9 and 13-11 are valid, 11-10 and 14-11 aren't.
create function private.match_winner_slot(p_games jsonb, p_games_to int, p_best_of int)
returns smallint
language plpgsql immutable set search_path = '' as $$
declare
  v_game jsonb;
  v_a int;
  v_b int;
  v_wins1 int := 0;
  v_wins2 int := 0;
  v_needed int := p_best_of / 2 + 1;
  v_number int := 0;
begin
  if p_games is null or jsonb_typeof(p_games) <> 'array' or jsonb_array_length(p_games) = 0 then
    raise exception 'Enter at least one game score' using errcode = '22023';
  end if;

  for v_game in select value from jsonb_array_elements(p_games) loop
    v_number := v_number + 1;
    if v_wins1 = v_needed or v_wins2 = v_needed then
      raise exception 'Game % was entered after the match was already won', v_number using errcode = '22023';
    end if;
    if jsonb_typeof(v_game) <> 'array' or jsonb_array_length(v_game) <> 2
       or jsonb_typeof(v_game -> 0) <> 'number' or jsonb_typeof(v_game -> 1) <> 'number' then
      raise exception 'Game % must be two scores, like [11, 7]', v_number using errcode = '22023';
    end if;
    v_a := (v_game ->> 0)::int;
    v_b := (v_game ->> 1)::int;
    if v_a < 0 or v_b < 0
       or greatest(v_a, v_b) < p_games_to
       or abs(v_a - v_b) < 2
       or (greatest(v_a, v_b) > p_games_to and abs(v_a - v_b) <> 2) then
      raise exception 'Game %: %-% is not a finished game to % (win by 2)', v_number, v_a, v_b, p_games_to
        using errcode = '22023';
    end if;
    if v_a > v_b then
      v_wins1 := v_wins1 + 1;
    else
      v_wins2 := v_wins2 + 1;
    end if;
  end loop;

  if v_wins1 < v_needed and v_wins2 < v_needed then
    raise exception 'Best of % needs % game wins', p_best_of, v_needed using errcode = '22023';
  end if;
  return case when v_wins1 = v_needed then 1 else 2 end;
end $$;

-- The winning team for p_games, using pool or playoff scoring for the stage.
create function private.score_winner(m public.matches, p_games jsonb) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  e public.events;
  v_games_to int;
  v_best_of int;
begin
  select * into e from public.events where id = m.event_id;
  v_games_to := e.games_to;
  v_best_of := e.best_of;
  if m.stage = 'bracket' then
    v_games_to := coalesce(e.playoff_games_to, e.games_to);
    v_best_of := coalesce(e.playoff_best_of, e.best_of);
  end if;
  if private.match_winner_slot(p_games, v_games_to, v_best_of) = 1 then
    return m.team1_id;
  end if;
  return m.team2_id;
end $$;

create function private.place_in_slot(p_match uuid, p_slot smallint, p_team uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if p_slot = 1 then
    update public.matches set team1_id = p_team where id = p_match;
  else
    update public.matches set team2_id = p_team where id = p_match;
  end if;
end $$;

create function private.finish_match(p_match uuid, p_winner uuid, p_games jsonb, p_forfeit boolean)
returns void
language plpgsql set search_path = '' as $$
declare
  m public.matches;
begin
  update public.matches
  set status = 'completed', winner_team_id = p_winner, games = p_games,
      forfeit = p_forfeit, completed_at = private.clock(), on_hold = false
  where id = p_match
  returning * into m;

  if m.winner_to_match_id is not null then
    perform private.place_in_slot(m.winner_to_match_id, m.winner_to_slot, p_winner);
  end if;
  if m.stage = 'pool' then
    perform private.seed_playoffs_when_pools_done(m.event_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Assignment
-- ---------------------------------------------------------------------------

-- Every queued match in a tournament, with the reason it can't go on a court
-- yet (null when it can) and whether it's overdue. Holds are applied on top
-- of this by plan_queue.
create function private.match_candidates(p_tournament uuid, p_now timestamptz)
returns table (
  match_id uuid,
  blocked_reason text,
  overdue boolean,
  waiting_since timestamptz,
  queue_seq numeric,
  player_ids uuid[]
)
language sql stable set search_path = '' as $$
  with player_state as (
    select tp.player_id,
           bool_or(m.status in ('assigned', 'in_progress')) as busy,
           -- Forfeited matches weren't played, so they don't need rest.
           max(m.completed_at) filter (where not m.forfeit) as last_finished_at
    from public.matches m
    join public.team_players tp on tp.team_id in (m.team1_id, m.team2_id)
    where m.tournament_id = p_tournament and m.status in ('assigned', 'in_progress', 'completed')
    group by tp.player_id
  ),
  team_state as (
    select t.id as team_id,
           t.checked_in_at is not null and t.withdrawn_at is null as ready,
           coalesce(bool_or(ps.busy), false) as busy,
           max(ps.last_finished_at) as last_finished_at,
           greatest(t.checked_in_at, max(ps.last_finished_at)) as free_since,
           -- When the team last became free to play in its own event.
           greatest(t.checked_in_at, (
             select max(m2.completed_at) from public.matches m2
             where m2.event_id = t.event_id and t.id in (m2.team1_id, m2.team2_id) and not m2.forfeit
           )) as event_free_since
    from public.teams t
    left join public.team_players tp on tp.team_id = t.id
    left join player_state ps on ps.player_id = tp.player_id
    where t.tournament_id = p_tournament
    group by t.id
  )
  select m.id,
         case
           when m.on_hold then 'on_hold'
           when e.not_before > p_now then 'event_not_started'
           when not (t1.ready and t2.ready) then 'not_checked_in'
           when t1.busy or t2.busy then 'player_on_court'
           when greatest(t1.last_finished_at, t2.last_finished_at)
                > p_now - make_interval(mins => tn.min_rest_minutes) then 'resting'
         end,
         not m.on_hold and coalesce(e.not_before <= p_now, true) and t1.ready and t2.ready
           and greatest(t1.event_free_since, t2.event_free_since, e.not_before)
               <= p_now - make_interval(mins => tn.overdue_after_minutes)
           -- Only a team's next match in the event can be overdue; holding
           -- players for every pending pool round would freeze the pool.
           and not exists (
             select 1 from public.matches m3
             where m3.event_id = m.event_id and m3.status = 'queued' and m3.wave < m.wave
               and (m3.team1_id in (m.team1_id, m.team2_id) or m3.team2_id in (m.team1_id, m.team2_id))
           ),
         least(t1.free_since, t2.free_since),
         m.queue_seq,
         array(select tp.player_id from public.team_players tp where tp.team_id in (m.team1_id, m.team2_id))
  from public.matches m
  join public.tournaments tn on tn.id = m.tournament_id
  join public.events e on e.id = m.event_id
  join team_state t1 on t1.team_id = m.team1_id
  join team_state t2 on t2.team_id = m.team2_id
  where m.tournament_id = p_tournament and m.status = 'queued'
$$;

-- The queue top to bottom, as the engine will use it. A match whose players
-- are all free still waits (player_needed_elsewhere) when a match above it
-- will take one of them, or an overdue match above it is holding one.
create function private.plan_queue(p_tournament uuid, p_now timestamptz)
returns table (
  match_id uuid,
  blocked_reason text,
  overdue boolean,
  waiting_since timestamptz,
  queue_rank int
)
language plpgsql stable set search_path = '' as $$
declare
  v_claimed uuid[] := '{}';
  c record;
begin
  queue_rank := 0;
  for c in
    select * from private.match_candidates(p_tournament, p_now) mc
    order by mc.queue_seq, mc.match_id
  loop
    queue_rank := queue_rank + 1;
    match_id := c.match_id;
    overdue := c.overdue;
    waiting_since := c.waiting_since;
    blocked_reason := c.blocked_reason;
    if blocked_reason is null and c.player_ids && v_claimed then
      blocked_reason := 'player_needed_elsewhere';
    end if;
    if blocked_reason is null
       or (c.overdue and c.blocked_reason in ('player_on_court', 'resting')) then
      v_claimed := v_claimed || c.player_ids;
    end if;
    return next;
  end loop;
end $$;

create function private.notify_match_players(p_match uuid, p_kind text) returns void
language sql set search_path = '' as $$
  insert into public.notifications (tournament_id, player_id, match_id, kind, body)
  select m.tournament_id, tp.player_id, m.id, p_kind,
         left(case p_kind
                when 'court_changed' then 'Court change: ' || t1.name || ' vs ' || t2.name || ' now on ' || c.name
                else c.name || ' now: ' || t1.name || ' vs ' || t2.name
              end, 160)
  from public.matches m
  join public.courts c on c.id = m.court_id
  join public.teams t1 on t1.id = m.team1_id
  join public.teams t2 on t2.id = m.team2_id
  join public.team_players tp on tp.team_id in (m.team1_id, m.team2_id)
  where m.id = p_match
$$;

create function private.free_courts(p_tournament uuid) returns uuid[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(c.id order by c.sort_order, c.name), '{}')
  from public.courts c
  where c.tournament_id = p_tournament
    and c.retired_at is null
    and not c.out_of_service
    and not exists (
      select 1 from public.matches m
      where m.court_id = c.id and m.status in ('assigned', 'in_progress')
    )
$$;

-- Sends the top playable matches to every free court. Returns how many.
create function private.run_assignment(p_tournament uuid) returns int
language plpgsql set search_path = '' as $$
declare
  v_now timestamptz := private.clock();
  v_courts uuid[];
  v_match uuid;
  v_assigned int := 0;
begin
  perform private.lock_tournament(p_tournament);
  v_courts := private.free_courts(p_tournament);
  if cardinality(v_courts) = 0 then
    return 0;
  end if;

  for v_match in
    select q.match_id from private.plan_queue(p_tournament, v_now) q
    where q.blocked_reason is null
    order by q.queue_rank
    limit cardinality(v_courts)
  loop
    v_assigned := v_assigned + 1;
    update public.matches
    set status = 'assigned', court_id = v_courts[v_assigned], assigned_at = v_now
    where id = v_match;
    perform private.notify_match_players(v_match, 'court_assigned');
  end loop;
  return v_assigned;
end $$;

-- Runs after every score, check-in and queue or court change in a live,
-- unpaused tournament.
create function private.auto_assign(p_tournament uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from public.tournaments t
    where t.id = p_tournament and t.status = 'live' and t.auto_assign
  ) then
    perform private.run_assignment(p_tournament);
  end if;
end $$;

-- Rest periods and event start times pass without any event to react to, so
-- this runs on a timer (pg_cron, below) to fill courts as soon as they do.
create function private.assign_live_tournaments() returns void
language plpgsql set search_path = '' as $$
declare
  v_tournament uuid;
begin
  for v_tournament in
    select id from public.tournaments where status = 'live' and auto_assign
  loop
    perform private.run_assignment(v_tournament);
  end loop;
end $$;

do $$
begin
  -- pg_cron exists on Supabase; skip it where it doesn't (tests, simulator).
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('assign-live-tournaments', '30 seconds',
                          'select private.assign_live_tournaments()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Match generation
-- ---------------------------------------------------------------------------

-- Splits teams (in seed order) into pools by snake seeding and plays a round
-- robin in each pool (circle method). Returns the number of matches.
create function private.generate_pools(p_event public.events, p_teams uuid[]) returns int
language plpgsql set search_path = '' as $$
declare
  v_pools int := p_event.pool_count;
  v_pool int;
  v_ring uuid[];
  v_size int;
  v_round int;
  v_slot int;
  v_position int;
  v_created int := 0;
begin
  for v_pool in 1 .. v_pools loop
    -- Snake: seeds 1..P go to pools A..P, seeds P+1..2P back from P to A, ...
    v_ring := array(
      select p_teams[i]
      from generate_series(1, cardinality(p_teams)) i
      where case when ((i - 1) / v_pools) % 2 = 0 then (i - 1) % v_pools + 1
                 else v_pools - (i - 1) % v_pools end = v_pool
      order by i
    );
    update public.teams set pool = v_pool where id = any (v_ring);

    if cardinality(v_ring) % 2 = 1 then
      v_ring := array_append(v_ring, null::uuid); -- the team paired with null sits out
    end if;
    v_size := cardinality(v_ring);

    for v_round in 1 .. v_size - 1 loop
      v_position := 0;
      for v_slot in 1 .. v_size / 2 loop
        if v_ring[v_slot] is not null and v_ring[v_size + 1 - v_slot] is not null then
          v_position := v_position + 1;
          insert into public.matches
            (tournament_id, event_id, stage, pool, round, position, label,
             team1_id, team2_id, wave, queue_seq)
          values
            (p_event.tournament_id, p_event.id, 'pool', v_pool, v_round, v_position,
             case when v_pools > 1 then 'Pool ' || chr(64 + v_pool) || ' · Round ' || v_round
                  else 'Round ' || v_round end,
             v_ring[v_slot], v_ring[v_size + 1 - v_slot], v_round,
             private.default_queue_seq(p_event.id, v_round, v_pool, v_position));
          v_created := v_created + 1;
        end if;
      end loop;
      -- Keep the first team fixed and rotate the rest one place.
      v_ring := v_ring[1:1] || v_ring[v_size:v_size] || v_ring[2:v_size - 1];
    end loop;
  end loop;
  return v_created;
end $$;

-- Builds a seeded single-elimination bracket for p_seeds seeds. Top seeds get
-- byes when p_seeds isn't a power of 2. p_teams (in seed order) fills the
-- slots now; pass null when seeds are decided later (pools_to_bracket).
create function private.build_bracket(p_event public.events, p_seeds int, p_teams uuid[], p_wave_offset int)
returns int
language plpgsql set search_path = '' as $$
declare
  v_size int := 1;
  v_rounds int := 0;
  v_order int[] := array[1];
  v_next int[];
  v_seed int;
  v_round int;
  v_position int;
  v_target uuid;
  v_seed1 int;
  v_seed2 int;
  v_created int := 0;
begin
  while v_size < p_seeds loop
    v_size := v_size * 2;
    v_rounds := v_rounds + 1;
  end loop;

  -- Standard seed order, e.g. 8 slots -> 1,8,4,5,2,7,3,6.
  while cardinality(v_order) < v_size loop
    v_next := '{}';
    foreach v_seed in array v_order loop
      v_next := v_next || v_seed || (cardinality(v_order) * 2 + 1 - v_seed);
    end loop;
    v_order := v_next;
  end loop;

  -- Build from the final backwards so each match can point at the next one.
  for v_round in reverse v_rounds .. 1 loop
    for v_position in 1 .. (v_size >> v_round) loop
      v_target := null;
      if v_round < v_rounds then
        select id into v_target from public.matches
        where event_id = p_event.id and stage = 'bracket'
          and round = v_round + 1 and position = (v_position + 1) / 2;
      end if;

      v_seed1 := null;
      v_seed2 := null;
      if v_round = 1 then
        v_seed1 := v_order[2 * v_position - 1];
        v_seed2 := v_order[2 * v_position];
        if v_seed2 > p_seeds then
          -- Bye: the seeded team goes straight into its round-2 match.
          if v_position % 2 = 1 then
            update public.matches set team1_seed = v_seed1, team1_id = p_teams[v_seed1] where id = v_target;
          else
            update public.matches set team2_seed = v_seed1, team2_id = p_teams[v_seed1] where id = v_target;
          end if;
          continue;
        end if;
      end if;

      insert into public.matches
        (tournament_id, event_id, stage, pool, round, position, label,
         team1_seed, team2_seed, team1_id, team2_id,
         winner_to_match_id, winner_to_slot, wave, queue_seq)
      values
        (p_event.tournament_id, p_event.id, 'bracket', 0, v_round, v_position,
         case v_rounds - v_round
           when 0 then 'Final'
           when 1 then 'Semifinal ' || v_position
           when 2 then 'Quarterfinal ' || v_position
           else 'Round of ' || (v_size >> (v_round - 1)) || ' #' || v_position
         end,
         v_seed1, v_seed2, p_teams[v_seed1], p_teams[v_seed2],
         v_target, case when v_target is not null then 2 - v_position % 2 end,
         p_wave_offset + v_round,
         private.default_queue_seq(p_event.id, p_wave_offset + v_round, 0, v_position));
      v_created := v_created + 1;
    end loop;
  end loop;
  return v_created;
end $$;

-- When the last pool match of a pools_to_bracket event finishes, seeds the
-- bracket: every pool winner first (best record first), then every runner-up,
-- and so on. First-round matchups between teams from the same pool are
-- avoided where a swap within the same finishing place allows it.
create function private.seed_playoffs_when_pools_done(p_event uuid) returns void
language plpgsql set search_path = '' as $$
declare
  e public.events;
  v_teams uuid[];
  v_pools int[];
  v_opponent int[];
  v_tier_size int;
  r record;
  a int;
  b int;
  c int;
  v_team uuid;
  v_pool int;
begin
  select * into e from public.events where id = p_event;
  if e.format <> 'pools_to_bracket' or e.playoffs_seeded_at is not null then
    return;
  end if;
  if exists (
    select 1 from public.matches
    where event_id = p_event and stage = 'pool' and status <> 'completed'
  ) then
    return;
  end if;

  select array_agg(s.team_id order by s.pool_rank, s.wins::numeric / nullif(s.played, 0) desc nulls last,
                   s.point_diff desc, s.points_for desc, s.pool),
         array_agg(s.pool order by s.pool_rank, s.wins::numeric / nullif(s.played, 0) desc nulls last,
                   s.point_diff desc, s.points_for desc, s.pool)
  into v_teams, v_pools
  from public.standings s
  where s.event_id = p_event and s.pool_rank <= e.advance_per_pool;

  -- Who each seed meets in the first round (null = bye).
  v_opponent := array_fill(null::int, array[cardinality(v_teams)]);
  for r in
    select team1_seed, team2_seed from public.matches
    where event_id = p_event and stage = 'bracket' and team1_seed is not null and team2_seed is not null
  loop
    v_opponent[r.team1_seed] := r.team2_seed;
    v_opponent[r.team2_seed] := r.team1_seed;
  end loop;

  v_tier_size := e.pool_count;
  for a in 1 .. cardinality(v_teams) loop
    b := v_opponent[a];
    continue when b is null or b < a or v_pools[a] <> v_pools[b];
    -- Swap b with another seed of the same finishing place from another pool,
    -- if that doesn't create a same-pool matchup for the other seed.
    for c in ((b - 1) / v_tier_size) * v_tier_size + 1 .. least(((b - 1) / v_tier_size + 1) * v_tier_size, cardinality(v_teams)) loop
      continue when c = b or c = a or v_pools[c] = v_pools[a];
      continue when v_opponent[c] is not null and v_opponent[c] <> b and v_pools[v_opponent[c]] = v_pools[b];
      v_team := v_teams[b]; v_teams[b] := v_teams[c]; v_teams[c] := v_team;
      v_pool := v_pools[b]; v_pools[b] := v_pools[c]; v_pools[c] := v_pool;
      exit;
    end loop;
  end loop;

  update public.matches set team1_id = v_teams[team1_seed]
  where event_id = p_event and stage = 'bracket' and team1_seed is not null;
  update public.matches set team2_id = v_teams[team2_seed]
  where event_id = p_event and stage = 'bracket' and team2_seed is not null;
  update public.events set playoffs_seeded_at = private.clock() where id = p_event;
end $$;

-- ---------------------------------------------------------------------------
-- API: organizations and tournaments
-- ---------------------------------------------------------------------------

create function public.create_organization(p_name text, p_slug text) returns public.organizations
language plpgsql security definer set search_path = '' as $$
declare
  o public.organizations;
begin
  if auth.uid() is null then
    raise exception 'Sign in to create an organization' using errcode = '42501';
  end if;
  insert into public.organizations (name, slug, created_by)
  values (p_name, lower(p_slug), auth.uid())
  returning * into o;
  insert into public.organization_members (organization_id, user_id, role)
  values (o.id, auth.uid(), 'owner');
  return o;
end $$;

-- Owners and admins add a director (or admin) by the email they signed up with.
create function public.add_organization_member(p_organization uuid, p_email text, p_role text default 'director')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  if not public.is_organization_member(p_organization, array['owner', 'admin']) then
    raise exception 'Only owners and admins can add members' using errcode = '42501';
  end if;
  select id into v_user from auth.users where lower(email) = lower(p_email);
  if v_user is null then
    raise exception 'No account with that email yet. Ask them to sign up first.' using errcode = 'P0002';
  end if;
  insert into public.organization_members (organization_id, user_id, role)
  values (p_organization, v_user, p_role)
  on conflict (organization_id, user_id) do update set role = excluded.role;
end $$;

-- Creates a draft tournament with courts "Court 1".."Court N".
create function public.create_tournament(
  p_organization uuid, p_name text, p_starts_on date, p_court_count int default 0
) returns public.tournaments
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  if not public.is_organization_member(p_organization) then
    raise exception 'Only members of this organization can create its tournaments' using errcode = '42501';
  end if;
  insert into public.tournaments (organization_id, name, starts_on, created_by)
  values (p_organization, p_name, p_starts_on, auth.uid())
  returning * into t;
  insert into public.courts (tournament_id, name, sort_order)
  select t.id, 'Court ' || n, n from generate_series(1, p_court_count) n;
  return t;
end $$;

-- Draft -> registration -> live -> complete. Going live starts assignment.
create function public.set_tournament_status(p_tournament uuid, p_status public.tournament_status)
returns public.tournaments
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  perform private.require_staff(p_tournament);
  perform private.lock_tournament(p_tournament);
  update public.tournaments set status = p_status where id = p_tournament returning * into t;
  perform private.auto_assign(p_tournament);
  return t;
end $$;

-- Pause (false) or resume (true) sending matches to courts.
create function public.set_auto_assign(p_tournament uuid, p_on boolean) returns public.tournaments
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  perform private.require_staff(p_tournament);
  perform private.lock_tournament(p_tournament);
  update public.tournaments set auto_assign = p_on where id = p_tournament returning * into t;
  perform private.auto_assign(p_tournament);
  return t;
end $$;

-- Use any number of courts. Adding brings back removed courts first, then
-- creates "Court N". Removing takes the highest-numbered courts: their live
-- matches go back to the queue, and courts with match history are kept
-- (retired) so history still shows where matches were played.
create function public.set_court_count(p_tournament uuid, p_count int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_active int;
  v_court uuid;
  v_number int;
begin
  perform private.require_staff(p_tournament);
  perform private.lock_tournament(p_tournament);
  if p_count < 0 or p_count > 200 then
    raise exception 'Court count must be between 0 and 200' using errcode = '22023';
  end if;

  select count(*) into v_active from public.courts where tournament_id = p_tournament and retired_at is null;

  while v_active < p_count loop
    select id into v_court from public.courts
    where tournament_id = p_tournament and retired_at is not null
    order by sort_order, name limit 1;
    if v_court is not null then
      update public.courts set retired_at = null, out_of_service = false where id = v_court;
    else
      select coalesce(max(sort_order), 0) + 1 into v_number from public.courts where tournament_id = p_tournament;
      while exists (select 1 from public.courts where tournament_id = p_tournament and name = 'Court ' || v_number) loop
        v_number := v_number + 1;
      end loop;
      insert into public.courts (tournament_id, name, sort_order) values (p_tournament, 'Court ' || v_number, v_number);
    end if;
    v_active := v_active + 1;
  end loop;

  while v_active > p_count loop
    select id into v_court from public.courts
    where tournament_id = p_tournament and retired_at is null
    order by sort_order desc, name desc limit 1;
    update public.matches
    set status = 'queued', court_id = null, assigned_at = null, started_at = null
    where court_id = v_court and status in ('assigned', 'in_progress');
    if exists (select 1 from public.matches where court_id = v_court) then
      update public.courts set retired_at = private.clock() where id = v_court;
    else
      delete from public.courts where id = v_court;
    end if;
    v_active := v_active - 1;
  end loop;

  perform private.auto_assign(p_tournament);
  return v_active;
end $$;

-- ---------------------------------------------------------------------------
-- API: events
-- ---------------------------------------------------------------------------

-- Builds the event's matches from its teams (in seed order) and adds them to
-- the queue. Returns the number of matches created.
create function public.generate_matches(p_event uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_teams uuid[];
  v_count int;
  v_created int;
  v_pool_rounds int;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  if exists (select 1 from public.matches where event_id = p_event) then
    raise exception 'This event already has matches' using errcode = '55000';
  end if;

  v_teams := array(
    select id from public.teams
    where event_id = p_event and withdrawn_at is null
    order by seed nulls last, created_at, id
  );
  v_count := cardinality(v_teams);
  if v_count < 2 then
    raise exception 'An event needs at least 2 teams' using errcode = '22023';
  end if;

  if e.format = 'single_elim' then
    update public.teams set pool = null where event_id = p_event;
    v_created := private.build_bracket(e, v_count, v_teams, 0);
  else
    if v_count < 2 * e.pool_count then
      raise exception '% pools need at least % teams', e.pool_count, 2 * e.pool_count using errcode = '22023';
    end if;
    v_created := private.generate_pools(e, v_teams);
    if e.format = 'pools_to_bracket' then
      if e.advance_per_pool > v_count / e.pool_count then
        raise exception 'Can''t advance % per pool: the smallest pool has % teams',
          e.advance_per_pool, v_count / e.pool_count using errcode = '22023';
      end if;
      if e.pool_count * e.advance_per_pool < 2 then
        raise exception 'At least 2 teams must advance to the bracket' using errcode = '22023';
      end if;
      select max(round) into v_pool_rounds from public.matches where event_id = p_event;
      v_created := v_created + private.build_bracket(e, e.pool_count * e.advance_per_pool, null, v_pool_rounds);
    end if;
  end if;

  perform private.auto_assign(e.tournament_id);
  return v_created;
end $$;

-- Deletes an event's matches so it can be regenerated (e.g. after changing
-- teams or format). Only before any of its matches has gone on a court.
create function public.clear_matches(p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  if exists (
    select 1 from public.matches
    where event_id = p_event and status in ('assigned', 'in_progress', 'completed')
  ) then
    raise exception 'Matches in this event have already been played' using errcode = '55000';
  end if;
  delete from public.matches where event_id = p_event;
  update public.teams set pool = null where event_id = p_event;
  update public.events set playoffs_seeded_at = null where id = p_event;
end $$;

-- Staff, or a player on the team, can check the team in (or undo it).
create function public.check_in_team(p_team uuid, p_checked_in boolean default true)
returns public.teams
language plpgsql security definer set search_path = '' as $$
declare
  v_tournament uuid;
  t public.teams;
begin
  select tournament_id into v_tournament from public.teams where id = p_team;
  if v_tournament is null then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  if not (public.is_tournament_staff(v_tournament) or private.plays_on_team(p_team)) then
    raise exception 'Only the team''s players or tournament staff can check it in' using errcode = '42501';
  end if;
  perform private.lock_tournament(v_tournament);

  update public.teams
  set checked_in_at = case when p_checked_in then coalesce(checked_in_at, private.clock()) end
  where id = p_team
  returning * into t;
  perform private.auto_assign(v_tournament);
  return t;
end $$;

-- ---------------------------------------------------------------------------
-- API: matches on court
-- ---------------------------------------------------------------------------

-- Runs assignment now, even while the tournament is paused or not live.
create function public.assign_courts(p_tournament uuid) returns int
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_staff(p_tournament);
  return private.run_assignment(p_tournament);
end $$;

-- The players' "we're here" tap. Stops the no-show timer.
create function public.confirm_on_court(p_match uuid) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.lock_match(p_match);
  if not (public.is_tournament_staff(m.tournament_id) or private.plays_in_match(p_match)) then
    raise exception 'Only players in this match or tournament staff can do this' using errcode = '42501';
  end if;
  if m.status = 'assigned' then
    update public.matches
    set status = 'in_progress', started_at = private.clock()
    where id = p_match
    returning * into m;
  elsif m.status <> 'in_progress' then
    raise exception 'This match is not on a court' using errcode = '55000';
  end if;
  return m;
end $$;

-- p_games lists game scores with team 1 first, e.g. '[[11, 7], [9, 11], [11, 5]]'.
-- Completes the match, moves the winner on, and pulls the next match from the queue.
create function public.report_score(p_match uuid, p_games jsonb) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.lock_match(p_match);
  if not (public.is_tournament_staff(m.tournament_id) or private.plays_in_match(p_match)) then
    raise exception 'Only players in this match or tournament staff can report its score' using errcode = '42501';
  end if;
  if m.status not in ('assigned', 'in_progress') then
    raise exception 'This match is not on a court, so it can''t be scored' using errcode = '55000';
  end if;
  perform private.finish_match(p_match, private.score_winner(m, p_games), p_games, false);
  perform private.auto_assign(m.tournament_id);

  select * into m from public.matches where id = p_match;
  return m;
end $$;

-- Director: fix the score of a finished match. If that changes the winner,
-- the new winner replaces the old one in the next match, as long as that
-- match hasn't gone on a court (and, for pool matches, playoffs aren't seeded).
create function public.correct_score(p_match uuid, p_games jsonb) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  v_next public.matches;
  v_winner uuid;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  if m.status <> 'completed' then
    raise exception 'Only finished matches can be corrected' using errcode = '55000';
  end if;
  v_winner := private.score_winner(m, p_games);

  if v_winner is distinct from m.winner_team_id then
    if m.stage = 'pool' and exists (
      select 1 from public.events where id = m.event_id and playoffs_seeded_at is not null
    ) then
      raise exception 'Playoffs were already seeded from these results' using errcode = '55000';
    end if;
    if m.winner_to_match_id is not null then
      select * into v_next from public.matches where id = m.winner_to_match_id for update;
      if v_next.status in ('assigned', 'in_progress', 'completed') then
        raise exception 'The next match (%) has already started', v_next.label using errcode = '55000';
      end if;
      perform private.place_in_slot(v_next.id, m.winner_to_slot, v_winner);
    end if;
  end if;

  update public.matches
  set games = p_games, winner_team_id = v_winner, forfeit = false
  where id = p_match
  returning * into m;
  perform private.auto_assign(m.tournament_id);
  return m;
end $$;

-- Director: award the match to p_winner_team without playing it.
create function public.forfeit_match(p_match uuid, p_winner_team uuid) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  if m.status not in ('queued', 'assigned', 'in_progress') then
    raise exception 'Only a queued or live match can be forfeited' using errcode = '55000';
  end if;
  if p_winner_team is null or p_winner_team not in (m.team1_id, m.team2_id) then
    raise exception 'The winner must be one of the match''s two teams' using errcode = '22023';
  end if;
  perform private.finish_match(p_match, p_winner_team, null, true);
  perform private.auto_assign(m.tournament_id);

  select * into m from public.matches where id = p_match;
  return m;
end $$;

-- Director: take a match off its court and put it back in its queue spot.
-- Pass the team that didn't show up as p_absent_team to un-check it in, so
-- the match isn't sent out again until that team checks in.
create function public.requeue_match(p_match uuid, p_absent_team uuid default null)
returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  if m.status not in ('assigned', 'in_progress') then
    raise exception 'This match is not on a court' using errcode = '55000';
  end if;
  if p_absent_team is not null and p_absent_team not in (m.team1_id, m.team2_id) then
    raise exception 'The absent team must be one of the match''s two teams' using errcode = '22023';
  end if;

  update public.matches
  set status = 'queued', court_id = null, assigned_at = null, started_at = null
  where id = p_match;
  if p_absent_team is not null then
    update public.teams set checked_in_at = null where id = p_absent_team;
  end if;
  perform private.auto_assign(m.tournament_id);

  select * into m from public.matches where id = p_match;
  return m;
end $$;

-- Director: pause a court (its live match goes back to the queue) or resume it.
create function public.set_court_out_of_service(p_court uuid, p_out_of_service boolean)
returns public.courts
language plpgsql security definer set search_path = '' as $$
declare
  c public.courts;
begin
  select * into c from public.courts where id = p_court;
  if not found then
    raise exception 'Court not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(c.tournament_id);
  perform private.lock_tournament(c.tournament_id);

  if p_out_of_service then
    update public.matches
    set status = 'queued', court_id = null, assigned_at = null, started_at = null
    where court_id = p_court and status in ('assigned', 'in_progress');
  end if;
  update public.courts set out_of_service = p_out_of_service where id = p_court returning * into c;
  perform private.auto_assign(c.tournament_id);
  return c;
end $$;

-- Director: send a queued match to a specific free court now. Overrides the
-- queue order, holds, rest and check-in; refuses only when a player is on
-- another court.
create function public.assign_match_to_court(p_match uuid, p_court uuid) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  c public.courts;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  if m.status <> 'queued' then
    raise exception 'Only a queued match can be sent to a court' using errcode = '55000';
  end if;
  select * into c from public.courts
  where id = p_court and tournament_id = m.tournament_id and retired_at is null;
  if not found then
    raise exception 'Court not found' using errcode = 'P0002';
  end if;
  if c.out_of_service then
    raise exception '% is paused', c.name using errcode = '55000';
  end if;
  if exists (select 1 from public.matches where court_id = p_court and status in ('assigned', 'in_progress')) then
    raise exception '% already has a match', c.name using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.matches other
    join public.team_players tp on tp.team_id in (other.team1_id, other.team2_id)
    join public.team_players mine on mine.player_id = tp.player_id
    where other.tournament_id = m.tournament_id and other.status in ('assigned', 'in_progress')
      and mine.team_id in (m.team1_id, m.team2_id)
  ) then
    raise exception 'A player in this match is on another court' using errcode = '55000';
  end if;

  update public.matches
  set status = 'assigned', court_id = p_court, assigned_at = private.clock(), on_hold = false
  where id = p_match
  returning * into m;
  perform private.notify_match_players(p_match, 'court_assigned');
  return m;
end $$;

-- Director: move a live match to another court. If that court has a live
-- match, the two swap courts. Players are told about the change.
create function public.move_match_to_court(p_match uuid, p_court uuid) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  c public.courts;
  v_other public.matches;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  if m.status not in ('assigned', 'in_progress') then
    raise exception 'This match is not on a court' using errcode = '55000';
  end if;
  select * into c from public.courts
  where id = p_court and tournament_id = m.tournament_id and retired_at is null;
  if not found then
    raise exception 'Court not found' using errcode = 'P0002';
  end if;
  if p_court = m.court_id then
    return m;
  end if;

  select * into v_other from public.matches
  where court_id = p_court and status in ('assigned', 'in_progress') for update;
  if v_other.id is null and c.out_of_service then
    raise exception '% is paused', c.name using errcode = '55000';
  end if;

  if v_other.id is not null then
    -- Step the other match off its court for a moment so the one-match-per-
    -- court index never sees two matches on one court.
    update public.matches set status = 'queued', court_id = null where id = v_other.id;
    update public.matches set court_id = p_court where id = p_match;
    update public.matches
    set status = v_other.status, court_id = m.court_id
    where id = v_other.id;
    perform private.notify_match_players(v_other.id, 'court_changed');
  else
    update public.matches set court_id = p_court where id = p_match;
  end if;
  perform private.notify_match_players(p_match, 'court_changed');

  select * into m from public.matches where id = p_match;
  return m;
end $$;

-- ---------------------------------------------------------------------------
-- API: the queue
-- ---------------------------------------------------------------------------

-- Director: move a match to just above p_before_match in the queue, or to the
-- bottom when p_before_match is null.
create function public.move_in_queue(p_match uuid, p_before_match uuid default null)
returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  v_before public.matches;
  v_above numeric;
  v_seq numeric;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  if m.status not in ('waiting', 'queued') then
    raise exception 'Only matches still in the queue can be moved' using errcode = '55000';
  end if;

  if p_before_match is null then
    select coalesce(max(queue_seq), 0) + 1000 into v_seq
    from public.matches
    where tournament_id = m.tournament_id and status in ('waiting', 'queued') and id <> p_match;
  else
    select * into v_before from public.matches
    where id = p_before_match and tournament_id = m.tournament_id and status in ('waiting', 'queued');
    if not found then
      raise exception 'That match isn''t in this queue' using errcode = 'P0002';
    end if;
    select max(queue_seq) into v_above
    from public.matches
    where tournament_id = m.tournament_id and status in ('waiting', 'queued')
      and queue_seq < v_before.queue_seq and id <> p_match;
    v_seq := case when v_above is null then v_before.queue_seq - 1000
                  else (v_above + v_before.queue_seq) / 2 end;
  end if;

  update public.matches set queue_seq = v_seq where id = p_match returning * into m;
  perform private.auto_assign(m.tournament_id);
  return m;
end $$;

-- Director: hold a match (it keeps its place but is skipped) or release it.
create function public.hold_match(p_match uuid, p_hold boolean) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  if m.status not in ('waiting', 'queued') then
    raise exception 'Only matches still in the queue can be held' using errcode = '55000';
  end if;
  update public.matches set on_hold = p_hold where id = p_match returning * into m;
  perform private.auto_assign(m.tournament_id);
  return m;
end $$;

-- Director: undo manual reordering and put the queue back in wave order.
create function public.rebuild_queue(p_tournament uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_staff(p_tournament);
  perform private.lock_tournament(p_tournament);
  update public.matches m
  set queue_seq = private.default_queue_seq(m.event_id, m.wave, m.pool, m.position)
  where m.tournament_id = p_tournament and m.status in ('waiting', 'queued');
  perform private.auto_assign(p_tournament);
end $$;

-- The queue top to bottom. blocked_reason says why a match is waiting:
-- on_hold, event_not_started, not_checked_in, player_on_court, resting or
-- player_needed_elsewhere. Null means it goes on the next free court.
create function public.up_next(p_tournament uuid)
returns table (
  queue_rank int,
  match_id uuid,
  event_id uuid,
  event_name text,
  label text,
  team1_id uuid,
  team1_name text,
  team2_id uuid,
  team2_name text,
  blocked_reason text,
  overdue boolean,
  waiting_since timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.tournaments t
    where t.id = p_tournament and (t.status <> 'draft' or public.is_tournament_staff(t.id))
  ) then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;

  return query
  select q.queue_rank, m.id, e.id, e.name, m.label, t1.id, t1.name, t2.id, t2.name,
         q.blocked_reason, q.overdue, q.waiting_since
  from private.plan_queue(p_tournament, private.clock()) q
  join public.matches m on m.id = q.match_id
  join public.events e on e.id = m.event_id
  join public.teams t1 on t1.id = m.team1_id
  join public.teams t2 on t2.id = m.team2_id
  order by q.queue_rank;
end $$;
