-- A division a director has started plays now, even ahead of its scheduled
-- start time (events.not_before): the start is the official signal. The
-- scheduled time still orders the queue and the Planner; waits (overdue,
-- championship courts) count from the actual start.

-- As before, without 'event_not_started': a started division isn't held for
-- its scheduled time.
create or replace function private.match_candidates(p_tournament uuid, p_now timestamptz)
returns table (
  match_id uuid,
  blocked_reason text,
  overdue boolean,
  waiting_since timestamptz,
  queue_seq numeric,
  player_ids uuid[]
)
language sql stable set search_path = '' as $$
  with player_state as (
    select tp.player_id,
           bool_or(m.status in ('assigned', 'in_progress')) as busy,
           max(m.completed_at) filter (where not m.forfeit) as last_finished_at
    from public.matches m
    join public.team_players tp on tp.team_id in (m.team1_id, m.team2_id)
    where m.tournament_id = p_tournament and m.status in ('assigned', 'in_progress', 'completed')
    group by tp.player_id
  ),
  team_state as (
    select t.id as team_id,
           t.checked_in_at is not null and t.withdrawn_at is null as ready,
           coalesce(bool_or(ps.busy), false) as busy,
           max(ps.last_finished_at) as last_finished_at,
           greatest(t.checked_in_at, max(ps.last_finished_at)) as free_since,
           -- When the team last became free to play in its own event.
           greatest(t.checked_in_at, (
             select max(m2.completed_at) from public.matches m2
             where m2.event_id = t.event_id and t.id in (m2.team1_id, m2.team2_id) and not m2.forfeit
           )) as event_free_since
    from public.teams t
    left join public.team_players tp on tp.team_id = t.id
    left join player_state ps on ps.player_id = tp.player_id
    where t.tournament_id = p_tournament
    group by t.id
  )
  select m.id,
         case
           when m.on_hold then 'on_hold'
           when e.started_at is null then 'division_not_started'
           when not (t1.ready and t2.ready) then 'not_checked_in'
           when t1.busy or t2.busy then 'player_on_court'
         end,
         not m.on_hold and e.started_at is not null and t1.ready and t2.ready
           and greatest(t1.event_free_since, t2.event_free_since, e.started_at)
               <= p_now - make_interval(mins => tn.overdue_after_minutes)
           -- Only a team's next match in the event can be overdue; holding
           -- players for every pending pool round would freeze the pool.
           and not exists (
             select 1 from public.matches m3
             where m3.event_id = m.event_id and m3.status = 'queued' and m3.wave < m.wave
               and (m3.team1_id in (m.team1_id, m.team2_id) or m3.team2_id in (m.team1_id, m.team2_id))
           ),
         least(t1.free_since, t2.free_since),
         m.queue_seq,
         array(select tp.player_id from public.team_players tp where tp.team_id in (m.team1_id, m.team2_id))
  from public.matches m
  join public.tournaments tn on tn.id = m.tournament_id
  join public.events e on e.id = m.event_id
  join team_state t1 on t1.team_id = m.team1_id
  join team_state t2 on t2.team_id = m.team2_id
  where m.tournament_id = p_tournament and m.status = 'queued'
$$;

-- As before; a championship match's wait counts from the division's start.
create or replace function private.championship_ready(p_tournament uuid, p_now timestamptz)
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
             m.ready_since, e.started_at, t1.checked_in_at, t2.checked_in_at,
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
