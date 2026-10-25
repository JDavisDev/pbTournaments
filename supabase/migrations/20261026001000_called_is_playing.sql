-- Match day, simplified:
--  * A match called to a court is under way. Players don't confirm they're on
--    court; they head there, play, and report the score, which frees the court.
--  * Players can only report scores. Check-in and everything else is staff.
--  * Directors can change how many teams advance from each pool until the
--    bracket is seeded (set_advance_per_pool).

-- ---------------------------------------------------------------------------
-- Called = playing
-- ---------------------------------------------------------------------------

-- Every way a match reaches a court sets status 'assigned'; this turns that
-- into 'in_progress' with the call time as its start.
create function private.called_is_playing() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'assigned' then
    new.status := 'in_progress';
    new.started_at := coalesce(new.assigned_at, private.clock());
  end if;
  return new;
end $$;

create trigger matches_called_is_playing
before insert or update of status on public.matches
for each row execute function private.called_is_playing();

update public.matches set status = 'in_progress', started_at = coalesce(started_at, assigned_at)
where status = 'assigned';

-- Swapping in an alternate also covers a match that's been called but has no
-- score yet; the new players get the court text.
create or replace function public.replace_team(p_old_team uuid, p_new_team uuid) returns public.teams
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
  where team1_id = p_old_team and status in ('waiting', 'queued', 'in_progress');
  update public.matches set team2_id = p_new_team
  where team2_id = p_old_team and status in ('waiting', 'queued', 'in_progress');
  update public.teams set pool = old_t.pool, seed = coalesce(old_t.seed, seed) where id = p_new_team;
  update public.teams set withdrawn_at = private.clock(), checked_in_at = null where id = p_old_team;

  for v_match in
    select id from public.matches where p_new_team in (team1_id, team2_id) and status = 'in_progress'
  loop
    perform private.notify_match_players(v_match, 'court_assigned');
  end loop;
  perform private.auto_assign(old_t.tournament_id);

  select * into new_t from public.teams where id = p_new_team;
  return new_t;
end $$;

-- ---------------------------------------------------------------------------
-- Players report scores, nothing else
-- ---------------------------------------------------------------------------

create or replace function public.check_in_team(p_team uuid, p_checked_in boolean default true)
returns public.teams
language plpgsql security definer set search_path = '' as $$
declare
  v_tournament uuid;
  t public.teams;
begin
  select tournament_id into v_tournament from public.teams where id = p_team;
  if v_tournament is null then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(v_tournament);
  perform private.lock_tournament(v_tournament);

  perform private.set_team_checked_in(v_tournament, p_team, p_checked_in);
  perform private.auto_assign(v_tournament);
  select * into t from public.teams where id = p_team;
  return t;
end $$;

drop policy "Update own player row" on public.players;

-- ---------------------------------------------------------------------------
-- Advancing from pools
-- ---------------------------------------------------------------------------

-- Director: change how many teams advance from each pool. Before the bracket
-- is seeded it's rebuilt for the new number of seeds; after, it's too late.
create function public.set_advance_per_pool(p_event uuid, p_advance int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_smallest int;
  v_pool_rounds int;
  v_created int;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  if e.format <> 'pools_to_bracket' then
    raise exception 'Only pools-to-bracket events advance teams from pools' using errcode = '22023';
  end if;
  if p_advance is null or p_advance < 1 then
    raise exception 'At least 1 team must advance from each pool' using errcode = '22023';
  end if;
  if e.pool_count * p_advance < 2 then
    raise exception 'At least 2 teams must advance to the bracket' using errcode = '22023';
  end if;

  if not exists (select 1 from public.matches where event_id = p_event) then
    update public.events set advance_per_pool = p_advance where id = p_event;
    return 0;
  end if;
  if e.playoffs_seeded_at is not null then
    raise exception 'The bracket is already seeded from pool play, so this can''t change now' using errcode = '55000';
  end if;
  select min(n) into v_smallest from (
    select count(*) as n from public.teams
    where event_id = p_event and withdrawn_at is null and pool is not null group by pool
  ) sizes;
  if p_advance > v_smallest then
    raise exception 'Can''t advance % per pool: the smallest pool has % teams', p_advance, v_smallest
      using errcode = '22023';
  end if;

  delete from public.matches where event_id = p_event and stage = 'bracket';
  update public.events set advance_per_pool = p_advance where id = p_event returning * into e;
  select max(round) into v_pool_rounds from public.matches where event_id = p_event and stage = 'pool';
  if e.bracket_type = 'double' then
    v_created := private.build_double_elim(e, e.pool_count * p_advance, null, v_pool_rounds);
  else
    v_created := private.build_bracket(e, e.pool_count * p_advance, null, v_pool_rounds);
  end if;
  -- Pool play may already be over (e.g. ended early): seed right away.
  perform private.seed_playoffs_when_pools_done(p_event);
  perform private.auto_assign(e.tournament_id);
  return v_created;
end $$;
