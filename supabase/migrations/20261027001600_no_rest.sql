-- No rest periods. A player is on court, in the queue or on a bye: as soon
-- as their match is reported they can be called to the next one. The queue
-- no longer says 'resting', and min_rest_minutes goes away.

-- Every queued match in a tournament, with the reason it can't go on a court
-- yet (null when it can) and whether it's overdue. Holds are applied on top
-- of this by plan_queue.
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
           when e.not_before > p_now then 'event_not_started'
           when not (t1.ready and t2.ready) then 'not_checked_in'
           when t1.busy or t2.busy then 'player_on_court'
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
create or replace function private.plan_queue(p_tournament uuid, p_now timestamptz)
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
       or (c.overdue and c.blocked_reason = 'player_on_court') then
      v_claimed := v_claimed || c.player_ids;
    end if;
    return next;
  end loop;
end $$;

-- Practice tournaments, as before without the rest setting.
create or replace function public.create_demo_tournament(p_arrived boolean default true) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_first text[] := string_to_array('Alex Sam Jordan Casey Riley Morgan Taylor Jamie Drew Quinn Avery Parker Reese Rowan Skyler Blake Pat Jo Lee Kim', ' ');
  v_last text[] := string_to_array(
    'Davis Lee Park Cho Nguyen Ruiz Patel Kim Shah Brooks Reed Hayes Ortiz Price Bell Ward Foster Hughes Myers '
    'Long Ross Perry Powell Butler Barnes Fisher Henry Graham Wallace West Cole Ellis Ford Marsh Owens Gibbs '
    'Kerr Lamb Moss Nash Pope Quinn Rowe Shaw Tate Vance Webb Young Abbott Burke Cross Dalton Eaton Frost Gage '
    'Hale Irwin Jensen Knox Lowe Mann Noble Oakes Pike Rhodes Stone Thorne Upton Voss Wolfe York Zane Baird', ' ');
  v_org uuid;
  v_tournament uuid;
  v_start timestamptz := date_trunc('minute', now()) + case when p_arrived then interval '0' else interval '30 minutes' end;
  v_event uuid;
  v_team uuid;
  v_p1 uuid;
  v_p2 uuid;
  v_names text[];
  v_n int := 0;
  spec record;
  i int;
begin
  if auth.uid() is null then
    raise exception 'Sign in to create a demo tournament' using errcode = '42501';
  end if;
  select organization_id into v_org from public.organization_members where user_id = auth.uid() limit 1;
  if v_org is null then
    v_org := (public.create_organization('Demo Club', 'demo-' || substr(md5(random()::text), 1, 6))).id;
  end if;
  v_tournament := (public.create_tournament(v_org, 'Demo Open', (now() at time zone 'America/New_York')::date, 11)).id;
  update public.tournaments
  set is_demo = true, entry_fee_cents = 4250, extra_event_fee_cents = 1550,
      location = 'Demo Pickleball Center'
  where id = v_tournament;

  v_names := array(select x from unnest(v_last) x order by random());
  for spec in
    select * from (values
      (1, 'Men''s Doubles 3.5', 'pools_to_bracket', 2, 10, null::int, 'single', true, false, false,
       '[{"key": "final", "games_to": 11, "best_of": 3}]', 0, 15, 30),
      (2, 'Women''s Doubles 3.5', 'round_robin', 1, 8, 6, 'single', false, false, false, '[]', 0, 15, null),
      (3, 'Mixed Doubles 3.0', 'pools_to_bracket', 3, 12, null, 'single', false, false, true, '[]', 45, 15, 20),
      (4, 'Mixed Doubles 4.0', 'single_elim', 1, 6, null, 'double', false, true, false,
       '[{"key": "grand_final", "games_to": 15, "best_of": 1}]', 90, 15, 20)
    ) as s(sort, name, format, pools, teams, max_rounds, bracket_type, bronze, reset, confirm_seeds,
           round_formats, start_after, pool_minutes, bracket_minutes)
    order by sort
  loop
    insert into public.events (tournament_id, name, format, pool_count, advance_per_pool, max_rounds,
                               bracket_type, third_place_match, grand_final_reset, confirm_seeds, round_formats,
                               not_before, pool_match_minutes, bracket_match_minutes,
                               gender, skill_rule, skill_level)
    values (v_tournament, spec.name, spec.format::public.event_format, spec.pools, 2, spec.max_rounds,
            spec.bracket_type, spec.bronze, spec.reset, spec.confirm_seeds, spec.round_formats::jsonb,
            v_start + make_interval(mins => spec.start_after), spec.pool_minutes, spec.bracket_minutes,
            case when spec.name like 'Men%' then 'mens' when spec.name like 'Women%' then 'womens' else 'mixed' end,
            'only', case when spec.name like '%4.0' then 4.0 when spec.name like '%3.0' then 3.0 else 3.5 end)
    returning id into v_event;

    for i in 1 .. spec.teams loop
      insert into public.players (first_name, last_name, phone, sms_opt_in, email, gender, dupr_doubles, dupr_id, added_by)
      values (v_first[1 + floor(random() * cardinality(v_first))::int], v_names[1 + v_n % cardinality(v_names)],
              '+1555' || lpad(floor(random() * 10000000)::int::text, 7, '0'), true,
              'player' || v_n || '@players.test',
              case when spec.name like 'Women%' then 'female' when spec.name like 'Men%' then 'male' else 'female' end,
              round((case when spec.name like '%4.0' then 4.0 when spec.name like '%3.0' then 3.0 else 3.5 end
                     + random() * 0.45)::numeric, 3),
              upper(substr(md5(random()::text), 1, 6)), auth.uid())
      returning id into v_p1;
      insert into public.players (first_name, last_name, phone, sms_opt_in, email, gender, dupr_doubles, dupr_id, added_by)
      values (v_first[1 + floor(random() * cardinality(v_first))::int], v_names[1 + (v_n + 1) % cardinality(v_names)],
              '+1555' || lpad(floor(random() * 10000000)::int::text, 7, '0'), true,
              'player' || (v_n + 1) || '@players.test',
              case when spec.name like 'Women%' then 'female' else 'male' end,
              round((case when spec.name like '%4.0' then 4.0 when spec.name like '%3.0' then 3.0 else 3.5 end
                     + random() * 0.45)::numeric, 3),
              upper(substr(md5(random()::text), 1, 6)), auth.uid())
      returning id into v_p2;
      insert into public.teams (event_id, name, seed)
      values (v_event, v_names[1 + v_n % cardinality(v_names)] || '/' || v_names[1 + (v_n + 1) % cardinality(v_names)], i)
      returning id into v_team;
      insert into public.team_players (team_id, player_id) values (v_team, v_p1), (v_team, v_p2);
      v_n := v_n + 2;
    end loop;

    if p_arrived then
      insert into public.player_checkins (tournament_id, player_id, checked_in_at)
      select v_tournament, tp.player_id, now()
      from public.teams tm join public.team_players tp on tp.team_id = tm.id
      where tm.event_id = v_event
      on conflict do nothing;
      update public.teams set checked_in_at = now() where event_id = v_event;
    end if;
    perform public.generate_matches(v_event);
  end loop;

  perform public.set_tournament_status(v_tournament, 'live');
  return v_tournament;
end $$;

alter table public.tournaments drop column min_rest_minutes;
