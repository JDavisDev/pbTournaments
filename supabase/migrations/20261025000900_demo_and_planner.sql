-- Demo tournaments people can try on the hosted site, and match lengths per
-- division for planning the day.
--
-- Demo time: "fast-forward" moves a demo tournament's own timestamps back
-- (matches, check-ins, event start times, queue order), so the real clock
-- reads as minutes later for that tournament only. Every tester's demo runs
-- on its own, the engine needs no changes, and the 30-second assignment job
-- keeps working in real time between fast-forwards.

alter table public.tournaments add column is_demo boolean not null default false;

-- Expected minutes per match, court time included. Order the queue, plan the
-- day (the Planner) and pace demo matches. Null = the tournament's
-- match_slot_minutes.
alter table public.events
  add column pool_match_minutes int check (pool_match_minutes between 5 and 180),
  add column bracket_match_minutes int check (bracket_match_minutes between 5 and 180);

grant update (pool_match_minutes, bracket_match_minutes) on public.events to authenticated;

-- Queue order: event start + rounds × the division's match length.
create or replace function private.default_queue_seq(p_event uuid, p_wave int, p_pool int, p_position int)
returns numeric
language sql stable set search_path = '' as $$
  select (floor(extract(epoch from coalesce(
            e.not_before,
            (select min(e2.not_before) from public.events e2 where e2.tournament_id = e.tournament_id),
            t.starts_on::timestamp at time zone t.time_zone)) / 60)
          + p_wave * coalesce(e.pool_match_minutes, t.match_slot_minutes)) * 1000000::numeric
         + coalesce(e.sort_order, 0) * 1000 + p_pool * 36 + p_position
  from public.events e
  join public.tournaments t on t.id = e.tournament_id
  where e.id = p_event
$$;

-- ---------------------------------------------------------------------------
-- Demo clock
-- ---------------------------------------------------------------------------

-- Moves a demo tournament p_minutes into the future by moving its past back.
create function private.shift_demo_clock(p_tournament uuid, p_minutes int) returns void
language plpgsql set search_path = '' as $$
declare
  v interval := make_interval(mins => p_minutes);
begin
  update public.matches
  set queued_at = queued_at - v, assigned_at = assigned_at - v, started_at = started_at - v,
      completed_at = completed_at - v, queue_seq = queue_seq - p_minutes * 1000000::numeric
  where tournament_id = p_tournament;
  update public.teams set checked_in_at = checked_in_at - v, withdrawn_at = withdrawn_at - v
  where tournament_id = p_tournament;
  update public.player_checkins set checked_in_at = checked_in_at - v where tournament_id = p_tournament;
  update public.events set not_before = not_before - v, playoffs_seeded_at = playoffs_seeded_at - v
  where tournament_id = p_tournament;
end $$;

-- A believable finished score: usually a clean win, sometimes extra points.
create function private.demo_games(p_games_to int, p_best_of int) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_needed int := p_best_of / 2 + 1;
  v_wins1 int := 0;
  v_wins2 int := 0;
  v_win int;
  v_lose int;
  v_games jsonb := '[]';
begin
  while v_wins1 < v_needed and v_wins2 < v_needed loop
    if random() < 0.15 then
      v_win := p_games_to + 1 + floor(random() * 3)::int;
      v_lose := v_win - 2;
    else
      v_win := p_games_to;
      v_lose := 2 + floor(random() * (p_games_to - 3))::int;
    end if;
    if random() < 0.5 then
      v_games := v_games || jsonb_build_array(jsonb_build_array(v_win, v_lose));
      v_wins1 := v_wins1 + 1;
    else
      v_games := v_games || jsonb_build_array(jsonb_build_array(v_lose, v_win));
      v_wins2 := v_wins2 + 1;
    end if;
  end loop;
  return v_games;
end $$;

-- Staff of a demo tournament: play it forward p_minutes (1–60), one minute at
-- a time. Players trickle in, called teams reach their court, matches finish
-- after about their division's match length with a random score, and courts
-- refill. Returns the tournament's "now".
create function public.advance_demo(p_tournament uuid, p_minutes int) returns timestamptz
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

-- ---------------------------------------------------------------------------
-- Demo tournaments
-- ---------------------------------------------------------------------------

-- Signed-in user: a live 11-court demo tournament with four divisions that
-- show off the formats. p_arrived: everyone checked in and play under way
-- now, or the start of the day with nobody here yet. Uses the user's first
-- organization (or makes "Demo Club"). Returns the tournament id.
create function public.create_demo_tournament(p_arrived boolean default true) returns uuid
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
      location = 'Demo Pickleball Center', min_rest_minutes = 5
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

-- Demo tournaments only: the texts a team's players were sent, with the score
-- link as a path (/s/<code>), so testers playing a team can follow them.
create function public.demo_inbox(p_team uuid)
returns table (id bigint, created_at timestamptz, player_name text, body text)
language sql stable security definer set search_path = '' as $$
  select n.id, n.created_at, p.first_name || ' ' || p.last_name,
         replace(n.body, '{url}', coalesce('/s/' || m.report_code, '/'))
  from public.teams tm
  join public.tournaments t on t.id = tm.tournament_id and t.is_demo
  join public.team_players tp on tp.team_id = tm.id
  join public.players p on p.id = tp.player_id
  join public.notifications n on n.player_id = p.id and n.tournament_id = t.id
  left join public.matches m on m.id = n.match_id
  where tm.id = p_team
  order by n.id desc
  limit 20
$$;

grant execute on function public.demo_inbox(uuid) to anon, authenticated;

-- Demo texts are never sent: mark them logged so the Messages page shows
-- them as delivered to the test log (the hosted demo has no text sender).
create function private.log_demo_texts() returns void
language sql set search_path = '' as $$
  update public.notifications n
  set channel = 'log', sent_at = now(),
      to_phone = case when n.via = 'sms' then p.phone end,
      to_email = case when n.via = 'email' then p.email end,
      sent_body = replace(n.body, '{url}',
                          coalesce('/s/' || (select m.report_code from public.matches m where m.id = n.match_id), '/'))
  from public.tournaments t, public.players p
  where n.channel is null and t.id = n.tournament_id and t.is_demo and p.id = n.player_id
$$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('log-demo-texts', '30 seconds', 'select private.log_demo_texts()');
  end if;
end $$;

-- Practice tournaments are deleted two weeks after they're made, with the
-- made-up players nobody else uses.
create function private.clean_up_demo_tournaments() returns int
language plpgsql set search_path = '' as $$
declare
  v_deleted int;
begin
  delete from public.tournaments where is_demo and created_at < now() - interval '14 days';
  get diagnostics v_deleted = row_count;
  delete from public.players p
  where p.user_id is null and p.email like '%@players.test'
    and not exists (select 1 from public.team_players tp where tp.player_id = p.id)
    and not exists (select 1 from public.registrations r where r.player_id = p.id);
  return v_deleted;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    perform cron.schedule('clean-up-demo-tournaments', '17 4 * * *', 'select private.clean_up_demo_tournaments()');
  end if;
end $$;
