-- Court sections and a queue that reads top-down.
--
-- A division can be kept to chosen courts ("Men's 3.5 on courts 1-5"). Its
-- matches go only there, and while it still has matches to play those courts
-- are its own: divisions without a section share the other courts. Once a
-- sectioned division is done, its courts go back to everyone. Two divisions
-- can share a section. Directors sending a match to a court by hand
-- (assign_match_to_court, move_match_to_court) aren't limited by sections.
--
-- The queue (up_next) lists the matches that go on the next free court first,
-- in the order they'll be called, then everything still waiting its turn.

alter table public.events add column court_ids uuid[] not null default '{}';
grant update (court_ids) on public.events to authenticated;

-- Courts held by sectioned divisions that still have matches to play.
create function private.sectioned_courts(p_tournament uuid) returns uuid[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(distinct c.id), '{}')
  from public.events e
  join public.courts c on c.id = any (e.court_ids) and c.retired_at is null
  where e.tournament_id = p_tournament
    and exists (
      select 1 from public.matches m
      where m.event_id = e.id and m.status in ('waiting', 'queued', 'assigned', 'in_progress')
    )
$$;

-- Sends the top playable matches to free courts. Each match, top of the queue
-- first, takes the first free court it may use: one in its division's
-- section, or (no section) one outside every section in use. A match whose
-- courts are all busy keeps its place for the next one that frees up.
create or replace function private.run_assignment(p_tournament uuid) returns int
language plpgsql set search_path = '' as $$
declare
  v_now timestamptz := private.clock();
  v_courts uuid[];
  v_sectioned uuid[];
  v_court uuid;
  c record;
  v_assigned int := 0;
begin
  perform private.lock_tournament(p_tournament);
  v_courts := private.free_courts(p_tournament);
  if cardinality(v_courts) = 0 then
    return 0;
  end if;
  v_sectioned := private.sectioned_courts(p_tournament);

  for c in
    select q.match_id, e.court_ids
    from private.plan_queue(p_tournament, v_now) q
    join public.matches m on m.id = q.match_id
    join public.events e on e.id = m.event_id
    where q.blocked_reason is null
    order by q.queue_rank
  loop
    exit when cardinality(v_courts) = 0;
    select f.id into v_court
    from unnest(v_courts) with ordinality as f(id, n)
    where case when cardinality(c.court_ids) > 0 then f.id = any (c.court_ids)
               else not (f.id = any (v_sectioned)) end
    order by f.n
    limit 1;
    continue when v_court is null;

    update public.matches
    set status = 'assigned', court_id = v_court, assigned_at = v_now
    where id = c.match_id;
    perform private.notify_match_players(c.match_id, 'court_assigned');
    v_courts := array_remove(v_courts, v_court);
    v_assigned := v_assigned + 1;
  end loop;
  return v_assigned;
end $$;

-- The queue top to bottom: matches that go on the next free court (no
-- blocked_reason) first, in the order they'll be called, then the rest in
-- queue order. queue_rank is the place in that list. blocked_reason says why
-- a match is waiting: on_hold, event_not_started, not_checked_in,
-- player_on_court or player_needed_elsewhere. court_names: the division's
-- section (empty = any court outside the sections).
drop function public.up_next(uuid);
create function public.up_next(p_tournament uuid)
returns table (
  queue_rank int,
  match_id uuid,
  event_id uuid,
  event_name text,
  label text,
  team1_id uuid,
  team1_name text,
  team2_id uuid,
  team2_name text,
  blocked_reason text,
  overdue boolean,
  waiting_since timestamptz,
  court_names text[]
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.tournaments t
    where t.id = p_tournament and (t.status <> 'draft' or public.is_tournament_staff(t.id))
  ) then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;

  return query
  select (row_number() over (order by q.blocked_reason is not null, q.queue_rank))::int,
         m.id, e.id, e.name, m.label, t1.id, t1.name, t2.id, t2.name,
         q.blocked_reason, q.overdue, q.waiting_since,
         array(
           select c.name from public.courts c
           where c.id = any (e.court_ids) and c.retired_at is null
           order by c.sort_order, c.name
         )
  from private.plan_queue(p_tournament, private.clock()) q
  join public.matches m on m.id = q.match_id
  join public.events e on e.id = m.event_id
  join public.teams t1 on t1.id = m.team1_id
  join public.teams t2 on t2.id = m.team2_id
  order by 1;
end $$;
