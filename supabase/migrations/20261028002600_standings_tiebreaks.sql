-- Pool standings tiebreaks: win percentage (the same as wins when everyone
-- has played the same number of matches), then head-to-head among the tied
-- teams, then point differential. Points scored and seed only settle what's
-- still level. Before, total wins came between win percentage and
-- head-to-head, which favoured teams with more matches played when pool
-- play ended early.
create or replace view public.standings with (security_invoker = true) as
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
rated as (
  select *, case when played > 0 then round(wins::numeric / played, 3) else 0 end as win_pct
  from totals
),
head_to_head as (
  select a.team_id, count(*)::int as wins_vs_tied
  from rated a
  join per_team pt on pt.team_id = a.team_id and pt.won
  join rated b on b.team_id = pt.opponent_id and b.win_pct = a.win_pct
  group by a.team_id
)
select tt.tournament_id, tt.event_id, tt.pool, chr(64 + tt.pool) as pool_letter,
       tt.team_id, tt.team_name, tt.seed, tt.played, tt.wins, tt.losses, tt.win_pct,
       tt.points_for, tt.points_against, tt.points_for - tt.points_against as point_diff,
       coalesce(h.wins_vs_tied, 0) as wins_vs_tied,
       row_number() over (
         partition by tt.event_id, tt.pool
         order by tt.win_pct desc, coalesce(h.wins_vs_tied, 0) desc,
                  tt.points_for - tt.points_against desc, tt.points_for desc,
                  tt.seed nulls last, tt.team_name
       )::int as pool_rank
from rated tt
left join head_to_head h on h.team_id = tt.team_id;
