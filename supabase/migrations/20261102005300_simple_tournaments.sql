-- Pasted teams in one call, and simple tournaments.
--
-- A simple tournament is free and has no registration, payments or texts: the
-- director pastes in the teams and runs pools and brackets on the same engine.
-- Its pages are public once published (status 'registration' means published
-- here), players find their names on the court board, and the director can
-- let anyone with the link enter scores.

alter table public.tournaments
  add column simple boolean not null default false,
  -- Simple tournaments: anyone with the link may enter the score of a match on court.
  add column anyone_scores boolean not null default false;
grant update (anyone_scores) on public.tournaments to authenticated;

-- ---------------------------------------------------------------------------
-- Pasted teams
-- ---------------------------------------------------------------------------

-- Staff: adds teams pasted in Setup, all or none (one request, one
-- transaction). p_teams = [{name, players: [{first_name, last_name}]}], best
-- seed first, seeded from p_first_seed.
create function public.add_teams(p_event uuid, p_teams jsonb, p_first_seed int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_team jsonb;
  v_player jsonb;
  v_team_id uuid;
  v_seed int := p_first_seed;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  if jsonb_typeof(p_teams) is distinct from 'array' or jsonb_array_length(p_teams) not between 1 and 256 then
    raise exception 'Paste between 1 and 256 teams at a time' using errcode = '22023';
  end if;
  for v_team in select value from jsonb_array_elements(p_teams) loop
    if length(trim(coalesce(v_team ->> 'name', ''))) not between 1 and 200
       or jsonb_typeof(v_team -> 'players') is distinct from 'array'
       or jsonb_array_length(v_team -> 'players') not between 1 and 4 then
      raise exception 'Each line needs one to four names' using errcode = '22023';
    end if;
    insert into public.teams (event_id, name, seed)
    values (p_event, trim(v_team ->> 'name'), v_seed)
    returning id into v_team_id;
    for v_player in select value from jsonb_array_elements(v_team -> 'players') loop
      with p as (
        insert into public.players (first_name, last_name)
        values (left(coalesce(nullif(trim(v_player ->> 'first_name'), ''), '-'), 100),
                left(coalesce(nullif(trim(v_player ->> 'last_name'), ''), '-'), 100))
        returning id
      )
      insert into public.team_players (team_id, player_id) select v_team_id, p.id from p;
    end loop;
    v_seed := v_seed + 1;
  end loop;
  return jsonb_array_length(p_teams);
end $$;
revoke execute on function public.add_teams(uuid, jsonb, int) from public, anon;
grant execute on function public.add_teams(uuid, jsonb, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Simple tournaments
-- ---------------------------------------------------------------------------

-- Signed in: a simple tournament, a draft with one division, ready for Setup.
create function public.new_simple_tournament(p_organization uuid default null) returns public.tournaments
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  t := public.new_tournament(p_organization);
  update public.tournaments
  set simple = true, texts_enabled = false, checkin_grace_minutes = null,
      entry_fee_cents = 0, extra_event_fee_cents = 0, price_schedule = '[]'::jsonb
  where id = t.id
  returning * into t;
  update public.events
  set name = 'Doubles', gender = 'open', skill_rule = 'open', skill_level = null, skill_level_to = null,
      dupr_rated = false, require_dupr_id = false
  where tournament_id = t.id;
  return t;
end $$;
revoke execute on function public.new_simple_tournament(uuid) from public, anon;
grant execute on function public.new_simple_tournament(uuid) to authenticated;

-- Nobody checks in at a simple tournament: whoever is entered is there.
create function private.simple_check_in() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tournament uuid;
begin
  select tm.tournament_id into v_tournament
  from public.teams tm join public.tournaments t on t.id = tm.tournament_id
  where tm.id = new.team_id and t.simple;
  if v_tournament is not null then
    perform private.set_player_checked_in(v_tournament, new.player_id, true);
  end if;
  return null;
end $$;

create trigger team_players_simple_check_in after insert on public.team_players
  for each row execute function private.simple_check_in();

-- No registrations: entries are pasted in by the director.
create function private.no_simple_registrations() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.tournaments where id = new.tournament_id and simple) then
    raise exception 'This tournament doesn’t take registrations' using errcode = '55000';
  end if;
  return new;
end $$;

create trigger registrations_not_simple before insert on public.registrations
  for each row execute function private.no_simple_registrations();

-- As before (platform_fees), plus that simple tournaments send nothing: no
-- texts, emails or match alerts. Players watch the court board.
create or replace function private.skip_disabled_texts() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from public.tournaments
    where id = new.tournament_id and (simple or (new.via = 'sms' and not texts_enabled))
  ) then
    return null;
  end if;
  return new;
end $$;

-- As before (platform_fees), plus that simple tournaments are free.
create or replace function private.setup_fee_due(t public.tournaments) returns int
language sql stable set search_path = '' as $$
  select case when t.is_demo or t.simple or t.setup_paid_at is not null then 0
              else (select setup_fee_cents from private.platform_pricing) end
$$;

-- As before (refunds_fees_finance), plus that simple tournaments are free.
create or replace function private.player_fee_rate(t public.tournaments) returns int
language sql stable set search_path = '' as $$
  select case when t.is_demo or t.simple then 0
              else pp.per_player_cents + case when t.texts_enabled then pp.texting_per_player_cents else 0 end end
  from private.platform_pricing pp
$$;

-- As before (refunds_fees_finance), not counting simple tournaments' players.
create or replace function private.uncovered_players(p_tournament uuid) returns int
language sql stable set search_path = '' as $$
  select count(distinct tp.player_id)::int
  from public.teams tm
  join public.team_players tp on tp.team_id = tm.id
  join public.tournaments t on t.id = tm.tournament_id
  where tm.tournament_id = p_tournament and tm.withdrawn_at is null and not t.is_demo and not t.simple
    and not exists (select 1 from public.registrations r
                    where r.tournament_id = p_tournament and r.player_id = tp.player_id and r.status = 'paid'
                      and coalesce(r.platform_fee_cents, 0) > 0)
    and not exists (select 1 from public.registrations r
                    join public.registration_entries re on re.registration_id = r.id
                    join public.registrations payer on payer.id = re.paid_by_registration_id
                    where r.tournament_id = p_tournament and r.player_id = tp.player_id and payer.status = 'paid'
                      and coalesce(payer.platform_fee_cents, 0) > 0)
$$;

-- As before (paper_merge_self_checkin), plus that anyone may score a match on
-- court at a simple tournament that allows it, signed in or not.
create or replace function public.report_score(p_match uuid, p_games jsonb) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  v_staff boolean;
begin
  m := private.lock_match(p_match);
  v_staff := public.is_court_monitor(m.tournament_id);
  if not (v_staff or private.plays_in_match(p_match)
          or exists (select 1 from public.tournaments t where t.id = m.tournament_id and t.simple and t.anyone_scores)) then
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
grant execute on function public.report_score(uuid, jsonb) to anon;
