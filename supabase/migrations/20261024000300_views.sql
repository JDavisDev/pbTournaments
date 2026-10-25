-- Read models for the screens: the court board, match details and standings.
-- All use security_invoker, so row-level security on the underlying tables
-- decides who sees what.

-- "one game to 15, win by 2", "best of 3 games to 11, win by 2, cap 13".
create function public.describe_format(p_games_to int, p_best_of int, p_point_cap int) returns text
language sql immutable set search_path = '' as $$
  select case when p_best_of = 1 then 'one game' else 'best of ' || p_best_of || ' games' end
         || ' to ' || p_games_to || ', win by 2'
         || case when p_point_cap is not null then ', cap ' || p_point_cap else '' end
$$;

-- Every match with names filled in and its game format. Unknown bracket
-- slots read "Seed 3" (pools still playing), "Winner of Quarterfinal 2",
-- "Loser of Winners R1 #2" or "BYE". The format is the round's (events.round_formats),
-- else the event's playoff format for bracket matches, else its pool format.
create view public.match_details with (security_invoker = true) as
select m.id,
       m.tournament_id,
       m.event_id,
       e.name as event_name,
       e.format as event_format,
       m.stage,
       m.side,
       m.round_key,
       m.pool,
       case when m.pool > 0 then chr(64 + m.pool) end as pool_letter,
       m.round,
       m.position,
       m.label,
       m.wave,
       m.queue_seq,
       m.on_hold,
       m.status,
       m.is_bye,
       m.team1_bye,
       m.team2_bye,
       m.team1_id,
       coalesce(t1.name,
                case when m.team1_bye then 'BYE' end,
                case when m.round_key = 'grand_final' and m.round = 2 then 'Winners-bracket team' end,
                (select 'Winner of ' || f.label from public.matches f
                 where f.winner_to_match_id = m.id and f.winner_to_slot = 1 limit 1),
                (select 'Loser of ' || f.label from public.matches f
                 where f.loser_to_match_id = m.id and f.loser_to_slot = 1 limit 1),
                'Seed ' || m.team1_seed,
                'TBD') as team1_name,
       m.team2_id,
       coalesce(t2.name,
                case when m.team2_bye then 'BYE' end,
                case when m.round_key = 'grand_final' and m.round = 2 then 'Losers-bracket team' end,
                (select 'Winner of ' || f.label from public.matches f
                 where f.winner_to_match_id = m.id and f.winner_to_slot = 2 limit 1),
                (select 'Loser of ' || f.label from public.matches f
                 where f.loser_to_match_id = m.id and f.loser_to_slot = 2 limit 1),
                'Seed ' || m.team2_seed,
                'TBD') as team2_name,
       m.team1_seed,
       m.team2_seed,
       m.court_id,
       c.name as court_name,
       c.stream_url as court_stream_url,
       m.queued_at,
       m.assigned_at,
       m.started_at,
       m.completed_at,
       m.games,
       m.winner_team_id,
       m.forfeit,
       m.winner_to_match_id,
       m.loser_to_match_id,
       f.games_to,
       f.best_of,
       f.point_cap,
       public.describe_format(f.games_to, f.best_of, f.point_cap) as format_text
from public.matches m
join public.events e on e.id = m.event_id
cross join lateral (
  select coalesce((rf.x ->> 'games_to')::int,
                  case when m.stage = 'bracket' then coalesce(e.playoff_games_to, e.games_to) else e.games_to end) as games_to,
         coalesce((rf.x ->> 'best_of')::int,
                  case when m.stage = 'bracket' then coalesce(e.playoff_best_of, e.best_of) else e.best_of end) as best_of,
         case when rf.x ? 'point_cap' then (rf.x ->> 'point_cap')::int
              when m.stage = 'bracket' then coalesce(e.playoff_point_cap, e.point_cap)
              else e.point_cap end as point_cap
  from (select (select x from jsonb_array_elements(e.round_formats) x where x ->> 'key' = m.round_key limit 1) as x) rf
) f
left join public.teams t1 on t1.id = m.team1_id
left join public.teams t2 on t2.id = m.team2_id
left join public.courts c on c.id = m.court_id;

-- One row per active court with the live match on it. A match is a no-show
-- when match_status = 'assigned' and the current time is past no_show_deadline.
create view public.court_board with (security_invoker = true) as
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
       md.format_text
from public.courts c
join public.tournaments t on t.id = c.tournament_id
left join public.match_details md on md.court_id = c.id and md.status in ('assigned', 'in_progress')
where c.retired_at is null;

-- Pool standings. Order: win percentage (teams may play different numbers
-- of matches when pool play is cut short), then wins, then wins against
-- teams tied with them (head-to-head), then point differential, then points.
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
         order by tt.win_pct desc, tt.wins desc, coalesce(h.wins_vs_tied, 0) desc,
                  tt.points_for - tt.points_against desc, tt.points_for desc,
                  tt.seed nulls last, tt.team_name
       )::int as pool_rank
from rated tt
left join head_to_head h on h.team_id = tt.team_id;
