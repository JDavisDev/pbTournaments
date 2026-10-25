-- DUPR: player IDs and ratings, checking every team against its division's
-- rules, and grouping finished matches for DUPR's club CSV upload.
--
-- DUPR has no public API for ratings, so ratings come from the player at
-- registration, from the director, or from a pasted list (import_dupr_ratings).
-- A rating the director has confirmed has rating_checked_at set.

alter table public.players add column rating_checked_at timestamptz;

alter table public.tournaments
  add column location text,
  -- How games were scored, for DUPR: SIDEOUT (traditional) or RALLY.
  add column dupr_score_type text not null default 'SIDEOUT' check (dupr_score_type in ('SIDEOUT', 'RALLY'));

-- When the director downloaded this match in a DUPR upload file.
alter table public.matches add column dupr_exported_at timestamptz;

grant update (rating_checked_at) on public.players to authenticated;
grant update (location, dupr_score_type) on public.tournaments to authenticated;
grant update (rating_tolerance, play_up_limit, require_dupr_id, team_rating_max, team_age_min)
  on public.events to authenticated;
grant select (dupr_exported_at) on public.matches to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Eligibility
-- ---------------------------------------------------------------------------

-- Staff: every team in the tournament checked against its division with the
-- players' current details: each player (gender, age, rating, DUPR ID) and,
-- for doubles, the team rules (combined rating, combined age, mixed pairs).
-- Teams with no problems have an empty list.
create function public.division_eligibility(p_tournament uuid)
returns table (event_id uuid, team_id uuid, team_name text, problems text[], unchecked_ratings int)
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  select * into t from public.tournaments where id = p_tournament;
  perform private.require_staff(p_tournament);
  return query
  with members as (
    select tm.id as team_id, tm.event_id, tm.name as team_name, e as ev, p,
           case when e.kind = 'singles' then p.dupr_singles else p.dupr_doubles end as rating,
           extract(year from age(
             case when e.age_basis = 'year_end'
                  then make_date(extract(year from t.starts_on)::int, 12, 31) else t.starts_on end,
             p.birth_date))::int as age
    from public.teams tm
    join public.events e on e.id = tm.event_id
    join public.team_players tp on tp.team_id = tm.id
    join public.players p on p.id = tp.player_id
    where e.tournament_id = p_tournament and tm.withdrawn_at is null
  ),
  player_problems as (
    select m.team_id, (m.p).first_name || ' ' || (m.p).last_name || ': ' || private.entry_problem(
             m.ev, t, (m.p).gender, (m.p).birth_date, (m.p).dupr_doubles, (m.p).dupr_singles, (m.p).self_rating, (m.p).dupr_id
           ) as problem
    from members m
  ),
  teams as (
    select m.team_id, m.event_id, m.team_name, (array_agg(m.ev))[1] as ev,
           count(*)::int as players,
           sum(m.rating) as rating_sum, count(m.rating)::int as rated,
           sum(m.age) as age_sum, count(m.age)::int as aged,
           count(*) filter (where (m.p).gender = 'male')::int as men,
           count(*) filter (where (m.p).gender = 'female')::int as women,
           count(*) filter (where (m.ev).skill_rule <> 'open' and (m.p).rating_checked_at is null)::int as unchecked
    from members m
    group by m.team_id, m.event_id, m.team_name
  )
  select tm.event_id, tm.team_id, tm.team_name,
         array_remove(array_cat(
           coalesce((select array_agg(pp.problem order by pp.problem) from player_problems pp
                     where pp.team_id = tm.team_id and pp.problem is not null), '{}'),
           array[
             case when (tm.ev).team_rating_max is not null and tm.rated = tm.players
                       and tm.rating_sum >= (tm.ev).team_rating_max
                  then format('Team rating %s is over the %s limit', round(tm.rating_sum, 2), (tm.ev).team_rating_max) end,
             case when (tm.ev).team_rating_max is not null and tm.rated < tm.players
                  then 'Team rating can''t be checked: a player has no rating' end,
             case when (tm.ev).team_age_min is not null and tm.aged = tm.players
                       and tm.age_sum < (tm.ev).team_age_min
                  then format('Combined age %s is under %s', tm.age_sum, (tm.ev).team_age_min) end,
             case when (tm.ev).team_age_min is not null and tm.aged < tm.players
                  then 'Combined age can''t be checked: a birth date is missing' end,
             case when (tm.ev).gender = 'mixed' and tm.players = 2 and not (tm.men = 1 and tm.women = 1)
                  then 'Mixed doubles needs one man and one woman' end
           ]), null),
         tm.unchecked
  from teams tm;
end $$;

-- Staff: set confirmed DUPR ratings from a pasted list:
-- [{"dupr_id": "7K2QXW", "doubles": 3.82, "singles": 3.6}, ...]. Matches
-- players in this tournament by DUPR ID. Returns {updated, unknown: [ids]}.
create function public.import_dupr_ratings(p_tournament uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_updated int;
  v_unknown text[];
begin
  perform private.require_staff(p_tournament);
  with rows as (
    select upper(trim(x.dupr_id)) as dupr_id, x.doubles, x.singles
    from jsonb_to_recordset(p_rows) as x(dupr_id text, doubles numeric, singles numeric)
    where nullif(trim(x.dupr_id), '') is not null
  ),
  ours as (
    select distinct p.id, upper(p.dupr_id) as dupr_id
    from public.players p
    join public.team_players tp on tp.player_id = p.id
    join public.teams tm on tm.id = tp.team_id
    where tm.tournament_id = p_tournament and p.dupr_id is not null
    union
    select p.id, upper(p.dupr_id)
    from public.players p
    join public.registrations r on r.player_id = p.id
    where r.tournament_id = p_tournament and p.dupr_id is not null
  ),
  updated as (
    update public.players p
    set dupr_doubles = coalesce(r.doubles, p.dupr_doubles),
        dupr_singles = coalesce(r.singles, p.dupr_singles),
        rating_checked_at = now()
    from rows r join ours o on o.dupr_id = r.dupr_id
    where p.id = o.id
    returning p.id
  )
  select (select count(*) from updated),
         (select array_agg(r.dupr_id) from rows r where not exists (select 1 from ours o where o.dupr_id = r.dupr_id))
  into v_updated, v_unknown;
  return jsonb_build_object('updated', v_updated, 'unknown', coalesce(to_jsonb(v_unknown), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Results for DUPR
-- ---------------------------------------------------------------------------

-- Staff: every played match (not forfeits or byes) with what DUPR's club
-- "Import Matches via CSV" needs: match type, event, date, the players' names
-- and DUPR IDs, game scores (team A = team 1), location and score type.
-- missing_ids lists players without a DUPR ID; DUPR rejects those rows.
create function public.dupr_results(p_tournament uuid)
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
  join public.events e on e.id = m.event_id
  join sides a on a.id = m.id and a.slot = 1
  join sides b on b.id = m.id and b.slot = 2
  order by e.sort_order, m.completed_at;
end $$;

-- Staff: mark matches as downloaded for DUPR (or clear the mark).
create function public.mark_dupr_exported(p_tournament uuid, p_matches uuid[], p_exported boolean default true)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  perform private.require_staff(p_tournament);
  update public.matches
  set dupr_exported_at = case when p_exported then now() end
  where tournament_id = p_tournament and id = any (p_matches);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- The Players page shows each player's DUPR ID and ratings.
create or replace view public.team_roster with (security_invoker = true) as
select t.id as team_id,
       t.tournament_id,
       t.event_id,
       e.name as event_name,
       e.sort_order as event_sort_order,
       t.name,
       t.seed,
       t.pool,
       t.checked_in_at,
       t.withdrawn_at,
       (select count(*) from public.matches m where t.id in (m.team1_id, m.team2_id))::int as match_count,
       coalesce(jsonb_agg(jsonb_build_object(
                  'player_id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
                  'phone', p.phone, 'email', p.email, 'sms_opt_in', p.sms_opt_in,
                  'checked_in', pc.player_id is not null,
                  'dupr_id', p.dupr_id, 'dupr_doubles', p.dupr_doubles, 'dupr_singles', p.dupr_singles,
                  'self_rating', p.self_rating, 'rating_checked_at', p.rating_checked_at
                ) order by p.last_name) filter (where p.id is not null), '[]'::jsonb) as players
from public.teams t
join public.events e on e.id = t.event_id
left join public.team_players tp on tp.team_id = t.id
left join public.players p on p.id = tp.player_id
left join public.player_checkins pc on pc.tournament_id = t.tournament_id and pc.player_id = p.id
group by t.id, e.name, e.sort_order;
