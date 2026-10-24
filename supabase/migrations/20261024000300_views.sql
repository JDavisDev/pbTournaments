-- Read models for the screens: the court board, match details and standings.
-- All use security_invoker, so row-level security on the underlying tables
-- decides who sees what.

-- One row per active court with the live match on it. A match is a no-show
-- when match_status = 'assigned' and the current time is past no_show_deadline.
create view public.court_board with (security_invoker = true) as
select c.tournament_id,
       c.id as court_id,
       c.name as court_name,
       c.sort_order,
       c.out_of_service,
       m.id as match_id,
       m.status as match_status,
       e.id as event_id,
       e.name as event_name,
       m.label,
       m.team1_id,
       t1.name as team1_name,
       m.team2_id,
       t2.name as team2_name,
       m.assigned_at,
       m.started_at,
       m.assigned_at + make_interval(mins => t.no_show_minutes) as no_show_deadline
from public.courts c
join public.tournaments t on t.id = c.tournament_id
left join public.matches m on m.court_id = c.id and m.status in ('assigned', 'in_progress')
left join public.events e on e.id = m.event_id
left join public.teams t1 on t1.id = m.team1_id
left join public.teams t2 on t2.id = m.team2_id
where c.retired_at is null;

-- Every match with names filled in. Unknown bracket slots read "Seed 3"
-- (pools still playing) or "Winner of Quarterfinal 2".
create view public.match_details with (security_invoker = true) as
select m.id,
       m.tournament_id,
       m.event_id,
       e.name as event_name,
       e.format as event_format,
       m.stage,
       m.pool,
       case when m.pool > 0 then chr(64 + m.pool) end as pool_letter,
       m.round,
       m.position,
       m.label,
       m.wave,
       m.queue_seq,
       m.on_hold,
       m.status,
       m.team1_id,
       coalesce(t1.name,
                (select 'Winner of ' || f.label from public.matches f
                 where f.winner_to_match_id = m.id and f.winner_to_slot = 1 limit 1),
                'Seed ' || m.team1_seed,
                'TBD') as team1_name,
       m.team2_id,
       coalesce(t2.name,
                (select 'Winner of ' || f.label from public.matches f
                 where f.winner_to_match_id = m.id and f.winner_to_slot = 2 limit 1),
                'Seed ' || m.team2_seed,
                'TBD') as team2_name,
       m.team1_seed,
       m.team2_seed,
       m.court_id,
       c.name as court_name,
       m.queued_at,
       m.assigned_at,
       m.started_at,
       m.completed_at,
       m.games,
       m.winner_team_id,
       m.forfeit,
       m.winner_to_match_id
from public.matches m
join public.events e on e.id = m.event_id
left join public.teams t1 on t1.id = m.team1_id
left join public.teams t2 on t2.id = m.team2_id
left join public.courts c on c.id = m.court_id;

-- Pool standings. Order: match wins, then wins against teams tied on wins
-- (head-to-head), then point differential, then points scored.
create view public.standings with (security_invoker = true) as
with played as (
  select m.event_id, m.pool, m.team1_id, m.team2_id, m.winner_team_id,
         coalesce((select sum((g ->> 0)::int) from jsonb_array_elements(m.games) g), 0) as points1,
         coalesce((select sum((g ->> 1)::int) from jsonb_array_elements(m.games) g), 0) as points2
  from public.matches m
  where m.stage = 'pool' and m.status = 'completed'
),
per_team as (
  select team1_id as team_id, team2_id as opponent_id, winner_team_id = team1_id as won,
         points1 as points_for, points2 as points_against
  from played
  union all
  select team2_id, team1_id, winner_team_id = team2_id, points2, points1
  from played
),
totals as (
  select t.id as team_id, t.tournament_id, t.event_id, t.pool, t.name as team_name, t.seed,
         count(pt.team_id)::int as played,
         (count(*) filter (where pt.won))::int as wins,
         (count(*) filter (where not pt.won))::int as losses,
         coalesce(sum(pt.points_for), 0)::int as points_for,
         coalesce(sum(pt.points_against), 0)::int as points_against
  from public.teams t
  left join per_team pt on pt.team_id = t.id
  where t.pool is not null and t.withdrawn_at is null
  group by t.id
),
head_to_head as (
  select a.team_id, count(*)::int as wins_vs_tied
  from totals a
  join per_team pt on pt.team_id = a.team_id and pt.won
  join totals b on b.team_id = pt.opponent_id and b.wins = a.wins
  group by a.team_id
)
select tt.tournament_id, tt.event_id, tt.pool, chr(64 + tt.pool) as pool_letter,
       tt.team_id, tt.team_name, tt.seed, tt.played, tt.wins, tt.losses,
       tt.points_for, tt.points_against, tt.points_for - tt.points_against as point_diff,
       coalesce(h.wins_vs_tied, 0) as wins_vs_tied,
       row_number() over (
         partition by tt.event_id, tt.pool
         order by tt.wins desc, coalesce(h.wins_vs_tied, 0) desc,
                  tt.points_for - tt.points_against desc, tt.points_for desc,
                  tt.seed nulls last, tt.team_name
       )::int as pool_rank
from totals tt
left join head_to_head h on h.team_id = tt.team_id;
