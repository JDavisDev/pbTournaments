-- Starting a division builds its schedule when it hasn't been built: pools,
-- seeds and matches come from the teams entered at that moment. Until then
-- teams and format can change freely, and the division page previews the
-- schedule they would make. Building early (generate_matches) still works,
-- e.g. to publish pools ahead of the day.

-- As before (division_start), building the schedule instead of refusing.
create or replace function public.start_event(p_event uuid) returns jsonb
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
  -- Not built yet: build it now, from the teams entered at this moment.
  if not exists (select 1 from public.matches where event_id = p_event) then
    perform public.generate_matches(p_event);
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
