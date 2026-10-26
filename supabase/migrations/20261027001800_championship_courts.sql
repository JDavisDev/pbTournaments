-- Championship courts: the featured courts (commentary, a stream, the best
-- seats) get the big matches.
--
-- A director ranks courts as championship courts: 1 is the Main court, 2 the
-- next, and so on. They play ordinary matches like any court, but when one is
-- free and a championship match is ready (a bracket round the director chose:
-- semifinals, finals, bronze and grand finals unless changed), that match
-- goes there first. A bigger round goes first and gets the better court:
-- finals, then bronze, semifinals, quarterfinals; equal rounds in the order
-- they became ready.
--
-- championship_mode says what happens when every championship court is busy:
--   wait             the match waits for one; a final waits for the Main court.
--                    After championship_wait_minutes (final_wait_minutes for
--                    finals; null = no limit) it takes the first free court.
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
-- wait_until: when a waiting match gives up on championship courts (null =
-- never).
create function private.championship_ready(p_tournament uuid, p_now timestamptz)
returns table (
  match_id uuid,
  is_final boolean,
  weight int,
  wait_until timestamptz,
  expired boolean,
  queued_at timestamptz,
  queue_rank int
)
language sql stable set search_path = '' as $$
  select m.id,
         m.round_key in ('final', 'grand_final'),
         private.championship_weight(m.round_key),
         w.until,
         coalesce(w.until <= p_now, false),
         m.queued_at,
         q.queue_rank
  from private.plan_queue(p_tournament, p_now) q
  join public.matches m on m.id = q.match_id
  join public.tournaments t on t.id = m.tournament_id
  cross join lateral (
    select m.queued_at + make_interval(mins => case when m.round_key in ('final', 'grand_final')
                                                     then t.final_wait_minutes
                                                     else t.championship_wait_minutes end) as until
  ) w
  where q.blocked_reason is null
    and m.stage = 'bracket'
    and m.round_key = any (t.championship_rounds)
    and private.championship_weight(m.round_key) > 0
    and cardinality(private.championship_courts(p_tournament)) > 0
  order by 3 desc, m.queued_at, q.queue_rank
$$;

-- The first of the free courts a division may use: one in its section, or
-- (no section) one outside every section in use. Courts in p_last are only
-- taken when nothing else fits.
create function private.pick_court(p_free uuid[], p_section uuid[], p_sectioned uuid[], p_last uuid[])
returns uuid
language sql immutable set search_path = '' as $$
  select f.id
  from unnest(p_free) with ordinality as f(id, n)
  where case when cardinality(p_section) > 0 then f.id = any (p_section)
             else not (f.id = any (p_sectioned)) end
  order by f.id = any (p_last), f.n
  limit 1
$$;

-- Sends the top playable matches to free courts. Championship matches go
-- first (see the top of this file), then everything else in queue order,
-- each taking the first free court it may use. Ordinary matches take
-- championship courts last, so those are more often free for the big rounds.
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
    order by r.weight desc, r.queued_at, r.queue_rank
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
        v_court := private.pick_court(v_courts, c.court_ids, v_sectioned, '{}');
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
    v_court := private.pick_court(v_courts, c.court_ids, v_sectioned, v_champ);
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
