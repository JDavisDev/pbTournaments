-- Match type tags and a demo fix.
--
-- The queue (up_next) and the court board say each match's stage and round
-- (stage, round_key), so screens can tag it: RR, Bracket, Gold, Bronze.
--
-- Demo fast-forward moves a practice tournament's past back; it now moves
-- matches.ready_since too, so championship wait limits count down during a
-- fast-forward instead of restarting from the real clock.

-- Moves a demo tournament p_minutes into the future by moving its past back.
create or replace function private.shift_demo_clock(p_tournament uuid, p_minutes int) returns void
language plpgsql set search_path = '' as $$
declare
  v interval := make_interval(mins => p_minutes);
begin
  update public.matches
  set queued_at = queued_at - v, assigned_at = assigned_at - v, started_at = started_at - v,
      completed_at = completed_at - v, ready_since = ready_since - v,
      queue_seq = queue_seq - p_minutes * 1000000::numeric
  where tournament_id = p_tournament;
  update public.teams set checked_in_at = checked_in_at - v, withdrawn_at = withdrawn_at - v
  where tournament_id = p_tournament;
  update public.player_checkins set checked_in_at = checked_in_at - v where tournament_id = p_tournament;
  update public.events set not_before = not_before - v, playoffs_seeded_at = playoffs_seeded_at - v
  where tournament_id = p_tournament;
end $$;

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
       c.championship_rank,
       md.round_key
from public.courts c
join public.tournaments t on t.id = c.tournament_id
left join public.match_details md on md.court_id = c.id and md.status in ('assigned', 'in_progress')
where c.retired_at is null;

-- The queue, as before (see 20261027001800_championship_courts), plus each
-- match's stage and round_key.
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
  wait_until timestamptz,
  stage text,
  round_key text
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
           rd.ready_since as ahead_since,
           m.stage::text as stage,
           m.round_key::text as round_key
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
         r.reason, r.overdue, r.waiting_since, r.court_names, r.championship, r.waiting_for_court, r.wait_until,
         r.stage, r.round_key
  from rows r
  order by 1;
end $$;
