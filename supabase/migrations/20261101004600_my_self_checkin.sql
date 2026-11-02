-- Scanning the check-in code while logged in: who that account is in this
-- tournament, so they only have to confirm. A registration has its own player
-- record, so it's found by the account's email as well as a linked user.
create function public.my_self_checkin(p_code text)
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
    and tm.withdrawn_at is null
    and auth.uid() is not null
    and (p.user_id = auth.uid()
         or lower(p.email) = (select lower(u.email) from auth.users u where u.id = auth.uid()))
  group by p.id, tm.tournament_id
  order by p.last_name, p.first_name
$$;
