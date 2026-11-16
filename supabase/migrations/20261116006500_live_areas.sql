-- Live screens reload only what changed. tournament_live keeps a revision per
-- area as well as the overall one, and each area goes up at most once per
-- transaction (a score report that moves ten matches is one change, not ten
-- Realtime messages). Matches note when they last changed, so screens fetch
-- just the matches that changed (lib/live.ts).
--
-- Areas (revs keys) and what bumps them:
--   tournament     the tournament row
--   events         its divisions
--   teams          any team change (check-in, pool, seed, withdrawal)
--   team_names     a team added, removed or renamed (match lists show names)
--   matches        any match change
--   match_deletes  a match removed (a partial reload can't see those)
--   courts         its courts
--   checkins       player check-ins

alter table public.tournament_live add column revs jsonb not null default '{}';

alter table public.matches add column updated_at timestamptz not null default clock_timestamp();
create index matches_tournament_updated_idx on public.matches (tournament_id, updated_at);
-- Readable like the other match columns (access).
grant select (updated_at) on public.matches to anon, authenticated;

create function private.matches_set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

create trigger matches_set_updated_at before update on public.matches
  for each row execute function private.matches_set_updated_at();

-- Bumps one area of a tournament, once per transaction.
create function private.bump_live_area(p_tournament uuid, p_area text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_key text := 'live.t' || replace(p_tournament::text, '-', '') || '_' || p_area;
begin
  if p_tournament is null or current_setting(v_key, true) = '1' then
    return;
  end if;
  perform set_config(v_key, '1', true);
  update public.tournament_live
  set revision = revision + 1,
      revs = revs || jsonb_build_object(p_area, coalesce((revs ->> p_area)::bigint, 0) + 1),
      updated_at = now()
  where tournament_id = p_tournament;
end $$;

-- As before (core_schema), by area. Update only: during a cascade delete the
-- tournament_live row is already gone.
create or replace function private.bump_tournament_live() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tournament uuid;
  v_area text := tg_argv[0];
begin
  if tg_op = 'DELETE' then
    v_tournament := old.tournament_id;
  else
    v_tournament := new.tournament_id;
  end if;
  perform private.bump_live_area(v_tournament, v_area);
  -- (Nested: only teams have a name to compare.)
  if v_area = 'teams' then
    if tg_op <> 'UPDATE' then
      perform private.bump_live_area(v_tournament, 'team_names');
    elsif old.name is distinct from new.name or old.tournament_id is distinct from new.tournament_id then
      perform private.bump_live_area(v_tournament, 'team_names');
      perform private.bump_live_area(old.tournament_id, 'teams');
      perform private.bump_live_area(old.tournament_id, 'team_names');
    end if;
  elsif v_area = 'matches' and tg_op = 'DELETE' then
    perform private.bump_live_area(v_tournament, 'match_deletes');
  end if;
  return null;
end $$;

create or replace function private.tournaments_bump_live() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.bump_live_area(new.id, 'tournament');
  return null;
end $$;

drop trigger matches_bump_live on public.matches;
drop trigger courts_bump_live on public.courts;
drop trigger teams_bump_live on public.teams;
drop trigger events_bump_live on public.events;
drop trigger player_checkins_bump_live on public.player_checkins;
create trigger matches_bump_live after insert or update or delete on public.matches
  for each row execute function private.bump_tournament_live('matches');
create trigger courts_bump_live after insert or update or delete on public.courts
  for each row execute function private.bump_tournament_live('courts');
create trigger teams_bump_live after insert or update or delete on public.teams
  for each row execute function private.bump_tournament_live('teams');
create trigger events_bump_live after insert or update or delete on public.events
  for each row execute function private.bump_tournament_live('events');
create trigger player_checkins_bump_live after insert or update or delete on public.player_checkins
  for each row execute function private.bump_tournament_live('checkins');

-- As before (views), plus when the match last changed.
create or replace view public.match_details with (security_invoker = true) as
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
       public.describe_format(f.games_to, f.best_of, f.point_cap) as format_text,
       m.updated_at
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
