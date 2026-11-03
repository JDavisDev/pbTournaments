-- Players act on their own entries through their account: their players row,
-- or one under their login's email.
--   * Self check-in needs an account: a logged-in player checks in their own
--     entries and nobody else's. Directors and court monitors can still find
--     and check in anyone from the same link.
--   * Score entry: a logged-in player in the match reports its score from
--     their team page, unless a simple tournament keeps scores to directors.

-- Signed in and theirs: the player row is the caller's, or has their email.
create function private.is_my_player(p_player uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.players p
    where p.id = p_player
      and (p.user_id = auth.uid()
           or lower(p.email) = (select lower(u.email) from auth.users u where u.id = auth.uid()))
  )
$$;

-- As before (paper_merge_self_checkin), plus whether the caller is staff (they
-- can find anyone by name).
create or replace function public.self_checkin_info(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('tournament_name', t.name, 'staff', public.is_court_monitor(t.id))
  from public.tournaments t where t.id = private.self_checkin_tournament(p_code)
$$;

-- As before (paper_merge_self_checkin), for staff only: players find
-- themselves with my_self_checkin.
create or replace function public.self_checkin_search(p_code text, p_query text)
returns table (player_id uuid, first_name text, last_name text, teams text[], checked_in boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.first_name, p.last_name,
         array_agg(e.name || ': ' || tm.name order by e.sort_order),
         exists (select 1 from public.player_checkins pc where pc.tournament_id = tm.tournament_id and pc.player_id = p.id)
  from public.teams tm
  join public.events e on e.id = tm.event_id
  join public.team_players tp on tp.team_id = tm.id
  join public.players p on p.id = tp.player_id
  where tm.tournament_id = private.self_checkin_tournament(p_code)
    and public.is_court_monitor(tm.tournament_id)
    and tm.withdrawn_at is null
    and length(trim(p_query)) >= 2
    and strpos(lower(p.first_name || ' ' || p.last_name), lower(trim(p_query))) > 0
  group by p.id, tm.tournament_id
  order by p.last_name, p.first_name
  limit 15
$$;

-- As before (paper_merge_self_checkin), plus who may: the logged-in player
-- themselves, or staff.
create or replace function public.self_check_in(p_code text, p_player uuid, p_checked_in boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_tournament uuid := private.self_checkin_tournament(p_code);
begin
  if v_tournament is null then
    raise exception 'Self check-in isn’t on right now. Please see the desk.' using errcode = '55000';
  end if;
  if auth.uid() is null then
    raise exception 'Log in to check in.' using errcode = '42501';
  end if;
  if not (public.is_court_monitor(v_tournament) or private.is_my_player(p_player)) then
    raise exception 'You can only check yourself in. Please see the desk.' using errcode = '42501';
  end if;
  perform private.lock_tournament(v_tournament);
  if not exists (
    select 1 from public.team_players tp join public.teams tm on tm.id = tp.team_id
    where tp.player_id = p_player and tm.tournament_id = v_tournament and tm.withdrawn_at is null
  ) then
    raise exception 'That player isn’t entered here. Please see the desk.' using errcode = 'P0002';
  end if;
  perform private.set_player_checked_in(v_tournament, p_player, p_checked_in);
  perform private.auto_assign(v_tournament);
end $$;

revoke execute on function public.self_check_in(text, uuid, boolean), public.self_checkin_search(text, text) from public, anon;
grant execute on function public.self_check_in(text, uuid, boolean), public.self_checkin_search(text, text) to authenticated;

-- As before (core engine), counting a player under the login's email too.
create or replace function private.plays_in_match(p_match uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.matches m
    join public.team_players tp on tp.team_id in (m.team1_id, m.team2_id)
    where m.id = p_match and private.is_my_player(tp.player_id)
  )
$$;

-- Signed in: the caller's teams in this tournament (not withdrawn).
create function public.my_teams(p_tournament uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct tm.id
  from public.teams tm join public.team_players tp on tp.team_id = tm.id
  where tm.tournament_id = p_tournament and tm.withdrawn_at is null and private.is_my_player(tp.player_id)
$$;
revoke execute on function public.my_teams(uuid) from public, anon;
grant execute on function public.my_teams(uuid) to authenticated;

-- As before (simple_tournaments), plus that a simple tournament set to
-- directors only keeps its players from scoring too.
create or replace function public.report_score(p_match uuid, p_games jsonb) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  t public.tournaments;
  v_staff boolean;
begin
  m := private.lock_match(p_match);
  select * into t from public.tournaments where id = m.tournament_id;
  v_staff := public.is_court_monitor(m.tournament_id);
  if not (v_staff or (t.simple and t.anyone_scores)
          or (private.plays_in_match(p_match) and not (t.simple and not t.anyone_scores))) then
    raise exception 'Only players in this match or tournament staff can report its score' using errcode = '42501';
  end if;
  if not (m.status in ('assigned', 'in_progress') or (v_staff and m.status = 'queued')) then
    raise exception 'This match is not on a court, so it can''t be scored' using errcode = '55000';
  end if;
  perform private.finish_match(p_match, private.score_winner(m, p_games), p_games, false);
  perform private.auto_assign(m.tournament_id);
  select * into m from public.matches where id = p_match;
  return m;
end $$;
