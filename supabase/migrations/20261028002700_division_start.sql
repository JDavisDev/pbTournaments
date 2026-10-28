-- Starting a division. A director officially starts each division
-- (start_event); until then none of its matches go on a court, whatever its
-- start time says. It can start before every team has checked in:
--
--  * A team that isn't checked in takes its pool's round-1 sit-out (round
--    robin with an odd number of teams, or Swiss), when there is one, so it
--    has a round to arrive.
--  * Its players get a text. It then has tournaments.checkin_grace_minutes
--    (10 by default) to check in, or it forfeits its matches: teams.no_show_at is
--    set and every match it's in completes as a forfeit as soon as its
--    opponent is known. Checking in later clears no_show_at, so matches not
--    yet forfeited are played.

alter table public.events add column started_at timestamptz;
alter table public.teams add column no_show_at timestamptz;
-- Minutes after a division starts for its teams to check in. Null: teams
-- that miss check-in are never forfeited automatically. (no_show_minutes is
-- a different clock: how long a team called to a court has to get there.)
alter table public.tournaments
  add column checkin_grace_minutes int default 10 check (checkin_grace_minutes between 0 and 240);
grant update (checkin_grace_minutes) on public.tournaments to authenticated;

-- Checking in undoes a no-show (matches already forfeited stay forfeited).
create function private.teams_clear_no_show() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.no_show_at := null;
  return new;
end $$;
create trigger teams_clear_no_show
before update of checked_in_at on public.teams
for each row when (new.checked_in_at is not null and new.no_show_at is not null)
execute function private.teams_clear_no_show();

-- ---------------------------------------------------------------------------
-- The engine: nothing goes on court before the division starts
-- ---------------------------------------------------------------------------

-- As before, plus 'division_not_started' until start_event. A match can only
-- be overdue once its division has started.
create or replace function private.match_candidates(p_tournament uuid, p_now timestamptz)
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
           when e.started_at is null then 'division_not_started'
           when e.not_before > p_now then 'event_not_started'
           when not (t1.ready and t2.ready) then 'not_checked_in'
           when t1.busy or t2.busy then 'player_on_court'
         end,
         not m.on_hold and e.started_at is not null and coalesce(e.not_before <= p_now, true) and t1.ready and t2.ready
           and greatest(t1.event_free_since, t2.event_free_since, e.not_before, e.started_at)
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

-- A match whose two slots are both decided completes by itself when one of
-- them is a bye (the other side moves on), or a withdrawn or no-show team
-- (forfeit).
create or replace function private.settle(p_match uuid) returns void
language plpgsql set search_path = '' as $$
declare
  m public.matches;
  v_out uuid;
  v_winner uuid;
begin
  select * into m from public.matches where id = p_match;
  if m.status not in ('waiting', 'queued')
     or not ((m.team1_id is not null or m.team1_bye) and (m.team2_id is not null or m.team2_bye)) then
    return;
  end if;

  if m.team1_bye or m.team2_bye then
    v_winner := coalesce(m.team1_id, m.team2_id); -- null when both are byes
    update public.matches
    set status = 'completed', is_bye = true, forfeit = true, winner_team_id = v_winner,
        completed_at = private.clock()
    where id = m.id;
    if m.winner_to_match_id is not null then
      perform private.advance(m.winner_to_match_id, m.winner_to_slot, v_winner, v_winner is null);
    end if;
    if m.loser_to_match_id is not null then
      perform private.advance(m.loser_to_match_id, m.loser_to_slot, null, true);
    end if;
    return;
  end if;

  select id into v_out from public.teams
  where id in (m.team1_id, m.team2_id) and (withdrawn_at is not null or no_show_at is not null)
  order by withdrawn_at nulls last
  limit 1;
  if v_out is not null then
    perform private.finish_match(
      m.id, case when v_out = m.team1_id then m.team2_id else m.team1_id end, null, true
    );
  end if;
end $$;

-- Teams still not checked in checkin_grace_minutes after their division started
-- become no-shows and forfeit the matches they're in.
create function private.forfeit_no_shows(p_tournament uuid) returns void
language plpgsql set search_path = '' as $$
declare
  v_team uuid;
  v_match uuid;
begin
  for v_team in
    select tm.id
    from public.teams tm
    join public.events e on e.id = tm.event_id
    join public.tournaments t on t.id = e.tournament_id
    where tm.tournament_id = p_tournament and tm.checked_in_at is null and tm.withdrawn_at is null
      and tm.no_show_at is null and e.started_at is not null and t.checkin_grace_minutes is not null
      and e.started_at + make_interval(mins => t.checkin_grace_minutes) <= private.clock()
  loop
    update public.teams set no_show_at = private.clock() where id = v_team;
    for v_match in
      select id from public.matches
      where v_team in (team1_id, team2_id) and status in ('waiting', 'queued')
      order by wave, queue_seq
    loop
      perform private.settle(v_match);
    end loop;
  end loop;
end $$;

create or replace function private.auto_assign(p_tournament uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.tournaments t where t.id = p_tournament and t.status = 'live') then
    perform private.forfeit_no_shows(p_tournament);
  end if;
  if exists (
    select 1 from public.tournaments t
    where t.id = p_tournament and t.status = 'live' and t.auto_assign
  ) then
    perform private.run_assignment(p_tournament);
  end if;
end $$;

-- On the timer: no-show deadlines and start times pass without any event to
-- react to.
create or replace function private.assign_live_tournaments() returns void
language plpgsql set search_path = '' as $$
declare
  v_tournament uuid;
begin
  for v_tournament in
    select id from public.tournaments where status = 'live'
  loop
    perform private.auto_assign(v_tournament);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

-- Director: officially start a division (and the tournament, if it isn't
-- live yet). Teams not checked in take their pool's round-1 sit-out where
-- there is one and get a text with their check-in deadline. Returns
-- {not_checked_in, sitting_out, deadline}.
create function public.start_event(p_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  t public.tournaments;
  v_pool int;
  v_sitter uuid;
  v_absent uuid;
  v_sitting_out int := 0;
  v_absent_count int;
  v_deadline timestamptz;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  select * into t from public.tournaments where id = e.tournament_id;
  if e.started_at is not null then
    raise exception 'This division has already started' using errcode = '55000';
  end if;
  if t.status = 'complete' then
    raise exception 'This tournament is over' using errcode = '55000';
  end if;
  if not exists (select 1 from public.matches where event_id = p_event) then
    raise exception 'Build this division''s schedule before starting it' using errcode = '55000';
  end if;
  if t.status <> 'live' then
    t := public.set_tournament_status(t.id, 'live');
  end if;

  -- In each pool with a round-1 sit-out held by a team that's here, a team
  -- that isn't takes it: the two swap places in every match of the pool.
  for v_pool in
    select distinct pool from public.matches where event_id = p_event and stage = 'pool'
  loop
    select tm.id into v_sitter
    from public.teams tm
    where tm.event_id = p_event and tm.pool = v_pool and tm.withdrawn_at is null and tm.checked_in_at is not null
      and not exists (
        select 1 from public.matches m
        where m.event_id = p_event and m.stage = 'pool' and m.pool = v_pool and m.round = 1
          and tm.id in (m.team1_id, m.team2_id)
      )
    limit 1;
    continue when v_sitter is null;
    select tm.id into v_absent
    from public.teams tm
    where tm.event_id = p_event and tm.pool = v_pool and tm.withdrawn_at is null and tm.checked_in_at is null
      and exists (
        select 1 from public.matches m
        where m.event_id = p_event and m.stage = 'pool' and m.pool = v_pool and m.round = 1
          and tm.id in (m.team1_id, m.team2_id)
      )
    order by tm.seed desc nulls first
    limit 1;
    continue when v_absent is null;
    update public.matches
    set team1_id = case team1_id when v_absent then v_sitter when v_sitter then v_absent else team1_id end,
        team2_id = case team2_id when v_absent then v_sitter when v_sitter then v_absent else team2_id end
    where event_id = p_event and stage = 'pool' and pool = v_pool;
    v_sitting_out := v_sitting_out + 1;
  end loop;

  update public.events set started_at = private.clock() where id = p_event returning * into e;
  if t.checkin_grace_minutes is not null then
    v_deadline := e.started_at + make_interval(mins => t.checkin_grace_minutes);
  end if;

  select count(*) into v_absent_count
  from public.teams where event_id = p_event and withdrawn_at is null and checked_in_at is null;

  -- Text the players who haven't checked in.
  insert into public.notifications (tournament_id, player_id, kind, body)
  select t.id, tp.player_id, 'division_started',
         e.name || ' has started at ' || t.name || '. Check in at the desk'
         || coalesce(' by ' || to_char(v_deadline at time zone t.time_zone, 'FMHH12:MI AM')
                     || ' or your team forfeits its matches', '')
         || '.'
  from public.teams tm
  join public.team_players tp on tp.team_id = tm.id
  where tm.event_id = p_event and tm.withdrawn_at is null and tm.checked_in_at is null
    and not exists (
      select 1 from public.player_checkins pc where pc.tournament_id = t.id and pc.player_id = tp.player_id
    );

  perform private.auto_assign(t.id);
  return jsonb_build_object('not_checked_in', v_absent_count, 'sitting_out', v_sitting_out, 'deadline', v_deadline);
end $$;

-- As before, and a cleared schedule means the division hasn't started.
create or replace function public.clear_matches(p_event uuid) returns void
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
  update public.teams set pool = null, no_show_at = null where event_id = p_event;
  update public.events set playoffs_seeded_at = null, started_at = null where id = p_event;
end $$;

-- As before; a copy hasn't started.
create or replace function public.copy_event(p_event uuid) returns public.events
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  copy public.events;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  -- Every column carries over, including ones added later, except these.
  copy := jsonb_populate_record(null::public.events, to_jsonb(e) || jsonb_build_object(
    'id', gen_random_uuid(),
    'name', left(e.name || ' (copy)', 200),
    'sort_order', null,
    'playoffs_seeded_at', null,
    'started_at', null,
    'created_at', now()
  ));
  insert into public.events select copy.* returning * into copy;
  return copy;
end $$;

-- How ready each division is, and whether it has started.
create or replace view public.division_checkin with (security_invoker = true) as
select e.tournament_id,
       e.id as event_id,
       e.name as event_name,
       e.sort_order,
       e.not_before,
       count(distinct t.id)::int as teams,
       (count(distinct t.id) filter (where t.checked_in_at is not null))::int as teams_ready,
       count(distinct tp.player_id)::int as players,
       (count(distinct tp.player_id) filter (where pc.player_id is not null))::int as players_in,
       e.started_at,
       (count(distinct t.id) filter (where t.no_show_at is not null))::int as no_shows
from public.events e
left join public.teams t on t.event_id = e.id and t.withdrawn_at is null
left join public.team_players tp on tp.team_id = t.id
left join public.player_checkins pc on pc.tournament_id = e.tournament_id and pc.player_id = tp.player_id
group by e.id;

-- The demo tournament: when everyone has arrived, the divisions due to start
-- by now have started (later ones wait for the director).
alter function public.create_demo_tournament(boolean) rename to create_demo_tournament_unstarted;
alter function public.create_demo_tournament_unstarted(boolean) set schema private;
create function public.create_demo_tournament(p_arrived boolean default true) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_tournament uuid := private.create_demo_tournament_unstarted(p_arrived);
begin
  if p_arrived then
    update public.events set started_at = coalesce(not_before, now())
    where tournament_id = v_tournament and coalesce(not_before, now()) <= now();
    perform private.auto_assign(v_tournament);
  end if;
  return v_tournament;
end $$;

-- Demo clock: the start and no-show times move with everything else.
create or replace function private.shift_demo_clock(p_tournament uuid, p_minutes int) returns void
language plpgsql set search_path = '' as $$
declare
  v interval := make_interval(mins => p_minutes);
begin
  update public.matches
  set queued_at = queued_at - v, assigned_at = assigned_at - v, started_at = started_at - v,
      completed_at = completed_at - v, ready_since = ready_since - v,
      queue_seq = queue_seq - p_minutes * 1000000::numeric
  where tournament_id = p_tournament;
  update public.teams set checked_in_at = checked_in_at - v, withdrawn_at = withdrawn_at - v, no_show_at = no_show_at - v
  where tournament_id = p_tournament;
  update public.player_checkins set checked_in_at = checked_in_at - v where tournament_id = p_tournament;
  update public.events
  set not_before = not_before - v, playoffs_seeded_at = playoffs_seeded_at - v, started_at = started_at - v
  where tournament_id = p_tournament;
end $$;

-- Staff of a demo tournament: play it forward p_minutes (1–60), one minute at
-- a time. As before, and the demo's director starts each division when its
-- start time comes.
create or replace function public.advance_demo(p_tournament uuid, p_minutes int) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
  r record;
  v_step int;
begin
  select * into t from public.tournaments where id = p_tournament;
  if not found then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(p_tournament);
  if not t.is_demo then
    raise exception 'Only demo tournaments can be fast-forwarded' using errcode = '42501';
  end if;

  for v_step in 1 .. least(greatest(p_minutes, 1), 60) loop
    perform private.shift_demo_clock(p_tournament, 1);

    for r in
      select e.id from public.events e
      where e.tournament_id = p_tournament and e.started_at is null and e.not_before <= private.clock()
        and exists (select 1 from public.matches m where m.event_id = e.id)
      order by e.not_before, e.sort_order
    loop
      perform public.start_event(r.id);
    end loop;

    -- About one in eight players still out arrives each minute.
    for r in
      select distinct tp.player_id
      from public.teams tm
      join public.team_players tp on tp.team_id = tm.id
      where tm.tournament_id = p_tournament and tm.withdrawn_at is null
        and not exists (select 1 from public.player_checkins pc
                        where pc.tournament_id = p_tournament and pc.player_id = tp.player_id)
        and random() < 0.12
    loop
      perform public.check_in_player(p_tournament, r.player_id, true);
    end loop;

    for r in
      select id from public.matches
      where tournament_id = p_tournament and status = 'assigned'
        and (assigned_at <= private.clock() - interval '4 minutes'
             or (assigned_at <= private.clock() - interval '1 minute' and random() < 0.5))
    loop
      perform public.confirm_on_court(r.id);
    end loop;

    for r in
      select md.id, md.games_to, md.best_of,
             coalesce(case when md.stage = 'bracket' then e.bracket_match_minutes else e.pool_match_minutes end,
                      t.match_slot_minutes) - 3 as minutes
      from public.match_details md
      join public.events e on e.id = md.event_id
      where md.tournament_id = p_tournament and md.status = 'in_progress'
    loop
      if (select started_at from public.matches where id = r.id) <= private.clock() - make_interval(mins => r.minutes + 5)
         or ((select started_at from public.matches where id = r.id) <= private.clock() - make_interval(mins => r.minutes)
             and random() < 0.3) then
        perform public.report_score(r.id, private.demo_games(r.games_to, r.best_of));
      end if;
    end loop;

    perform private.auto_assign(p_tournament);
  end loop;
  return private.clock();
end $$;
