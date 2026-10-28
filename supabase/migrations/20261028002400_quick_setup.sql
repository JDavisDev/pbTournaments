-- Starting a tournament in one click, and divisions that are quick to set up.
--
--  * new_tournament(): a draft with everything filled in, ready for Setup:
--    4 courts and one division (Mixed Doubles 3.5: round robin, then the top
--    four in a bracket). The director names it and picks the date. On a demo
--    site it's "Demo #N" today, so a practice tournament can run straight away.
--  * copy_event(): a new division with every setting of another.
--  * add_mock_teams(): practice tournaments only; made-up teams who fit the
--    division (gender, rating, ages), to try the day without real players.
--  * events.dupr_rated: whether a division's results go to DUPR.

alter table public.events add column dupr_rated boolean not null default true;
grant update (dupr_rated) on public.events to authenticated;

-- Signed-in user: a new draft tournament in p_organization (on a demo site,
-- null uses the user's first organization or makes "Demo Club").
create function public.new_tournament(p_organization uuid default null) returns public.tournaments
language plpgsql security definer set search_path = '' as $$
declare
  v_demo boolean := coalesce((select demo from private.site), false);
  v_org uuid := p_organization;
  v_number int;
  t public.tournaments;
begin
  if auth.uid() is null then
    raise exception 'Sign in to start a tournament' using errcode = '42501';
  end if;
  if v_org is null then
    if not v_demo then
      raise exception 'Choose an organization for the tournament' using errcode = '22023';
    end if;
    select organization_id into v_org from public.organization_members where user_id = auth.uid() limit 1;
    if v_org is null then
      v_org := (public.create_organization('Demo Club', 'demo-' || substr(md5(random()::text), 1, 6))).id;
    end if;
  end if;

  if v_demo then
    select count(*) + 1 into v_number from public.tournaments where organization_id = v_org and name like 'Demo #%';
    t := public.create_tournament(v_org, 'Demo #' || v_number, (now() at time zone 'America/New_York')::date, 4);
    update public.tournaments
    set entry_fee_cents = 4250, extra_event_fee_cents = 1550, location = 'Demo Pickleball Center'
    where id = t.id;
  else
    -- Placeholders: Setup asks for the real name and date.
    t := public.create_tournament(v_org, 'New tournament', current_date + 28, 4);
  end if;

  insert into public.events (tournament_id, name, kind, gender, skill_rule, skill_level,
                             format, pool_count, advance_per_pool)
  values (t.id, 'Mixed Doubles 3.5', 'doubles', 'mixed', 'only', 3.5, 'pools_to_bracket', 1, 4);

  select * into t from public.tournaments where id = t.id;
  return t;
end $$;

-- Staff: a new division with every setting of p_event (not its teams),
-- named "<name> (copy)" and listed last.
create function public.copy_event(p_event uuid) returns public.events
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
    'created_at', now()
  ));
  insert into public.events select copy.* returning * into copy;
  return copy;
end $$;

-- Staff, practice tournaments only: p_count made-up teams (or players, for
-- singles) who fit the division, seeded after the teams already in it.
-- Returns how many were added.
create function public.add_mock_teams(p_event uuid, p_count int default 4) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_first_men text[] := string_to_array('Alex Sam Jordan Casey Riley Drew Quinn Parker Reese Blake Pat Lee Marcus Ben Omar Luis', ' ');
  v_first_women text[] := string_to_array('Morgan Taylor Jamie Avery Rowan Skyler Jo Kim Ana Maya Grace Nina Rosa Leah Tess Ivy', ' ');
  v_last text[] := string_to_array(
    'Davis Lee Park Cho Nguyen Ruiz Patel Kim Shah Brooks Reed Hayes Ortiz Price Bell Ward Foster Hughes Myers '
    'Long Ross Perry Powell Butler Barnes Fisher Henry Graham Wallace West Cole Ellis Ford Marsh Owens Gibbs '
    'Kerr Lamb Moss Nash Pope Rowe Shaw Tate Vance Webb Young Abbott Burke Cross Dalton Eaton Frost Gage', ' ');
  e public.events;
  t public.tournaments;
  v_seed int;
  v_size int;
  v_team uuid;
  v_player uuid;
  v_pick int;
  v_players uuid[];
  v_lasts text[];
  v_gender text;
  v_low numeric;
  v_high numeric;
  v_rating numeric;
  v_age_low int;
  v_age_high int;
  v_age int;
  i int;
  j int;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  select * into t from public.tournaments where id = e.tournament_id;
  if not t.is_demo then
    raise exception 'Mock players are only for practice tournaments' using errcode = '55000';
  end if;
  if p_count not between 1 and 64 then
    raise exception 'Add between 1 and 64 at a time' using errcode = '22023';
  end if;

  v_size := case when e.kind = 'singles' then 1 else 2 end;
  -- Ratings inside the division's skill rule (3.5 'only' = 3.50-3.99).
  v_low := case e.skill_rule when 'open' then 3.0 when 'and_under' then greatest(2.0, e.skill_level - 0.5) else e.skill_level end;
  v_high := case e.skill_rule when 'open' then 4.5 when 'and_above' then e.skill_level + 0.75
                              when 'range' then e.skill_level_to + 0.49 else e.skill_level + 0.49 end;
  if e.team_rating_max is not null then
    v_high := least(v_high, e.team_rating_max / v_size - 0.01);
  end if;
  -- Ages inside the division's range (and a doubles team's combined minimum).
  v_age_low := greatest(coalesce(e.min_age, 25), case when e.team_age_min is not null then ceil(e.team_age_min / 2.0)::int else 0 end);
  v_age_high := greatest(v_age_low, coalesce(e.max_age, v_age_low + 35));
  select coalesce(max(seed), 0) into v_seed from public.teams where event_id = p_event;

  for i in 1 .. p_count loop
    v_players := '{}';
    v_lasts := '{}';
    for j in 1 .. v_size loop
      v_gender := case e.gender
        when 'mens' then 'male'
        when 'womens' then 'female'
        when 'mixed' then case when j = 1 then 'male' else 'female' end
        else case when random() < 0.5 then 'male' else 'female' end
      end;
      v_rating := round((v_low + random() * greatest(0, v_high - v_low))::numeric, 3);
      v_age := v_age_low + floor(random() * (v_age_high - v_age_low + 1))::int;
      -- Partners get different last names (the team is "Davis/Lee").
      v_pick := case when j = 1 then floor(random() * cardinality(v_last))::int
                     else (v_pick + 1 + floor(random() * (cardinality(v_last) - 1))::int) % cardinality(v_last) end;
      v_lasts := v_lasts || v_last[1 + v_pick];
      insert into public.players (first_name, last_name, email, phone, sms_opt_in, gender, birth_date,
                                  dupr_id, dupr_doubles, dupr_singles, added_by)
      values (
        case when v_gender = 'male' then v_first_men[1 + floor(random() * cardinality(v_first_men))::int]
             else v_first_women[1 + floor(random() * cardinality(v_first_women))::int] end,
        v_lasts[j],
        'mock' || substr(md5(random()::text), 1, 8) || '@players.test',
        '+1555' || lpad(floor(random() * 10000000)::int::text, 7, '0'),
        true, v_gender,
        -- Exactly v_age on the day the division counts age.
        case when e.age_basis = 'year_end'
             then make_date(extract(year from t.starts_on)::int - v_age, 1, 1)
             else (t.starts_on - make_interval(years => v_age))::date - 1 end,
        upper(substr(md5(random()::text), 1, 6)),
        case when e.kind = 'doubles' then v_rating end,
        case when e.kind = 'singles' then v_rating end,
        auth.uid())
      returning id into v_player;
      v_players := v_players || v_player;
    end loop;
    insert into public.teams (event_id, name, seed)
    values (p_event,
            case when v_size = 1
                 then (select first_name || ' ' || last_name from public.players where id = v_players[1])
                 else v_lasts[1] || '/' || v_lasts[2] end,
            v_seed + i)
    returning id into v_team;
    insert into public.team_players (team_id, player_id) select v_team, unnest(v_players);
  end loop;
  return p_count;
end $$;

-- dupr_results: only divisions whose results go to DUPR. Otherwise as before.
create or replace function public.dupr_results(p_tournament uuid)
returns table (
  match_id uuid, event_id uuid, event_name text, label text, completed_at timestamptz,
  match_type text, event text, date text,
  player_a1 text, player_a1_dupr_id text, player_a2 text, player_a2_dupr_id text,
  player_b1 text, player_b1_dupr_id text, player_b2 text, player_b2_dupr_id text,
  games jsonb, location text, score_type text, missing_ids text[], exported_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff(p_tournament);
  return query
  with sides as (
    select m.id, s.slot,
           array_agg(p.first_name || ' ' || p.last_name order by p.last_name, p.first_name) as names,
           array_agg(upper(p.dupr_id) order by p.last_name, p.first_name) as ids
    from public.matches m
    cross join lateral (values (1, m.team1_id), (2, m.team2_id)) as s(slot, team_id)
    join public.team_players tp on tp.team_id = s.team_id
    join public.players p on p.id = tp.player_id
    where m.tournament_id = p_tournament and m.status = 'completed' and not m.forfeit and not m.is_bye
    group by m.id, s.slot
  )
  select m.id, e.id, e.name, m.label, m.completed_at,
         case when e.kind = 'singles' then 'S' else 'D' end,
         t.name || ' - ' || e.name,
         to_char(m.completed_at at time zone t.time_zone, 'YYYY-MM-DD'),
         a.names[1], a.ids[1], a.names[2], a.ids[2],
         b.names[1], b.ids[1], b.names[2], b.ids[2],
         m.games, t.location, t.dupr_score_type,
         array(select n from unnest(a.names || b.names, a.ids || b.ids) as x(n, i) where i is null),
         m.dupr_exported_at
  from public.matches m
  join public.tournaments t on t.id = m.tournament_id
  join public.events e on e.id = m.event_id and e.dupr_rated
  join sides a on a.id = m.id and a.slot = 1
  join sides b on b.id = m.id and b.slot = 2
  order by e.sort_order, m.completed_at;
end $$;
