-- Moving a team to another division from anywhere, seeing how well it would
-- fit first, and refreshing ratings ahead of a tournament: what changed, and
-- who's now outside their division's rules.

alter table public.tournaments add column ratings_refreshed_at timestamptz;

-- ---------------------------------------------------------------------------
-- Division rules
-- ---------------------------------------------------------------------------

-- What's wrong with this team in this division, with its players' current
-- details: each player and, for doubles, the team rules. Empty when it fits.
create function private.team_problems(p_team uuid, p_event public.events, p_tournament public.tournaments) returns text[]
language sql stable set search_path = '' as $$
  with members as (
    select p.first_name, p.last_name, p.gender, p.birth_date, p.dupr_doubles, p.dupr_singles, p.self_rating, p.dupr_id,
           case when p_event.kind = 'singles' then p.dupr_singles else p.dupr_doubles end as rating,
           extract(year from age(
             case when p_event.age_basis = 'year_end'
                  then make_date(extract(year from p_tournament.starts_on)::int, 12, 31) else p_tournament.starts_on end,
             p.birth_date))::int as age
    from public.team_players tp
    join public.players p on p.id = tp.player_id
    where tp.team_id = p_team
  ),
  player_problems as (
    select m.first_name || ' ' || m.last_name || ': ' || private.entry_problem(
             p_event, p_tournament, m.gender, m.birth_date, m.dupr_doubles, m.dupr_singles, m.self_rating, m.dupr_id
           ) as problem
    from members m
  ),
  totals as (
    select count(*)::int as players,
           sum(m.rating) as rating_sum, count(m.rating)::int as rated,
           sum(m.age) as age_sum, count(m.age)::int as aged,
           count(*) filter (where m.gender = 'male')::int as men,
           count(*) filter (where m.gender = 'female')::int as women
    from members m
  )
  select array_remove(array_cat(
           coalesce((select array_agg(pp.problem order by pp.problem) from player_problems pp where pp.problem is not null), '{}'),
           array[
             case when p_event.team_rating_max is not null and tm.rated = tm.players
                       and tm.rating_sum >= p_event.team_rating_max
                  then format('Team rating %s is over the %s limit', round(tm.rating_sum, 2), p_event.team_rating_max) end,
             case when p_event.team_rating_max is not null and tm.rated < tm.players
                  then 'Team rating can''t be checked: a player has no rating' end,
             case when p_event.team_age_min is not null and tm.aged = tm.players
                       and tm.age_sum < p_event.team_age_min
                  then format('Combined age %s is under %s', tm.age_sum, p_event.team_age_min) end,
             case when p_event.team_age_min is not null and tm.aged < tm.players
                  then 'Combined age can''t be checked: a birth date is missing' end,
             case when p_event.gender = 'mixed' and tm.players = 2 and not (tm.men = 1 and tm.women = 1)
                  then 'Mixed doubles needs one man and one woman' end
           ]), null)
  from totals tm
$$;

-- As before (dupr), with the rules in private.team_problems.
create or replace function public.division_eligibility(p_tournament uuid)
returns table (event_id uuid, team_id uuid, team_name text, problems text[], unchecked_ratings int)
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  select * into t from public.tournaments where id = p_tournament;
  perform private.require_staff(p_tournament);
  return query
  select tm.event_id, tm.id, tm.name, private.team_problems(tm.id, e, t),
         (select count(*)::int from public.team_players tp
          join public.players p on p.id = tp.player_id
          where tp.team_id = tm.id and e.skill_rule <> 'open' and p.rating_checked_at is null)
  from public.teams tm
  join public.events e on e.id = tm.event_id
  where e.tournament_id = p_tournament and tm.withdrawn_at is null
    and exists (select 1 from public.team_players tp where tp.team_id = tm.id);
end $$;

-- Staff: players entered but not on a team yet (waiting for a partner, or on
-- the waitlist) who don't meet their division's rules.
create function public.entry_eligibility(p_tournament uuid)
returns table (registration_id uuid, event_id uuid, event_name text, player_id uuid, player_name text, problem text)
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  select * into t from public.tournaments where id = p_tournament;
  perform private.require_staff(p_tournament);
  return query
  select x.registration_id, x.event_id, x.event_name, x.player_id, x.player_name, x.problem
  from (
    select re.registration_id, re.event_id, e.name as event_name, p.id as player_id,
           p.first_name || ' ' || p.last_name as player_name,
           private.entry_problem(e, t, p.gender, p.birth_date, p.dupr_doubles, p.dupr_singles, p.self_rating, p.dupr_id) as problem
    from public.registration_entries re
    join public.registrations r on r.id = re.registration_id
    join public.players p on p.id = r.player_id
    join public.events e on e.id = re.event_id
    where r.tournament_id = p_tournament and re.team_id is null and r.status in ('paid', 'waitlisted')
  ) x
  where x.problem is not null
  order by x.player_name;
end $$;

-- ---------------------------------------------------------------------------
-- Moving a team
-- ---------------------------------------------------------------------------

-- Why this team can't move to this division, or null. Division rules and
-- limits don't stop a move: those are the director's call.
create function private.team_move_block(p_team public.teams, p_target public.events) returns text
language plpgsql stable set search_path = '' as $$
declare
  source public.events;
  v_players int;
  v_names text;
begin
  select * into source from public.events where id = p_team.event_id;
  if p_team.withdrawn_at is not null then
    return p_team.name || ' was dropped. Put them back first.';
  end if;
  if exists (select 1 from public.matches m where p_team.id in (m.team1_id, m.team2_id))
     and (source.started_at is not null or exists (
       select 1 from public.matches m where m.event_id = source.id and m.status = 'completed' and private.was_played(m))) then
    return p_team.name || ' has already started in ' || source.name || '. Drop them there and add them to the new division instead.';
  end if;
  if p_target.started_at is not null or exists (
    select 1 from public.matches m where m.event_id = p_target.id and m.status = 'completed' and private.was_played(m)) then
    return p_target.name || ' has already started.';
  end if;
  select count(*) into v_players from public.team_players where team_id = p_team.id;
  if p_target.kind = 'singles' and v_players > 1 then
    return p_target.name || ' is a singles division.';
  end if;
  if p_target.kind <> 'singles' and v_players < 2 then
    return p_target.name || ' is a doubles division and ' || p_team.name || ' has one player.';
  end if;
  select string_agg(distinct p.first_name || ' ' || p.last_name, ', ') into v_names
  from public.team_players tp
  join public.players p on p.id = tp.player_id
  where tp.team_id = p_team.id and (
    exists (select 1 from public.team_players o join public.teams ot on ot.id = o.team_id
            where o.player_id = tp.player_id and ot.event_id = p_target.id and ot.withdrawn_at is null)
    or exists (select 1 from public.registration_entries re join public.registrations r on r.id = re.registration_id
               where r.player_id = tp.player_id and re.event_id = p_target.id));
  if v_names is not null then
    return v_names || ' already entered ' || p_target.name || '.';
  end if;
  return null;
end $$;

-- Staff: the other divisions this team could move to, and how each would go.
-- clears_schedule: a schedule built ahead of time is cleared by the move and
-- rebuilds when the division starts.
create function public.team_move_options(p_team uuid)
returns table (event_id uuid, event_name text, problems text[], blocked text, teams int, max_teams int, clears_schedule boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  tm public.teams;
  t public.tournaments;
begin
  select * into tm from public.teams where id = p_team;
  if not found then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(tm.tournament_id);
  select * into t from public.tournaments where id = tm.tournament_id;
  return query
  select e.id, e.name, private.team_problems(tm.id, e, t), private.team_move_block(tm, e),
         (select count(*)::int from public.teams o where o.event_id = e.id and o.withdrawn_at is null),
         e.max_teams,
         exists (select 1 from public.matches m where m.event_id = e.id)
           or exists (select 1 from public.matches m where tm.id in (m.team1_id, m.team2_id))
  from public.events e
  where e.tournament_id = tm.tournament_id and e.id <> tm.event_id
  order by e.sort_order, e.name;
end $$;

-- Staff: move a team, partner included, to another division. Seed and pool
-- are cleared, check-ins are kept, the price doesn't change. A schedule built
-- ahead of time in either division is cleared and rebuilds when it starts.
-- Tells the players. Returns {problems, cleared} for the new division.
create function public.move_team(p_team uuid, p_to_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  tm public.teams;
  source public.events;
  target public.events;
  t public.tournaments;
  v_block text;
  v_cleared text[] := '{}';
begin
  select * into tm from public.teams where id = p_team;
  if not found then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(tm.tournament_id);
  perform private.lock_tournament(tm.tournament_id);
  select * into tm from public.teams where id = p_team;
  select * into target from public.events where id = p_to_event;
  if not found or target.tournament_id <> tm.tournament_id then
    raise exception 'That division isn''t part of this tournament' using errcode = '22023';
  end if;
  select * into t from public.tournaments where id = tm.tournament_id;
  select * into source from public.events where id = tm.event_id;
  if source.id = target.id then
    return jsonb_build_object('problems', to_jsonb(private.team_problems(tm.id, target, t)), 'cleared', '[]'::jsonb);
  end if;
  v_block := private.team_move_block(tm, target);
  if v_block is not null then
    raise exception '%', v_block using errcode = '55000';
  end if;

  if exists (select 1 from public.matches m where tm.id in (m.team1_id, m.team2_id)) then
    perform public.clear_matches(source.id);
    v_cleared := v_cleared || source.name;
  end if;
  if exists (select 1 from public.matches m where m.event_id = target.id) then
    perform public.clear_matches(target.id);
    v_cleared := v_cleared || target.name;
  end if;

  update public.teams set event_id = target.id, seed = null, pool = null, merged_from_event_id = null where id = tm.id;
  update public.registration_entries set event_id = target.id, merged_from_event_id = null where team_id = tm.id;

  insert into public.notifications (tournament_id, player_id, kind, via, subject, body)
  select tm.tournament_id, p.id, 'division_moved', 'email', 'Your division has changed',
         tm.name || ' has been moved from ' || source.name || ' to ' || target.name || ' at ' || t.name || '.'
  from public.team_players tp
  join public.players p on p.id = tp.player_id
  where tp.team_id = tm.id and p.email is not null;

  perform private.auto_assign(tm.tournament_id);
  return jsonb_build_object('problems', to_jsonb(private.team_problems(tm.id, target, t)), 'cleared', to_jsonb(v_cleared));
end $$;

-- As before (partner_pay_and_questions), with a team's move in move_team.
create or replace function public.move_registration_entry(p_registration uuid, p_from_event uuid, p_to_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
  e public.registration_entries;
  target public.events;
begin
  select * into r from public.registrations where id = p_registration;
  if not found then
    raise exception 'Registration not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(r.tournament_id);
  perform private.lock_tournament(r.tournament_id);
  select * into e from public.registration_entries where registration_id = p_registration and event_id = p_from_event;
  if not found then
    raise exception 'That event isn''t part of this registration' using errcode = 'P0002';
  end if;
  select * into target from public.events where id = p_to_event;
  if not found or target.tournament_id <> r.tournament_id then
    raise exception 'That division isn''t part of this tournament' using errcode = '22023';
  end if;
  if p_from_event = p_to_event then
    return;
  end if;

  if e.team_id is null then
    if e.paid_by_registration_id is not null or (e.partner_paid_cents > 0 and not private.cover_unclaimed(e.registration_id, e.event_id, e.partner_paid_cents)) then
      raise exception 'This entry was paid together with their partner. Pair them as a team first, then move the team.'
        using errcode = '55000';
    end if;
    if exists (select 1 from public.registration_entries where registration_id = p_registration and event_id = p_to_event) then
      raise exception 'Already entered in %', target.name using errcode = '55000';
    end if;
    update public.registration_entries set event_id = p_to_event
    where registration_id = p_registration and event_id = p_from_event;
    if r.status = 'paid' and not e.waitlisted then
      perform private.form_teams(p_registration);
    end if;
    return;
  end if;

  perform public.move_team(e.team_id, p_to_event);
end $$;

-- ---------------------------------------------------------------------------
-- Refreshing ratings
-- ---------------------------------------------------------------------------

-- Staff: everyone in the tournament whose rating could be refreshed.
create function public.dupr_refresh_list(p_tournament uuid)
returns table (player_id uuid, first_name text, last_name text, dupr_id text, dupr_doubles numeric, dupr_singles numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff(p_tournament);
  return query
  select p.id, p.first_name, p.last_name, upper(p.dupr_id), p.dupr_doubles, p.dupr_singles
  from public.players p
  where p.id in (
    select tp.player_id from public.team_players tp
    join public.teams tm on tm.id = tp.team_id
    where tm.tournament_id = p_tournament and tm.withdrawn_at is null
    union
    select r.player_id from public.registrations r
    where r.tournament_id = p_tournament and r.status in ('paid', 'waitlisted', 'pending')
  )
  order by p.last_name, p.first_name;
end $$;

-- As before (dupr), plus: a row can name the player by player_id instead of
-- DUPR ID, it notes when ratings were last refreshed, and returns what changed
-- as {updated, unknown, changes: [{player_id, name, doubles_from, doubles_to,
-- singles_from, singles_to}]}.
create or replace function public.import_dupr_ratings(p_tournament uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_updated int;
  v_unknown text[];
  v_changes jsonb;
begin
  perform private.require_staff(p_tournament);
  with rows as (
    select upper(nullif(trim(x.dupr_id), '')) as dupr_id, x.player_id, x.doubles, x.singles
    from jsonb_to_recordset(p_rows) as x(dupr_id text, player_id uuid, doubles numeric, singles numeric)
    where nullif(trim(x.dupr_id), '') is not null or x.player_id is not null
  ),
  ours as (
    select distinct p.id, upper(p.dupr_id) as dupr_id
    from public.players p
    join public.team_players tp on tp.player_id = p.id
    join public.teams tm on tm.id = tp.team_id
    where tm.tournament_id = p_tournament
    union
    select p.id, upper(p.dupr_id)
    from public.players p
    join public.registrations r on r.player_id = p.id
    where r.tournament_id = p_tournament
  ),
  matched as (
    select o.id, r.doubles, r.singles
    from rows r join ours o on o.id = r.player_id or o.dupr_id = r.dupr_id
  ),
  before as (
    select p.id, p.first_name || ' ' || p.last_name as name, p.dupr_doubles, p.dupr_singles
    from public.players p where p.id in (select m.id from matched m)
  ),
  updated as (
    update public.players p
    set dupr_doubles = coalesce(m.doubles, p.dupr_doubles),
        dupr_singles = coalesce(m.singles, p.dupr_singles),
        rating_checked_at = now()
    from matched m
    where p.id = m.id
    returning p.id, p.dupr_doubles, p.dupr_singles
  )
  select (select count(*) from updated),
         (select array_agg(r.dupr_id) from rows r
          where r.dupr_id is not null and not exists (select 1 from ours o where o.dupr_id = r.dupr_id)),
         (select jsonb_agg(jsonb_build_object(
                   'player_id', u.id, 'name', b.name,
                   'doubles_from', b.dupr_doubles, 'doubles_to', u.dupr_doubles,
                   'singles_from', b.dupr_singles, 'singles_to', u.dupr_singles) order by b.name)
          from updated u join before b on b.id = u.id
          where u.dupr_doubles is distinct from b.dupr_doubles or u.dupr_singles is distinct from b.dupr_singles)
  into v_updated, v_unknown, v_changes;
  if v_updated > 0 then
    update public.tournaments set ratings_refreshed_at = now() where id = p_tournament;
  end if;
  return jsonb_build_object('updated', v_updated, 'unknown', coalesce(to_jsonb(v_unknown), '[]'::jsonb),
                            'changes', coalesce(v_changes, '[]'::jsonb));
end $$;
