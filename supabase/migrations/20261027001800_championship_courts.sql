-- Championship courts: the featured courts (commentary, a stream, the best
-- seats) get the big matches.
--
-- A director ranks courts as championship courts: 1 is the Main court, 2 the
-- next, and so on. They play ordinary matches like any court, but when one is
-- free and a championship match is ready (a bracket round the director chose:
-- semifinals, finals, bronze and grand finals unless changed), that match
-- goes there first. A bigger round goes first and gets the better court:
-- finals, then bronze, semifinals, quarterfinals; equal rounds in the order
-- they became ready. In double elimination only the grand final counts (its
-- other rounds aren't told apart).
--
-- championship_mode says what happens when every championship court is busy:
--   wait             the match waits for one; a final waits for the Main court.
--                    After championship_wait_minutes (final_wait_minutes for
--                    finals; null = no limit) from when it could first be
--                    played, it takes the first free court. A championship
--                    court is kept free for a match about to be ready.
--   first_available  it takes the first free court its division may use.
--   off              championship courts are ordinary courts.
-- A championship match may leave its division's court section. When no
-- championship court can be used (all paused or retired) everything plays as
-- if the setting were off. Directors sending a match to a court by hand
-- (assign_match_to_court, move_match_to_court) aren't limited by any of this.

alter table public.courts add column championship_rank int check (championship_rank > 0);
alter table public.tournaments
  add column championship_mode text not null default 'wait'
    check (championship_mode in ('off', 'wait', 'first_available')),
  add column championship_rounds text[] not null default '{semifinal,final,bronze,grand_final}',
  add column championship_wait_minutes int default 15 check (championship_wait_minutes > 0),
  add column final_wait_minutes int default 30 check (final_wait_minutes > 0);

grant update (championship_rank) on public.courts to authenticated;
grant update (championship_mode, championship_rounds, championship_wait_minutes, final_wait_minutes)
  on public.tournaments to authenticated;

-- When a queued match last joined the queue, came back to it, or was
-- released from a hold. The wait limit counts from the latest of this, its
-- event's start and its players' last match: when it could first be played.
alter table public.matches add column ready_since timestamptz;
update public.matches set ready_since = queued_at where status = 'queued';

create function private.matches_stamp_ready() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'queued'
     and (tg_op = 'INSERT' or old.status <> 'queued' or (old.on_hold and not new.on_hold)) then
    new.ready_since := private.clock();
  end if;
  return new;
end $$;

-- Fires after matches_set_queue_status, which queues a match (name order).
create trigger matches_stamp_ready
  before insert or update of team1_id, team2_id, status, on_hold on public.matches
  for each row execute function private.matches_stamp_ready();

create or replace view public.court_board with (security_invoker = true) as
select c.tournament_id,
       c.id as court_id,
       c.name as court_name,
       c.sort_order,
       c.out_of_service,
       c.stream_url,
       md.id as match_id,
       md.status as match_status,
       md.event_id,
       md.event_name,
       md.label,
       md.stage,
       md.team1_id,
       md.team1_name,
       md.team2_id,
       md.team2_name,
       md.assigned_at,
       md.started_at,
       md.assigned_at + make_interval(mins => t.no_show_minutes) as no_show_deadline,
       md.games_to,
       md.best_of,
       md.point_cap,
       md.format_text,
       c.championship_rank
from public.courts c
join public.tournaments t on t.id = c.tournament_id
left join public.match_details md on md.court_id = c.id and md.status in ('assigned', 'in_progress')
where c.retired_at is null;

-- How big a round is for championship courts (0 = never a championship match).
create function private.championship_weight(p_round_key text) returns int
language sql immutable set search_path = '' as $$
  select case p_round_key
           when 'grand_final' then 4 when 'final' then 4 when 'bronze' then 3
           when 'semifinal' then 2 when 'quarterfinal' then 1 else 0
         end
$$;

-- The championship courts that can be used now, Main first. Empty when the
-- setting is off.
create function private.championship_courts(p_tournament uuid) returns uuid[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(c.id order by c.championship_rank, c.sort_order, c.name), '{}')
  from public.courts c
  join public.tournaments t on t.id = c.tournament_id
  where c.tournament_id = p_tournament
    and t.championship_mode <> 'off'
    and c.championship_rank is not null
    and c.retired_at is null
    and not c.out_of_service
$$;

-- Championship matches that could go on a court now, biggest round first.
-- ready_since: when it could first be played. wait_until: when a waiting
-- match gives up on championship courts (null = never).
create function private.championship_ready(p_tournament uuid, p_now timestamptz)
returns table (
  match_id uuid,
  is_final boolean,
  weight int,
  wait_until timestamptz,
  expired boolean,
  ready_since timestamptz,
  queue_rank int
)
language sql stable set search_path = '' as $$
  select m.id,
         m.round_key in ('final', 'grand_final'),
         private.championship_weight(m.round_key),
         w.until,
         coalesce(w.until <= p_now, false),
         r.since,
         q.queue_rank
  from private.plan_queue(p_tournament, p_now) q
  join public.matches m on m.id = q.match_id
  join public.events e on e.id = m.event_id
  join public.tournaments t on t.id = m.tournament_id
  join public.teams t1 on t1.id = m.team1_id
  join public.teams t2 on t2.id = m.team2_id
  cross join lateral (
    select greatest(
             m.ready_since, e.not_before, t1.checked_in_at, t2.checked_in_at,
             (select max(m2.completed_at)
              from public.matches m2
              join public.team_players a on a.team_id in (m2.team1_id, m2.team2_id)
              join public.team_players b on b.player_id = a.player_id
              where m2.tournament_id = m.tournament_id and m2.status = 'completed'
                and b.team_id in (m.team1_id, m.team2_id))
           ) as since
  ) r
  cross join lateral (
    select r.since + make_interval(mins => case when m.round_key in ('final', 'grand_final')
                                                 then t.final_wait_minutes
                                                 else t.championship_wait_minutes end) as until
  ) w
  where q.blocked_reason is null
    and m.stage = 'bracket'
    and m.round_key = any (t.championship_rounds)
    and private.championship_weight(m.round_key) > 0
    and cardinality(private.championship_courts(p_tournament)) > 0
  order by 3 desc, r.since, q.queue_rank
$$;

-- Championship matches that will be ready soon: every match feeding them is
-- on court or done. Wait mode keeps a championship court free for each (the
-- Main court for a final) instead of starting an ordinary match there.
create function private.championship_coming(p_tournament uuid, p_now timestamptz)
returns table (match_id uuid, is_final boolean)
language sql stable set search_path = '' as $$
  with ready as (select r.match_id from private.championship_ready(p_tournament, p_now) r)
  select m.id, m.round_key in ('final', 'grand_final')
  from public.matches m
  join public.tournaments t on t.id = m.tournament_id
  where m.tournament_id = p_tournament
    and t.championship_mode = 'wait'
    and cardinality(private.championship_courts(p_tournament)) > 0
    and m.stage = 'bracket'
    and not m.on_hold
    and m.status in ('waiting', 'queued')
    and m.round_key = any (t.championship_rounds)
    and private.championship_weight(m.round_key) > 0
    and m.id not in (select ready.match_id from ready)
    and exists (
      select 1 from public.matches f
      where f.winner_to_match_id = m.id or f.loser_to_match_id = m.id
    )
    and not exists (
      select 1 from public.matches f
      where (f.winner_to_match_id = m.id or f.loser_to_match_id = m.id) and f.status in ('waiting', 'queued')
    )
$$;

-- The first of the free courts a division may use: one in its section, or
-- (no section) one outside every section in use.
create function private.pick_court(p_free uuid[], p_section uuid[], p_sectioned uuid[])
returns uuid
language sql immutable set search_path = '' as $$
  select f.id
  from unnest(p_free) with ordinality as f(id, n)
  where case when cardinality(p_section) > 0 then f.id = any (p_section)
             else not (f.id = any (p_sectioned)) end
  order by f.n
  limit 1
$$;

-- Free championship courts kept for championship matches about to be ready:
-- the Main court for a final, the best free one for anything else.
create function private.championship_holds(p_tournament uuid, p_now timestamptz, p_free uuid[])
returns table (court_id uuid, match_id uuid)
language plpgsql stable set search_path = '' as $$
declare
  v_champ uuid[] := private.championship_courts(p_tournament);
  v_held uuid[] := '{}';
  v_court uuid;
  c record;
begin
  for c in
    select k.match_id, k.is_final from private.championship_coming(p_tournament, p_now) k
    order by k.is_final desc
  loop
    v_court := null;
    if c.is_final then
      if v_champ[1] = any (p_free) and not (v_champ[1] = any (v_held)) then
        v_court := v_champ[1];
      end if;
    else
      select ch.id into v_court
      from unnest(v_champ) with ordinality as ch(id, n)
      where ch.id = any (p_free) and not (ch.id = any (v_held))
      order by ch.n
      limit 1;
    end if;
    if v_court is not null then
      v_held := v_held || v_court;
      court_id := v_court;
      match_id := c.match_id;
      return next;
    end if;
  end loop;
end $$;

-- The courts kept free right now, for the court desk: "Kept for <event> <match>".
create function public.championship_holds(p_tournament uuid)
returns table (court_id uuid, court_name text, match_id uuid, event_name text, label text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.tournaments t
    where t.id = p_tournament and (t.status <> 'draft' or public.is_tournament_staff(t.id))
  ) then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  return query
  select h.court_id, c.name, h.match_id, e.name, m.label
  from private.championship_holds(p_tournament, private.clock(), private.free_courts(p_tournament)) h
  join public.courts c on c.id = h.court_id
  join public.matches m on m.id = h.match_id
  join public.events e on e.id = m.event_id;
end $$;

-- Sends the top playable matches to free courts. Championship matches go
-- first (see the top of this file), then everything else in queue order,
-- each taking the first free court it may use, except one kept for a
-- championship match that's about to be ready.
create or replace function private.run_assignment(p_tournament uuid) returns int
language plpgsql set search_path = '' as $$
declare
  v_now timestamptz := private.clock();
  v_courts uuid[];
  v_sectioned uuid[];
  v_champ uuid[];
  v_mode text;
  v_seen uuid[] := '{}';
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
  v_champ := private.championship_courts(p_tournament);
  select t.championship_mode into v_mode from public.tournaments t where t.id = p_tournament;

  for c in
    select r.match_id, r.is_final, r.expired, e.court_ids
    from private.championship_ready(p_tournament, v_now) r
    join public.matches m on m.id = r.match_id
    join public.events e on e.id = m.event_id
    order by r.weight desc, r.ready_since, r.queue_rank
  loop
    exit when cardinality(v_courts) = 0;
    -- Assigned or waiting, the ordinary pass leaves it alone.
    v_seen := v_seen || c.match_id;
    v_court := null;
    if c.is_final and v_mode = 'wait' and not c.expired then
      -- A final holds out for the Main court.
      if v_champ[1] = any (v_courts) then
        v_court := v_champ[1];
      end if;
    else
      select ch.id into v_court
      from unnest(v_champ) with ordinality as ch(id, n)
      where ch.id = any (v_courts)
      order by ch.n
      limit 1;
      if v_court is null and (v_mode = 'first_available' or c.expired) then
        v_court := private.pick_court(v_courts, c.court_ids, v_sectioned);
      end if;
    end if;
    continue when v_court is null;

    update public.matches
    set status = 'assigned', court_id = v_court, assigned_at = v_now
    where id = c.match_id;
    perform private.notify_match_players(c.match_id, 'court_assigned');
    v_courts := array_remove(v_courts, v_court);
    v_assigned := v_assigned + 1;
  end loop;

  v_courts := array(
    select f.id from unnest(v_courts) with ordinality as f(id, n)
    where f.id not in (select h.court_id from private.championship_holds(p_tournament, v_now, v_courts) h)
    order by f.n
  );

  for c in
    select q.match_id, e.court_ids
    from private.plan_queue(p_tournament, v_now) q
    join public.matches m on m.id = q.match_id
    join public.events e on e.id = m.event_id
    where q.blocked_reason is null
      and not (q.match_id = any (v_seen))
    order by q.queue_rank
  loop
    exit when cardinality(v_courts) = 0;
    v_court := private.pick_court(v_courts, c.court_ids, v_sectioned);
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

-- The queue, as before, plus championship matches. Ones the engine sends
-- ahead of the queue (First available, or past their wait) are listed first,
-- biggest round first. championship says the match is one, and a ready one
-- whose courts are all busy in Wait mode says
-- waiting_for_championship_court, which court it waits for
-- (waiting_for_court; null = any championship court) and until when
-- (wait_until; null = no limit).
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
  court_names text[],
  championship boolean,
  waiting_for_court text,
  wait_until timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_now timestamptz := private.clock();
  v_free uuid[];
  v_champ uuid[];
  v_main text;
begin
  if not exists (
    select 1 from public.tournaments t
    where t.id = p_tournament and (t.status <> 'draft' or public.is_tournament_staff(t.id))
  ) then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  v_free := private.free_courts(p_tournament);
  v_champ := private.championship_courts(p_tournament);
  select c.name into v_main from public.courts c where c.id = v_champ[1];

  return query
  with ready as (
    select r.*, tn.championship_mode = 'wait' and not r.expired as waits
    from private.championship_ready(p_tournament, v_now) r
    join public.tournaments tn on tn.id = p_tournament
  ),
  waiting as (
    select r.match_id, r.is_final, r.wait_until
    from ready r
    where r.waits
      and case when r.is_final then not (v_champ[1] = any (v_free))
               else not (v_champ && v_free) end
  ),
  rows as (
    select q.queue_rank as rank, m.id, e.id as event_id, e.name, m.label, t1.id as t1, t1.name as t1_name,
           t2.id as t2, t2.name as t2_name,
           case when w.match_id is not null then 'waiting_for_championship_court' else q.blocked_reason end as reason,
           q.overdue, q.waiting_since,
           array(
             select c.name from public.courts c
             where c.id = any (e.court_ids) and c.retired_at is null
             order by c.sort_order, c.name
           ) as court_names,
           cardinality(v_champ) > 0 and m.stage = 'bracket' and m.round_key = any (tn.championship_rounds)
             and private.championship_weight(m.round_key) > 0 as championship,
           case when w.is_final then v_main end as waiting_for_court,
           w.wait_until,
           -- Sent ahead of the queue: biggest round, then longest ready.
           case when rd.match_id is not null and not rd.waits then rd.weight end as ahead_weight,
           rd.ready_since as ahead_since
    from private.plan_queue(p_tournament, v_now) q
    join public.matches m on m.id = q.match_id
    join public.events e on e.id = m.event_id
    join public.tournaments tn on tn.id = m.tournament_id
    join public.teams t1 on t1.id = m.team1_id
    join public.teams t2 on t2.id = m.team2_id
    left join waiting w on w.match_id = m.id
    left join ready rd on rd.match_id = m.id
  )
  select (row_number() over (
            order by r.reason is not null, r.ahead_weight desc nulls last, r.ahead_since, r.rank
          ))::int,
         r.id, r.event_id, r.name, r.label, r.t1, r.t1_name, r.t2, r.t2_name,
         r.reason, r.overdue, r.waiting_since, r.court_names, r.championship, r.waiting_for_court, r.wait_until
  from rows r
  order by 1;
end $$;
