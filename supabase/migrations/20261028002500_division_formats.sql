-- More ways to run a division:
--
--  * events.bracket_size: any number of teams in the bracket, not just a
--    multiple of the pools. 3 pools with 8 in the bracket takes the top 2 of
--    each pool and the 2 best third-place teams. Null = pool_count x
--    advance_per_pool, as before.
--  * bracket_type 'medal': straight to the medal matches, seeds 1 v 2 for gold
--    and 3 v 4 for bronze. With 2 pools that's the pool winners for gold and
--    the runners-up for bronze.
--  * events.pool_play 'swiss': Swiss rounds instead of a round robin. Each
--    round pairs teams with similar records who haven't played each other,
--    and is drawn when the round before it finishes. max_rounds is the number
--    of rounds. Then the top teams go to the bracket as usual.

alter table public.events
  add column bracket_size int check (bracket_size >= 2),
  add column pool_play text not null default 'round_robin' check (pool_play in ('round_robin', 'swiss'));
alter table public.events drop constraint events_bracket_type_check;
alter table public.events add constraint events_bracket_type_check check (bracket_type in ('single', 'double', 'medal'));
grant update (bracket_size, pool_play) on public.events to authenticated;

-- How many teams go from pool play to the bracket.
create function private.bracket_seeds(e public.events) returns int
language sql immutable set search_path = '' as $$
  select coalesce(e.bracket_size, e.pool_count * e.advance_per_pool)
$$;

-- ---------------------------------------------------------------------------
-- Building the bracket
-- ---------------------------------------------------------------------------

-- Medal matches only: seeds 1 v 2 for gold, and 3 v 4 for bronze.
create function private.build_medal_matches(p_event public.events, p_seeds int, p_teams uuid[], p_wave_offset int)
returns int
language plpgsql set search_path = '' as $$
begin
  if p_seeds not in (2, 4) then
    raise exception 'Medal matches need 4 teams in the bracket (or 2 for a gold match only), not %', p_seeds
      using errcode = '22023';
  end if;
  insert into public.matches
    (tournament_id, event_id, stage, side, pool, round, position, label, round_key,
     team1_seed, team2_seed, team1_id, team2_id, wave, queue_seq)
  values
    (p_event.tournament_id, p_event.id, 'bracket', 'main', 0, 1, 1, 'Final', 'final',
     1, 2, p_teams[1], p_teams[2], p_wave_offset + 1, private.default_queue_seq(p_event.id, p_wave_offset + 1, 0, 1));
  if p_seeds = 4 then
    insert into public.matches
      (tournament_id, event_id, stage, side, pool, round, position, label, round_key,
       team1_seed, team2_seed, team1_id, team2_id, wave, queue_seq)
    values
      (p_event.tournament_id, p_event.id, 'bracket', 'final', 0, 1, 1, 'Bronze', 'bronze',
       3, 4, p_teams[3], p_teams[4], p_wave_offset + 1, private.default_queue_seq(p_event.id, p_wave_offset + 1, 0, 2));
  end if;
  return p_seeds / 2;
end $$;

-- The bracket for the event's bracket_type. p_teams: as for build_bracket.
create function private.build_playoffs(p_event public.events, p_seeds int, p_teams uuid[], p_wave_offset int)
returns int
language plpgsql set search_path = '' as $$
begin
  return case p_event.bracket_type
    when 'double' then private.build_double_elim(p_event, p_seeds, p_teams, p_wave_offset)
    when 'medal' then private.build_medal_matches(p_event, p_seeds, p_teams, p_wave_offset)
    else private.build_bracket(p_event, p_seeds, p_teams, p_wave_offset)
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Swiss rounds
-- ---------------------------------------------------------------------------

create function private.have_played(p_event uuid, p_a uuid, p_b uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.matches
    where event_id = p_event and stage = 'pool'
      and ((team1_id = p_a and team2_id = p_b) or (team1_id = p_b and team2_id = p_a))
  )
$$;

-- Draws Swiss round p_round from the standings. With an odd number of teams
-- the lowest-ranked team that has sat out least sits out. Round 1 pairs the
-- top half with the bottom half by seed (1 v 5, 2 v 6, ... for 8 teams);
-- later rounds pair each team with the next one down the standings it hasn't
-- played, then swap partners between pairs to undo any rematch left over.
-- Returns the number of matches.
create function private.pair_swiss_round(p_event public.events, p_round int) returns int
language plpgsql set search_path = '' as $$
declare
  v_teams uuid[];
  v_out uuid;
  v_n int;
  v_taken boolean[];
  v_pairs uuid[] := '{}';
  v_pick int;
  v_any int;
  v_team uuid;
  i int;
  j int;
  k int;
  l int;
begin
  v_teams := array(select team_id from public.standings where event_id = p_event.id order by pool_rank);
  if cardinality(v_teams) % 2 = 1 then
    select t into v_out
    from unnest(v_teams) with ordinality as x(t, n)
    order by (select count(*) from public.matches m
              where m.event_id = p_event.id and m.stage = 'pool' and x.t in (m.team1_id, m.team2_id)) desc,
             n desc
    limit 1;
    v_teams := array_remove(v_teams, v_out);
  end if;
  v_n := cardinality(v_teams);
  if v_n < 2 then
    return 0;
  end if;

  if p_round = 1 then
    for i in 1 .. v_n / 2 loop
      v_pairs := v_pairs || v_teams[i] || v_teams[i + v_n / 2];
    end loop;
  else
    v_taken := array_fill(false, array[v_n]);
    for i in 1 .. v_n loop
      continue when v_taken[i];
      v_taken[i] := true;
      v_pick := null;
      v_any := null;
      for j in i + 1 .. v_n loop
        continue when v_taken[j];
        v_any := coalesce(v_any, j);
        if not private.have_played(p_event.id, v_teams[i], v_teams[j]) then
          v_pick := j;
          exit;
        end if;
      end loop;
      v_pick := coalesce(v_pick, v_any);
      v_taken[v_pick] := true;
      v_pairs := v_pairs || v_teams[i] || v_teams[v_pick];
    end loop;

    -- A rematch left at the bottom: swap partners with a pair above it.
    for k in reverse v_n / 2 .. 1 loop
      continue when not private.have_played(p_event.id, v_pairs[2 * k - 1], v_pairs[2 * k]);
      for l in reverse k - 1 .. 1 loop
        if not private.have_played(p_event.id, v_pairs[2 * l - 1], v_pairs[2 * k])
           and not private.have_played(p_event.id, v_pairs[2 * l], v_pairs[2 * k - 1]) then
          v_team := v_pairs[2 * l]; v_pairs[2 * l] := v_pairs[2 * k - 1]; v_pairs[2 * k - 1] := v_team;
          exit;
        elsif not private.have_played(p_event.id, v_pairs[2 * l - 1], v_pairs[2 * k - 1])
              and not private.have_played(p_event.id, v_pairs[2 * l], v_pairs[2 * k]) then
          v_team := v_pairs[2 * l]; v_pairs[2 * l] := v_pairs[2 * k]; v_pairs[2 * k] := v_team;
          exit;
        end if;
      end loop;
    end loop;
  end if;

  for k in 1 .. v_n / 2 loop
    insert into public.matches
      (tournament_id, event_id, stage, pool, round, position, label, round_key, team1_id, team2_id, wave, queue_seq)
    values
      (p_event.tournament_id, p_event.id, 'pool', 1, p_round, k, 'Round ' || p_round, 'pool',
       v_pairs[2 * k - 1], v_pairs[2 * k], p_round, private.default_queue_seq(p_event.id, p_round, 1, k));
  end loop;
  return v_n / 2;
end $$;

-- After a pool match: when every match of the current Swiss round is done,
-- draws the next one, until max_rounds.
create function private.next_swiss_round(p_event uuid) returns void
language plpgsql set search_path = '' as $$
declare
  e public.events;
  v_round int;
begin
  select * into e from public.events where id = p_event;
  if e.pool_play <> 'swiss' or exists (
    select 1 from public.matches
    where event_id = p_event and stage = 'pool' and status not in ('completed', 'cancelled')
  ) then
    return;
  end if;
  select coalesce(max(round), 0) into v_round from public.matches where event_id = p_event and stage = 'pool';
  if v_round >= e.max_rounds then
    return;
  end if;
  if private.pair_swiss_round(e, v_round + 1) = 0 then
    -- Too few teams left to pair: Swiss play is over.
    update public.events set max_rounds = v_round where id = p_event;
  end if;
end $$;

-- As before, plus the next Swiss round when a round finishes.
create or replace function private.finish_match(p_match uuid, p_winner uuid, p_games jsonb, p_forfeit boolean)
returns void
language plpgsql set search_path = '' as $$
declare
  m public.matches;
  v_loser uuid;
  v_reset uuid;
begin
  update public.matches
  set status = 'completed', winner_team_id = p_winner, games = p_games,
      forfeit = p_forfeit, completed_at = private.clock(), on_hold = false
  where id = p_match
  returning * into m;
  v_loser := case when p_winner = m.team1_id then m.team2_id else m.team1_id end;

  if m.winner_to_match_id is not null then
    perform private.advance(m.winner_to_match_id, m.winner_to_slot, p_winner, false);
  end if;
  if m.loser_to_match_id is not null then
    perform private.advance(m.loser_to_match_id, m.loser_to_slot, v_loser, v_loser is null);
  end if;

  -- Double elimination: a losers-bracket team that wins the grand final
  -- forces the reset final (if the event has one); otherwise it isn't needed.
  if m.round_key = 'grand_final' and m.round = 1 then
    select id into v_reset from public.matches
    where event_id = m.event_id and side = 'final' and round_key = 'grand_final' and round = 2;
    if v_reset is not null then
      if p_winner = m.team2_id then
        update public.matches set team1_id = m.team1_id, team2_id = m.team2_id where id = v_reset;
      else
        update public.matches set status = 'cancelled' where id = v_reset;
      end if;
    end if;
  end if;

  if m.stage = 'pool' then
    perform private.next_swiss_round(m.event_id);
    perform private.seed_playoffs_when_pools_done(m.event_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Seeding the bracket from pool play
-- ---------------------------------------------------------------------------

-- When pool play is over (every pool match played or cancelled, and every
-- Swiss round drawn), seeds the bracket: every pool winner first, then every
-- runner-up, and so on, best record first within each place, and takes the
-- top bracket_seeds. Teams from different pools compare by win percentage,
-- then point differential and points per match (pools can differ in size).
-- Avoids same-pool first-round matchups where possible. With confirm_seeds
-- the bracket waits for start_bracket.
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

  if e.confirm_seeds then
    update public.matches set on_hold = true where event_id = p_event and stage = 'bracket';
  end if;
  for v_match in
    select id from public.matches where event_id = p_event and stage = 'bracket' and status = 'waiting'
    order by round
  loop
    perform private.settle(v_match);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

-- Builds the event's matches from its teams (in seed order) and adds them to
-- the queue: round robin pools (or Swiss round 1), then the bracket, waiting
-- for its seeds. Returns the number of matches created.
create or replace function public.generate_matches(p_event uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_teams uuid[];
  v_count int;
  v_created int;
  v_pool_rounds int;
  v_seeds int;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  if exists (select 1 from public.matches where event_id = p_event) then
    raise exception 'This event already has matches' using errcode = '55000';
  end if;

  v_teams := array(
    select id from public.teams
    where event_id = p_event and withdrawn_at is null
    order by seed nulls last, created_at, id
  );
  v_count := cardinality(v_teams);
  if v_count < 2 then
    raise exception 'An event needs at least 2 teams' using errcode = '22023';
  end if;

  if e.format = 'single_elim' then
    update public.teams set pool = null where event_id = p_event;
    v_created := private.build_playoffs(e, v_count, v_teams, 0);
    if e.confirm_seeds then
      update public.matches set on_hold = true where event_id = p_event;
    end if;
    perform private.auto_assign(e.tournament_id);
    return v_created;
  end if;

  if e.pool_play = 'swiss' then
    if e.pool_count <> 1 then
      raise exception 'Swiss rounds play as one group: set pools to 1' using errcode = '22023';
    end if;
    if e.max_rounds is null then
      raise exception 'Choose how many Swiss rounds to play' using errcode = '22023';
    end if;
    -- Everyone can meet someone new each round (an odd team count sits one out).
    if e.max_rounds > v_count - 1 + v_count % 2 then
      raise exception '% teams can play at most % Swiss rounds', v_count, v_count - 1 + v_count % 2
        using errcode = '22023';
    end if;
    update public.teams set pool = 1 where event_id = p_event and withdrawn_at is null;
    v_created := private.pair_swiss_round(e, 1);
    v_pool_rounds := e.max_rounds;
  else
    if v_count < 2 * e.pool_count then
      raise exception '% pools need at least % teams', e.pool_count, 2 * e.pool_count using errcode = '22023';
    end if;
    v_created := private.generate_pools(e, v_teams);
    select max(round) into v_pool_rounds from public.matches where event_id = p_event;
  end if;

  if e.format = 'pools_to_bracket' then
    v_seeds := private.bracket_seeds(e);
    if e.bracket_size is null and e.pool_play = 'round_robin' and e.advance_per_pool > v_count / e.pool_count then
      raise exception 'Can''t advance % per pool: the smallest pool has % teams',
        e.advance_per_pool, v_count / e.pool_count using errcode = '22023';
    end if;
    if v_seeds < 2 then
      raise exception 'At least 2 teams must advance to the bracket' using errcode = '22023';
    end if;
    if v_seeds > v_count then
      raise exception 'The bracket has % places but there are only % teams', v_seeds, v_count using errcode = '22023';
    end if;
    v_created := v_created + private.build_playoffs(e, v_seeds, null, v_pool_rounds);
  end if;

  perform private.auto_assign(e.tournament_id);
  return v_created;
end $$;

-- Director: end pool play now. Pool matches not yet on a court are cancelled
-- (standings use the matches played); matches on court finish normally, and
-- the bracket is seeded once they do. Swiss play stops after the round being
-- played. Returns how many were cancelled.
create or replace function public.end_pool_play(p_event uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_cancelled int;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);

  if e.pool_play = 'swiss' then
    update public.events
    set max_rounds = (select coalesce(max(round), 0) from public.matches where event_id = p_event and stage = 'pool')
    where id = p_event;
  end if;
  update public.matches
  set status = 'cancelled', on_hold = false
  where event_id = p_event and stage = 'pool' and status in ('waiting', 'queued');
  get diagnostics v_cancelled = row_count;
  perform private.seed_playoffs_when_pools_done(p_event);
  perform private.auto_assign(e.tournament_id);
  return v_cancelled;
end $$;

-- Director: how many teams go to the bracket. Before the bracket is seeded
-- it's rebuilt for the new number of seeds; after, it's too late.
create function public.set_bracket_size(p_event uuid, p_size int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_teams int;
  v_pool_rounds int;
  v_created int;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  if e.format <> 'pools_to_bracket' then
    raise exception 'Only pools-to-bracket events advance teams from pools' using errcode = '22023';
  end if;
  if p_size is null or p_size < 2 then
    raise exception 'At least 2 teams must advance to the bracket' using errcode = '22023';
  end if;

  if not exists (select 1 from public.matches where event_id = p_event) then
    update public.events set bracket_size = p_size, advance_per_pool = greatest(1, p_size / pool_count) where id = p_event;
    return 0;
  end if;
  if e.playoffs_seeded_at is not null then
    raise exception 'The bracket is already seeded from pool play, so this can''t change now' using errcode = '55000';
  end if;
  select count(*) into v_teams from public.teams where event_id = p_event and withdrawn_at is null and pool is not null;
  if p_size > v_teams then
    raise exception 'The bracket has % places but there are only % teams', p_size, v_teams using errcode = '22023';
  end if;

  delete from public.matches where event_id = p_event and stage = 'bracket';
  update public.events set bracket_size = p_size, advance_per_pool = greatest(1, p_size / pool_count)
  where id = p_event returning * into e;
  v_pool_rounds := case when e.pool_play = 'swiss' then e.max_rounds
                        else (select max(round) from public.matches where event_id = p_event and stage = 'pool') end;
  v_created := private.build_playoffs(e, p_size, null, v_pool_rounds);
  -- Pool play may already be over (e.g. ended early): seed right away.
  perform private.seed_playoffs_when_pools_done(p_event);
  perform private.auto_assign(e.tournament_id);
  return v_created;
end $$;

-- Director: how many advance from each pool (bracket size = pools x this).
create or replace function public.set_advance_per_pool(p_event uuid, p_advance int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_smallest int;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  if p_advance is null or p_advance < 1 then
    raise exception 'At least 1 team must advance from each pool' using errcode = '22023';
  end if;
  select min(n) into v_smallest from (
    select count(*) as n from public.teams
    where event_id = p_event and withdrawn_at is null and pool is not null group by pool
  ) sizes;
  if e.playoffs_seeded_at is null and p_advance > v_smallest then
    raise exception 'Can''t advance % per pool: the smallest pool has % teams', p_advance, v_smallest
      using errcode = '22023';
  end if;
  return public.set_bracket_size(p_event, e.pool_count * p_advance);
end $$;
