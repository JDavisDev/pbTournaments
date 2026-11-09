-- As before (player_accounts), plus the tournament's id, so a player who has
-- checked in can tap Done and go to its page.
create or replace function public.self_checkin_info(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('tournament_id', t.id, 'tournament_name', t.name, 'staff', public.is_court_monitor(t.id))
  from public.tournaments t where t.id = private.self_checkin_tournament(p_code)
$$;
