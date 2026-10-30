-- Pool play ends with a director's review. When the last pool match is
-- played (or pool play is ended early), nothing moves on by itself: the
-- director checks the scores and standings (scores can still be corrected),
-- then finalizes pool play (finalize_pool_play), which seeds the bracket from
-- the final standings. The bracket is then held so they can arrange seeds,
-- and starts when they start it (start_bracket). Before, the bracket was
-- seeded the moment pool play ended, which locked the pool scores.
-- (events.confirm_seeds still holds a bracket-only division at its start.)

alter table public.events add column pools_finalized_at timestamptz;
-- Brackets already seeded were finalized then.
update public.events set pools_finalized_at = playoffs_seeded_at where playoffs_seeded_at is not null;

-- As before (division_formats), waiting for the director's finalize, and always holding the bracket.
create or replace function private.seed_playoffs_when_pools_done(p_event uuid) returns void
language plpgsql set search_path = '' as $$
declare
  e public.events;
  v_teams uuid[];
  v_pools int[];
  v_opponent int[];
  v_tier_size int;
  v_seeds int;
  r record;
  a int;
  b int;
  c int;
  v_team uuid;
  v_pool int;
  v_match uuid;
begin
  select * into e from public.events where id = p_event;
  if e.format <> 'pools_to_bracket' or e.playoffs_seeded_at is not null then
    return;
  end if;
  -- Only once a director has reviewed pool play and finalized it.
  if e.pools_finalized_at is null then
    return;
  end if;
  if exists (
    select 1 from public.matches
    where event_id = p_event and stage = 'pool' and status not in ('completed', 'cancelled')
  ) then
    return;
  end if;
  if e.pool_play = 'swiss'
     and (select coalesce(max(round), 0) from public.matches where event_id = p_event and stage = 'pool') < e.max_rounds then
    return;
  end if;

  select array_agg(team_id order by n), array_agg(pool order by n)
  into v_teams, v_pools
  from (
    select s.team_id, s.pool,
           row_number() over (
             order by s.pool_rank, s.win_pct desc,
                      s.point_diff::numeric / greatest(s.played, 1) desc,
                      s.points_for::numeric / greatest(s.played, 1) desc, s.pool
           ) as n
    from public.standings s
    where s.event_id = p_event
  ) ranked
  where n <= private.bracket_seeds(e);
  v_seeds := coalesce(cardinality(v_teams), 0);

  -- Who each seed meets in the first round (null = bye).
  v_opponent := array_fill(null::int, array[greatest(v_seeds, 1)]);
  for r in
    select team1_seed, team2_seed from public.matches
    where event_id = p_event and stage = 'bracket' and team1_seed <= v_seeds and team2_seed <= v_seeds
  loop
    v_opponent[r.team1_seed] := r.team2_seed;
    v_opponent[r.team2_seed] := r.team1_seed;
  end loop;

  v_tier_size := e.pool_count;
  for a in 1 .. v_seeds loop
    b := v_opponent[a];
    continue when b is null or b < a or v_pools[a] <> v_pools[b];
    -- Swap b with another seed of the same finishing place from another pool,
    -- if that doesn't create a same-pool matchup for the other seed.
    for c in ((b - 1) / v_tier_size) * v_tier_size + 1 .. least(((b - 1) / v_tier_size + 1) * v_tier_size, v_seeds) loop
      continue when c = b or c = a or v_pools[c] = v_pools[a];
      continue when v_opponent[c] is not null and v_opponent[c] <> b and v_pools[v_opponent[c]] = v_pools[b];
      v_team := v_teams[b]; v_teams[b] := v_teams[c]; v_teams[c] := v_team;
      v_pool := v_pools[b]; v_pools[b] := v_pools[c]; v_pools[c] := v_pool;
      exit;
    end loop;
  end loop;

  -- Seeds nobody earned (a withdrawn team left a pool short) become byes.
  update public.matches
  set team1_id = v_teams[team1_seed], team1_bye = team1_seed > v_seeds
  where event_id = p_event and stage = 'bracket' and team1_seed is not null;
  update public.matches
  set team2_id = v_teams[team2_seed], team2_bye = team2_seed > v_seeds
  where event_id = p_event and stage = 'bracket' and team2_seed is not null;
  update public.events set playoffs_seeded_at = private.clock() where id = p_event;

  -- Held for the director to check the seeds and start it (start_bracket).
  update public.matches set on_hold = true where event_id = p_event and stage = 'bracket';
  for v_match in
    select id from public.matches where event_id = p_event and stage = 'bracket' and status = 'waiting'
    order by round
  loop
    perform private.settle(v_match);
  end loop;
end $$;

-- Director: pool play is reviewed and final. Seeds the bracket (held).
create function public.finalize_pool_play(p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  if e.format <> 'pools_to_bracket' then
    raise exception 'This division has no bracket after pool play' using errcode = '22023';
  end if;
  if e.pools_finalized_at is not null then
    raise exception 'Pool play is already final' using errcode = '55000';
  end if;
  if not exists (select 1 from public.matches where event_id = p_event and stage = 'pool')
     or exists (select 1 from public.matches where event_id = p_event and stage = 'pool'
                and status not in ('completed', 'cancelled'))
     or (e.pool_play = 'swiss'
         and (select coalesce(max(round), 0) from public.matches where event_id = p_event and stage = 'pool') < e.max_rounds) then
    raise exception 'Pool play isn''t finished: play the remaining matches, or end pool play' using errcode = '55000';
  end if;
  update public.events set pools_finalized_at = private.clock() where id = p_event;
  perform private.seed_playoffs_when_pools_done(p_event);
  perform private.auto_assign(e.tournament_id);
end $$;

-- Whether any of a division's bracket has been played or called (byes aside).
create function private.bracket_started(p_event uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.matches
    where event_id = p_event and stage = 'bracket' and not is_bye and status in ('assigned', 'in_progress', 'completed')
  )
$$;

-- A seeded bracket that hasn't started, built and seeded again from the
-- pool standings as they are now (as set_bracket_size rebuilds it). Seeds a
-- director arranged by hand are lost.
create function private.reseed_bracket(p_event uuid) returns void
language plpgsql set search_path = '' as $$
declare
  e public.events;
begin
  delete from public.matches where event_id = p_event and stage = 'bracket';
  update public.events set playoffs_seeded_at = null where id = p_event returning * into e;
  perform private.build_playoffs(e, private.bracket_seeds(e), null,
    case when e.pool_play = 'swiss' then e.max_rounds
         else (select max(round) from public.matches where event_id = p_event and stage = 'pool') end);
  perform private.seed_playoffs_when_pools_done(p_event);
end $$;

-- As before (brackets), with pool scores open to correction after seeding.
create or replace function public.correct_score(p_match uuid, p_games jsonb) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  v_next public.matches;
  v_winner uuid;
  v_loser uuid;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  if m.status <> 'completed' or m.is_bye then
    raise exception 'Only finished matches can be corrected' using errcode = '55000';
  end if;
  v_winner := private.score_winner(m, p_games);
  v_loser := case when v_winner = m.team1_id then m.team2_id else m.team1_id end;

  if v_winner is distinct from m.winner_team_id then
    for v_next in
      select * from public.matches where id in (m.winner_to_match_id, m.loser_to_match_id) for update
    loop
      if v_next.status in ('assigned', 'in_progress', 'completed') and not v_next.is_bye then
        raise exception 'The next match (%) has already started', v_next.label using errcode = '55000';
      end if;
    end loop;
    if m.winner_to_match_id is not null then
      update public.matches set status = 'waiting' where id = m.winner_to_match_id and status = 'queued';
      perform private.advance(m.winner_to_match_id, m.winner_to_slot, v_winner, false);
    end if;
    if m.loser_to_match_id is not null then
      update public.matches set status = 'waiting' where id = m.loser_to_match_id and status = 'queued';
      perform private.advance(m.loser_to_match_id, m.loser_to_slot, v_loser, false);
    end if;
  end if;

  update public.matches
  set games = p_games, winner_team_id = v_winner, forfeit = false
  where id = p_match
  returning * into m;
  -- A pool score fixed after the bracket was seeded: the bracket is seeded
  -- again from the new standings while none of it has been played. Once it
  -- has, it stands; the fix is for the record (and DUPR).
  if m.stage = 'pool'
     and exists (select 1 from public.events where id = m.event_id and playoffs_seeded_at is not null)
     and not private.bracket_started(m.event_id) then
    perform private.reseed_bracket(m.event_id);
  end if;
  perform private.auto_assign(m.tournament_id);
  return m;
end $$;
