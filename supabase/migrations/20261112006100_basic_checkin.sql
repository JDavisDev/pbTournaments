-- Basic (simple) tournaments can use check-in if the director wants it.
-- Off (the default): whoever is entered is there, as before. On: players
-- check in at the desk before their team goes on court, as at a full
-- tournament. There's still no check-in deadline or forfeit.

alter table public.tournaments add column basic_checkin boolean not null default false;

-- As before (simple_tournaments), unless the director turned check-in on.
create or replace function private.simple_check_in() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tournament uuid;
begin
  select tm.tournament_id into v_tournament
  from public.teams tm join public.tournaments t on t.id = tm.tournament_id
  where tm.id = new.team_id and t.simple and not t.basic_checkin;
  if v_tournament is not null then
    perform private.set_player_checked_in(v_tournament, new.player_id, true);
  end if;
  return null;
end $$;

-- Staff: turn check-in on or off at a Basic tournament. On clears everyone's
-- check-in, so it's only allowed before any match has gone on court. Off
-- checks everyone in and puts waiting matches on court.
create function public.set_basic_checkin(p_tournament uuid, p_on boolean) returns public.tournaments
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
  v_team uuid;
begin
  perform private.require_staff(p_tournament);
  select * into t from public.tournaments where id = p_tournament for update;
  if not t.simple then
    raise exception 'Only Basic tournaments can turn check-in on or off' using errcode = '55000';
  end if;
  if t.basic_checkin = p_on then
    return t;
  end if;
  if p_on then
    if exists (select 1 from public.matches m where m.tournament_id = p_tournament
               and m.status in ('assigned', 'in_progress', 'completed')) then
      raise exception 'Turn check-in on before play starts' using errcode = '55000';
    end if;
    delete from public.player_checkins where tournament_id = p_tournament;
    update public.teams set checked_in_at = null where tournament_id = p_tournament;
  else
    for v_team in select id from public.teams where tournament_id = p_tournament and withdrawn_at is null loop
      perform private.set_team_checked_in(p_tournament, v_team, true);
    end loop;
  end if;
  update public.tournaments set basic_checkin = p_on where id = p_tournament returning * into t;
  if not p_on then
    perform private.auto_assign(p_tournament);
  end if;
  return t;
end $$;
revoke execute on function public.set_basic_checkin(uuid, boolean) from public, anon;
grant execute on function public.set_basic_checkin(uuid, boolean) to authenticated;
