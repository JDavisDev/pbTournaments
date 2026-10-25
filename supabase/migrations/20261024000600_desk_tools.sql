-- Tools for running the day: the check-in desk, swapping and dropping teams
-- or players, and messages to players.

-- ---------------------------------------------------------------------------
-- Check-in desk
-- ---------------------------------------------------------------------------

-- Staff check players in as they arrive (or undo it). A team is ready once
-- all of its players are in.
create function public.check_in_player(p_tournament uuid, p_player uuid, p_checked_in boolean default true)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_staff(p_tournament);
  perform private.lock_tournament(p_tournament);
  perform private.set_player_checked_in(p_tournament, p_player, p_checked_in);
  perform private.auto_assign(p_tournament);
end $$;

-- Every player entered in a tournament, with check-in time and their teams.
create view public.checkin_roster with (security_invoker = true) as
select t.tournament_id,
       p.id as player_id,
       p.first_name,
       p.last_name,
       p.phone,
       pc.checked_in_at,
       jsonb_agg(jsonb_build_object('team_id', t.id, 'team_name', t.name, 'event_id', e.id, 'event_name', e.name)
                 order by e.sort_order) as teams
from public.teams t
join public.events e on e.id = t.event_id
join public.team_players tp on tp.team_id = t.id
join public.players p on p.id = tp.player_id
left join public.player_checkins pc on pc.tournament_id = t.tournament_id and pc.player_id = p.id
where t.withdrawn_at is null
group by t.tournament_id, p.id, pc.checked_in_at;

-- How ready each division is: players and teams checked in.
create view public.division_checkin with (security_invoker = true) as
select e.tournament_id,
       e.id as event_id,
       e.name as event_name,
       e.sort_order,
       e.not_before,
       count(distinct t.id)::int as teams,
       (count(distinct t.id) filter (where t.checked_in_at is not null))::int as teams_ready,
       count(distinct tp.player_id)::int as players,
       (count(distinct tp.player_id) filter (where pc.player_id is not null))::int as players_in
from public.events e
left join public.teams t on t.event_id = e.id and t.withdrawn_at is null
left join public.team_players tp on tp.team_id = t.id
left join public.player_checkins pc on pc.tournament_id = e.tournament_id and pc.player_id = tp.player_id
group by e.id;

-- Every team with its players (contact details, checked in or not), for the
-- director's Players page.
create view public.team_roster with (security_invoker = true) as
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
                  'checked_in', pc.player_id is not null
                ) order by p.last_name) filter (where p.id is not null), '[]'::jsonb) as players
from public.teams t
join public.events e on e.id = t.event_id
left join public.team_players tp on tp.team_id = t.id
left join public.players p on p.id = tp.player_id
left join public.player_checkins pc on pc.tournament_id = t.tournament_id and pc.player_id = p.id
group by t.id, e.name, e.sort_order;

-- ---------------------------------------------------------------------------
-- Swaps and drops
-- ---------------------------------------------------------------------------

-- Drop a team: it's withdrawn, and each of its matches still to be played
-- (including one on a court now) is forfeited to the opponent, who moves on.
-- Bracket matches it would reach later are forfeited when they fill.
-- Returns how many matches were forfeited.
create function public.withdraw_team(p_team uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  t public.teams;
  m public.matches;
  v_forfeits int := 0;
begin
  select * into t from public.teams where id = p_team;
  if not found then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(t.tournament_id);
  perform private.lock_tournament(t.tournament_id);
  if t.withdrawn_at is not null then
    return 0;
  end if;

  update public.teams set withdrawn_at = private.clock(), checked_in_at = null where id = p_team;
  for m in
    select * from public.matches
    where p_team in (team1_id, team2_id)
      and status in ('queued', 'assigned', 'in_progress')
      and team1_id is not null and team2_id is not null
    order by queue_seq
  loop
    perform private.finish_match(m.id, case when m.team1_id = p_team then m.team2_id else m.team1_id end, null, true);
    v_forfeits := v_forfeits + 1;
  end loop;
  perform private.auto_assign(t.tournament_id);
  return v_forfeits;
end $$;

-- Swap a player on a team for someone else (a no-show, an injury). The team
-- name follows, e.g. Davis/Lee becomes Davis/Park. The new player still
-- needs to check in.
create function public.substitute_player(
  p_team uuid, p_old_player uuid, p_first_name text, p_last_name text, p_phone text default null,
  p_email text default null
) returns public.teams
language plpgsql security definer set search_path = '' as $$
declare
  t public.teams;
  v_old public.players;
  v_new uuid;
begin
  select * into t from public.teams where id = p_team;
  if not found then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(t.tournament_id);
  perform private.lock_tournament(t.tournament_id);
  select p.* into v_old from public.players p
  join public.team_players tp on tp.player_id = p.id and tp.team_id = p_team
  where p.id = p_old_player;
  if v_old.id is null then
    raise exception 'That player isn''t on this team' using errcode = '22023';
  end if;
  if coalesce(trim(p_last_name), '') = '' then
    raise exception 'Enter the new player''s name' using errcode = '22023';
  end if;

  insert into public.players (first_name, last_name, phone, email, sms_opt_in, added_by)
  values (coalesce(nullif(trim(p_first_name), ''), '-'), trim(p_last_name), nullif(trim(p_phone), ''),
          lower(nullif(trim(p_email), '')), nullif(trim(p_phone), '') is not null, auth.uid())
  returning id into v_new;
  update public.team_players set player_id = v_new where team_id = p_team and player_id = p_old_player;
  update public.teams set name = replace(name, v_old.last_name, trim(p_last_name)) where id = p_team;
  perform private.sync_team_checkins(t.tournament_id, v_new);

  select * into t from public.teams where id = p_team;
  return t;
end $$;

-- Put another team (an alternate, entered in the same event but not
-- scheduled) into a team's place: it takes over every match not yet started,
-- and the old team is withdrawn.
create function public.replace_team(p_old_team uuid, p_new_team uuid) returns public.teams
language plpgsql security definer set search_path = '' as $$
declare
  old_t public.teams;
  new_t public.teams;
  v_match uuid;
begin
  select * into old_t from public.teams where id = p_old_team;
  select * into new_t from public.teams where id = p_new_team;
  if old_t.id is null or new_t.id is null then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(old_t.tournament_id);
  perform private.lock_tournament(old_t.tournament_id);
  if old_t.event_id <> new_t.event_id then
    raise exception 'The replacement must be entered in the same event' using errcode = '22023';
  end if;
  if new_t.withdrawn_at is not null
     or exists (select 1 from public.matches where p_new_team in (team1_id, team2_id)) then
    raise exception '% already has matches. Choose an unscheduled alternate.', new_t.name using errcode = '55000';
  end if;

  update public.matches set team1_id = p_new_team
  where team1_id = p_old_team and status in ('waiting', 'queued', 'assigned');
  update public.matches set team2_id = p_new_team
  where team2_id = p_old_team and status in ('waiting', 'queued', 'assigned');
  update public.teams set pool = old_t.pool, seed = coalesce(old_t.seed, seed) where id = p_new_team;
  update public.teams set withdrawn_at = private.clock(), checked_in_at = null where id = p_old_team;

  -- A match already called to a court: tell the new players where to go.
  for v_match in
    select id from public.matches where p_new_team in (team1_id, team2_id) and status = 'assigned'
  loop
    perform private.notify_match_players(v_match, 'court_assigned');
  end loop;
  perform private.auto_assign(old_t.tournament_id);

  select * into new_t from public.teams where id = p_new_team;
  return new_t;
end $$;

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

-- Staff send a message by text and/or email. p_scope picks who gets it:
--   'player' (p_target = player), 'team' (team), 'event' (division),
--   'everyone', or 'not_checked_in' (everyone not here yet).
-- Returns how many messages were queued.
create function public.send_message(
  p_tournament uuid, p_scope text, p_target uuid, p_body text, p_via text[], p_subject text default null
) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  perform private.require_staff(p_tournament);
  if coalesce(trim(p_body), '') = '' then
    raise exception 'Write a message first' using errcode = '22023';
  end if;
  if p_via is null or cardinality(p_via) = 0 or not p_via <@ array['sms', 'email'] then
    raise exception 'Choose text and/or email' using errcode = '22023';
  end if;
  if p_scope not in ('player', 'team', 'event', 'everyone', 'not_checked_in') then
    raise exception 'Unknown recipients: %', p_scope using errcode = '22023';
  end if;

  with recipients as (
    select distinct tp.player_id
    from public.teams t
    join public.team_players tp on tp.team_id = t.id
    where t.tournament_id = p_tournament
      and t.withdrawn_at is null
      and case p_scope
            when 'player' then tp.player_id = p_target
            when 'team' then t.id = p_target
            when 'event' then t.event_id = p_target
            when 'not_checked_in' then not exists (
              select 1 from public.player_checkins pc
              where pc.tournament_id = p_tournament and pc.player_id = tp.player_id
            )
            else true
          end
  ),
  queued as (
    insert into public.notifications (tournament_id, player_id, kind, via, subject, body)
    select p_tournament, r.player_id, 'message', v.via, nullif(trim(p_subject), ''), trim(p_body)
    from recipients r
    cross join unnest(p_via) as v(via)
    returning 1
  )
  select count(*) into v_count from queued;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table public.player_checkins enable row level security;
revoke all on public.player_checkins from anon, authenticated;
grant select on public.player_checkins, public.checkin_roster, public.division_checkin, public.team_roster
  to authenticated;
create policy "Staff see check-ins" on public.player_checkins for select to authenticated
  using (public.is_tournament_staff(tournament_id));

-- Live edits: staff fix names and contact details for players in their tournaments.
create policy "Staff edit their players" on public.players for update to authenticated
  using (exists (
    select 1 from public.team_players tp
    join public.teams t on t.id = tp.team_id
    where tp.player_id = players.id and public.is_tournament_staff(t.tournament_id)
  ))
  with check (true);
