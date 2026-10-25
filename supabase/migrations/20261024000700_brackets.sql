-- Brackets after pool play: single or double elimination, an optional bronze
-- match, game formats per round, byes for any bracket size, and seeds the
-- director can rearrange before the bracket starts. Also: a cap on round-
-- robin rounds, ending pool play early, and the game format in court texts.
--
-- This replaces several court_engine functions (create or replace) and adds
-- new API functions: end_pool_play, start_bracket, swap_bracket_teams.

-- ---------------------------------------------------------------------------
-- Formats and texts
-- ---------------------------------------------------------------------------

-- The winning team for p_games, using the match's own format (its round's
-- format, else the event's playoff or pool format; see match_details).
create or replace function private.score_winner(m public.matches, p_games jsonb) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_best_of int;
begin
  select best_of into v_best_of from public.match_details where id = m.id;
  if private.match_winner_slot(p_games, v_best_of) = 1 then
    return m.team1_id;
  end if;
  return m.team2_id;
end $$;

-- One text per player: their court, their opponents and the game format.
-- {url} becomes the match's score-report link when the sender delivers it.
create or replace function private.notify_match_players(p_match uuid, p_kind text) returns void
language sql set search_path = '' as $$
  insert into public.notifications (tournament_id, player_id, match_id, kind, body)
  select md.tournament_id, tp.player_id, md.id, p_kind,
         case p_kind
           when 'court_changed' then
             'Court change: your match versus ' || opponent.name || ' is now on ' || upper(md.court_name)
             || '. Report your scores here: {url}'
           else
             'Your match is ready on ' || upper(md.court_name) || ' versus ' || opponent.name
             || '. ' || initcap(left(md.format_text, 1)) || substr(md.format_text, 2)
             || '. Promptly report your scores here: {url} when finished.'
         end
  from public.match_details md
  join public.team_players tp on tp.team_id in (md.team1_id, md.team2_id)
  join public.teams opponent
    on opponent.id = case when tp.team_id = md.team1_id then md.team2_id else md.team1_id end
  where md.id = p_match
$$;

-- ---------------------------------------------------------------------------
-- Moving teams through a bracket
-- ---------------------------------------------------------------------------

-- Puts a team (or a bye) into a match slot, then settles the match if it
-- can now resolve itself.
create function private.advance(p_match uuid, p_slot smallint, p_team uuid, p_bye boolean) returns void
language plpgsql set search_path = '' as $$
begin
  if p_slot = 1 then
    update public.matches set team1_id = p_team, team1_bye = coalesce(p_bye, false) where id = p_match;
  else
    update public.matches set team2_id = p_team, team2_bye = coalesce(p_bye, false) where id = p_match;
  end if;
  perform private.settle(p_match);
end $$;

-- Kept for correct_score: replace the team in a slot.
create or replace function private.place_in_slot(p_match uuid, p_slot smallint, p_team uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform private.advance(p_match, p_slot, p_team, p_team is null);
end $$;

-- A match whose two slots are both decided completes by itself when one of
-- them is a bye (the other side moves on) or a withdrawn team (forfeit).
create function private.settle(p_match uuid) returns void
language plpgsql set search_path = '' as $$
declare
  m public.matches;
  v_withdrawn uuid;
  v_winner uuid;
begin
  select * into m from public.matches where id = p_match;
  if m.status not in ('waiting', 'queued')
     or not ((m.team1_id is not null or m.team1_bye) and (m.team2_id is not null or m.team2_bye)) then
    return;
  end if;

  if m.team1_bye or m.team2_bye then
    v_winner := coalesce(m.team1_id, m.team2_id); -- null when both are byes
    update public.matches
    set status = 'completed', is_bye = true, forfeit = true, winner_team_id = v_winner,
        completed_at = private.clock()
    where id = m.id;
    if m.winner_to_match_id is not null then
      perform private.advance(m.winner_to_match_id, m.winner_to_slot, v_winner, v_winner is null);
    end if;
    if m.loser_to_match_id is not null then
      perform private.advance(m.loser_to_match_id, m.loser_to_slot, null, true);
    end if;
    return;
  end if;

  select id into v_withdrawn from public.teams
  where id in (m.team1_id, m.team2_id) and withdrawn_at is not null
  limit 1;
  if v_withdrawn is not null then
    perform private.finish_match(
      m.id, case when v_withdrawn = m.team1_id then m.team2_id else m.team1_id end, null, true
    );
  end if;
end $$;

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
    perform private.seed_playoffs_when_pools_done(m.event_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Generating pools and brackets
-- ---------------------------------------------------------------------------

-- Splits teams (in seed order) into pools by snake seeding and plays a round
-- robin in each pool (circle method), for at most max_rounds rounds.
create or replace function private.generate_pools(p_event public.events, p_teams uuid[]) returns int
language plpgsql set search_path = '' as $$
declare
  v_pools int := p_event.pool_count;
  v_pool int;
  v_ring uuid[];
  v_size int;
  v_round int;
  v_slot int;
  v_position int;
  v_created int := 0;
begin
  for v_pool in 1 .. v_pools loop
    -- Snake: seeds 1..P go to pools A..P, seeds P+1..2P back from P to A, ...
    v_ring := array(
      select p_teams[i]
      from generate_series(1, cardinality(p_teams)) i
      where case when ((i - 1) / v_pools) % 2 = 0 then (i - 1) % v_pools + 1
                 else v_pools - (i - 1) % v_pools end = v_pool
      order by i
    );
    update public.teams set pool = v_pool where id = any (v_ring);

    if cardinality(v_ring) % 2 = 1 then
      v_ring := array_append(v_ring, null::uuid); -- the team paired with null sits out
    end if;
    v_size := cardinality(v_ring);

    for v_round in 1 .. least(v_size - 1, coalesce(p_event.max_rounds, v_size - 1)) loop
      v_position := 0;
      for v_slot in 1 .. v_size / 2 loop
        if v_ring[v_slot] is not null and v_ring[v_size + 1 - v_slot] is not null then
          v_position := v_position + 1;
          insert into public.matches
            (tournament_id, event_id, stage, pool, round, position, label, round_key,
             team1_id, team2_id, wave, queue_seq)
          values
            (p_event.tournament_id, p_event.id, 'pool', v_pool, v_round, v_position,
             case when v_pools > 1 then 'Pool ' || chr(64 + v_pool) || ' · Round ' || v_round
                  else 'Round ' || v_round end,
             'pool', v_ring[v_slot], v_ring[v_size + 1 - v_slot], v_round,
             private.default_queue_seq(p_event.id, v_round, v_pool, v_position));
          v_created := v_created + 1;
        end if;
      end loop;
      -- Keep the first team fixed and rotate the rest one place.
      v_ring := v_ring[1:1] || v_ring[v_size:v_size] || v_ring[2:v_size - 1];
    end loop;
  end loop;
  return v_created;
end $$;

-- Standard seed order for a bracket of p_size slots, e.g. 8 -> 1,8,4,5,2,7,3,6.
create function private.seed_order(p_size int) returns int[]
language plpgsql immutable set search_path = '' as $$
declare
  v_order int[] := array[1];
  v_next int[];
  v_seed int;
begin
  while cardinality(v_order) < p_size loop
    v_next := '{}';
    foreach v_seed in array v_order loop
      v_next := v_next || v_seed || (cardinality(v_order) * 2 + 1 - v_seed);
    end loop;
    v_order := v_next;
  end loop;
  return v_order;
end $$;

-- Single elimination for p_seeds seeds; top seeds get byes when p_seeds isn't
-- a power of 2. p_teams (in seed order) fills the slots now; null when seeds
-- are decided later (pools_to_bracket). Adds a bronze match when the event
-- has third_place_match.
create or replace function private.build_bracket(p_event public.events, p_seeds int, p_teams uuid[], p_wave_offset int)
returns int
language plpgsql set search_path = '' as $$
declare
  v_size int := 1;
  v_rounds int := 0;
  v_order int[];
  v_round int;
  v_position int;
  v_target uuid;
  v_bronze uuid;
  v_seed1 int;
  v_seed2 int;
  v_created int := 0;
begin
  while v_size < p_seeds loop
    v_size := v_size * 2;
    v_rounds := v_rounds + 1;
  end loop;
  v_order := private.seed_order(v_size);

  if p_event.third_place_match and v_rounds >= 2 then
    insert into public.matches
      (tournament_id, event_id, stage, side, pool, round, position, label, round_key, wave, queue_seq)
    values
      (p_event.tournament_id, p_event.id, 'bracket', 'final', 0, 1, 1, 'Bronze', 'bronze',
       p_wave_offset + v_rounds, private.default_queue_seq(p_event.id, p_wave_offset + v_rounds, 0, 2))
    returning id into v_bronze;
    v_created := v_created + 1;
  end if;

  -- Build from the final backwards so each match can point at the next one.
  for v_round in reverse v_rounds .. 1 loop
    for v_position in 1 .. (v_size >> v_round) loop
      v_target := null;
      if v_round < v_rounds then
        select id into v_target from public.matches
        where event_id = p_event.id and stage = 'bracket' and side = 'main'
          and round = v_round + 1 and position = (v_position + 1) / 2;
      end if;

      v_seed1 := null;
      v_seed2 := null;
      if v_round = 1 then
        v_seed1 := v_order[2 * v_position - 1];
        v_seed2 := v_order[2 * v_position];
        if v_seed2 > p_seeds then
          -- Bye: the seeded team goes straight into its round-2 match.
          if v_position % 2 = 1 then
            update public.matches set team1_seed = v_seed1, team1_id = p_teams[v_seed1] where id = v_target;
          else
            update public.matches set team2_seed = v_seed1, team2_id = p_teams[v_seed1] where id = v_target;
          end if;
          continue;
        end if;
      end if;

      insert into public.matches
        (tournament_id, event_id, stage, side, pool, round, position, label, round_key,
         team1_seed, team2_seed, team1_id, team2_id,
         winner_to_match_id, winner_to_slot, loser_to_match_id, loser_to_slot, wave, queue_seq)
      values
        (p_event.tournament_id, p_event.id, 'bracket', 'main', 0, v_round, v_position,
         case v_rounds - v_round
           when 0 then 'Final'
           when 1 then 'Semifinal ' || v_position
           when 2 then 'Quarterfinal ' || v_position
           else 'Round of ' || (v_size >> (v_round - 1)) || ' #' || v_position
         end,
         case v_rounds - v_round
           when 0 then 'final' when 1 then 'semifinal' when 2 then 'quarterfinal' else 'earlier'
         end,
         v_seed1, v_seed2, p_teams[v_seed1], p_teams[v_seed2],
         v_target, case when v_target is not null then 2 - v_position % 2 end,
         case when v_round = v_rounds - 1 then v_bronze end,
         case when v_round = v_rounds - 1 and v_bronze is not null then 2 - v_position % 2 end,
         p_wave_offset + v_round,
         private.default_queue_seq(p_event.id, p_wave_offset + v_round, 0, v_position));
      v_created := v_created + 1;
    end loop;
  end loop;

  -- A semifinal skipped by a bye (3 teams) sends nobody to bronze: that slot is a bye.
  if v_bronze is not null then
    update public.matches b
    set team1_bye = not exists (select 1 from public.matches s where s.loser_to_match_id = b.id and s.loser_to_slot = 1),
        team2_bye = not exists (select 1 from public.matches s where s.loser_to_match_id = b.id and s.loser_to_slot = 2)
    where b.id = v_bronze;
  end if;
  return v_created;
end $$;

-- Double elimination for p_seeds seeds: a winners bracket, a losers bracket
-- (two losers rounds for each winners round after the first), and a grand
-- final, plus a reset final when the event has grand_final_reset. Byes fill
-- the empty seeds and resolve by themselves.
create function private.build_double_elim(p_event public.events, p_seeds int, p_teams uuid[], p_wave_offset int)
returns int
language plpgsql set search_path = '' as $$
declare
  v_size int := 1;
  v_k int := 0;
  v_order int[];
  v_losers_rounds int;
  v_final uuid;
  v_round int;
  v_position int;
  v_count int;
  v_target uuid;
  v_slot smallint;
  v_loser_target uuid;
  v_loser_slot smallint;
  v_seed1 int;
  v_seed2 int;
  v_created int := 0;
  v_match uuid;
begin
  while v_size < p_seeds loop
    v_size := v_size * 2;
    v_k := v_k + 1;
  end loop;
  v_order := private.seed_order(v_size);
  v_losers_rounds := 2 * (v_k - 1);

  insert into public.matches
    (tournament_id, event_id, stage, side, pool, round, position, label, round_key, wave, queue_seq)
  values
    (p_event.tournament_id, p_event.id, 'bracket', 'final', 0, 1, 1, 'Grand Final', 'grand_final',
     p_wave_offset + 2 * v_k, private.default_queue_seq(p_event.id, p_wave_offset + 2 * v_k, 0, 1))
  returning id into v_final;
  v_created := 1;
  if p_event.grand_final_reset then
    insert into public.matches
      (tournament_id, event_id, stage, side, pool, round, position, label, round_key, wave, queue_seq)
    values
      (p_event.tournament_id, p_event.id, 'bracket', 'final', 0, 2, 1, 'Grand Final (if needed)', 'grand_final',
       p_wave_offset + 2 * v_k + 1, private.default_queue_seq(p_event.id, p_wave_offset + 2 * v_k + 1, 0, 1));
    v_created := v_created + 1;
  end if;

  -- Losers bracket, last round first. Odd rounds pair the survivors; even
  -- rounds meet the teams dropping from the winners bracket.
  for v_round in reverse v_losers_rounds .. 1 loop
    v_count := v_size >> ((v_round + 1) / 2 + 1);
    for v_position in 1 .. v_count loop
      if v_round = v_losers_rounds then
        v_target := v_final;
        v_slot := 2;
      elsif v_round % 2 = 1 then
        select id into v_target from public.matches
        where event_id = p_event.id and side = 'losers' and round = v_round + 1 and position = v_position;
        v_slot := 1;
      else
        select id into v_target from public.matches
        where event_id = p_event.id and side = 'losers' and round = v_round + 1 and position = (v_position + 1) / 2;
        v_slot := 2 - v_position % 2;
      end if;
      insert into public.matches
        (tournament_id, event_id, stage, side, pool, round, position, label, round_key,
         winner_to_match_id, winner_to_slot, wave, queue_seq)
      values
        (p_event.tournament_id, p_event.id, 'bracket', 'losers', 0, v_round, v_position,
         case when v_round = v_losers_rounds then 'Losers Final' else 'Losers R' || v_round || ' #' || v_position end,
         'losers', v_target, v_slot, p_wave_offset + v_round + 1,
         private.default_queue_seq(p_event.id, p_wave_offset + v_round + 1, 1, v_position));
      v_created := v_created + 1;
    end loop;
  end loop;

  -- Winners bracket, final first.
  for v_round in reverse v_k .. 1 loop
    v_count := v_size >> v_round;
    for v_position in 1 .. v_count loop
      if v_round = v_k then
        v_target := v_final;
        v_slot := 1;
      else
        select id into v_target from public.matches
        where event_id = p_event.id and side = 'main' and round = v_round + 1 and position = (v_position + 1) / 2;
        v_slot := 2 - v_position % 2;
      end if;

      if v_k = 1 then
        v_loser_target := v_final;
        v_loser_slot := 2;
      elsif v_round = 1 then
        select id into v_loser_target from public.matches
        where event_id = p_event.id and side = 'losers' and round = 1 and position = (v_position + 1) / 2;
        v_loser_slot := 2 - v_position % 2;
      else
        -- Drop into the even losers round, mirrored every other round so
        -- teams don't meet the same opponent again right away.
        select id into v_loser_target from public.matches
        where event_id = p_event.id and side = 'losers' and round = 2 * (v_round - 1)
          and position = case when v_round % 2 = 0 then v_count + 1 - v_position else v_position end;
        v_loser_slot := 2;
      end if;

      v_seed1 := null;
      v_seed2 := null;
      if v_round = 1 then
        v_seed1 := v_order[2 * v_position - 1];
        v_seed2 := v_order[2 * v_position];
      end if;

      insert into public.matches
        (tournament_id, event_id, stage, side, pool, round, position, label, round_key,
         team1_seed, team2_seed, team1_id, team2_id, team1_bye, team2_bye,
         winner_to_match_id, winner_to_slot, loser_to_match_id, loser_to_slot, wave, queue_seq)
      values
        (p_event.tournament_id, p_event.id, 'bracket', 'main', 0, v_round, v_position,
         case v_k - v_round
           when 0 then 'Winners Final'
           when 1 then 'Winners Semifinal ' || v_position
           else 'Winners R' || v_round || ' #' || v_position
         end,
         'winners',
         case when v_seed1 <= p_seeds then v_seed1 end, case when v_seed2 <= p_seeds then v_seed2 end,
         p_teams[v_seed1], p_teams[v_seed2],
         coalesce(v_seed1 > p_seeds, false), coalesce(v_seed2 > p_seeds, false),
         v_target, v_slot, v_loser_target, v_loser_slot,
         p_wave_offset + 2 * v_round - 1,
         private.default_queue_seq(p_event.id, p_wave_offset + 2 * v_round - 1, 0, v_position))
      returning id into v_match;
      v_created := v_created + 1;
    end loop;
  end loop;

  -- Byes against known teams resolve now; byes against seeds still to be
  -- decided resolve when the bracket is seeded.
  for v_match in
    select id from public.matches where event_id = p_event.id and side = 'main' and round = 1
  loop
    perform private.settle(v_match);
  end loop;
  return v_created;
end $$;

-- When pool play is over (every pool match played or cancelled), seeds the
-- bracket: every pool winner first (best record first), then every runner-up,
-- and so on, avoiding same-pool first-round matchups where possible. With
-- confirm_seeds the bracket waits for start_bracket.
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

  select array_agg(s.team_id order by s.pool_rank, s.win_pct desc, s.point_diff desc, s.points_for desc, s.pool),
         array_agg(s.pool order by s.pool_rank, s.win_pct desc, s.point_diff desc, s.points_for desc, s.pool)
  into v_teams, v_pools
  from public.standings s
  where s.event_id = p_event and s.pool_rank <= e.advance_per_pool;
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

-- Builds the event's matches from its teams (in seed order) and adds them to
-- the queue. Returns the number of matches created.
create or replace function public.generate_matches(p_event uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_teams uuid[];
  v_count int;
  v_created int;
  v_pool_rounds int;
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
    if e.bracket_type = 'double' then
      v_created := private.build_double_elim(e, v_count, v_teams, 0);
    else
      v_created := private.build_bracket(e, v_count, v_teams, 0);
    end if;
    if e.confirm_seeds then
      update public.matches set on_hold = true where event_id = p_event;
    end if;
  else
    if v_count < 2 * e.pool_count then
      raise exception '% pools need at least % teams', e.pool_count, 2 * e.pool_count using errcode = '22023';
    end if;
    v_created := private.generate_pools(e, v_teams);
    if e.format = 'pools_to_bracket' then
      if e.advance_per_pool > v_count / e.pool_count then
        raise exception 'Can''t advance % per pool: the smallest pool has % teams',
          e.advance_per_pool, v_count / e.pool_count using errcode = '22023';
      end if;
      if e.pool_count * e.advance_per_pool < 2 then
        raise exception 'At least 2 teams must advance to the bracket' using errcode = '22023';
      end if;
      select max(round) into v_pool_rounds from public.matches where event_id = p_event;
      if e.bracket_type = 'double' then
        v_created := v_created + private.build_double_elim(e, e.pool_count * e.advance_per_pool, null, v_pool_rounds);
      else
        v_created := v_created + private.build_bracket(e, e.pool_count * e.advance_per_pool, null, v_pool_rounds);
      end if;
    end if;
  end if;

  perform private.auto_assign(e.tournament_id);
  return v_created;
end $$;

-- Director: fix the score of a finished match. If that changes the winner,
-- the teams swap places in the next matches (winner's and, in double
-- elimination, loser's), as long as those haven't gone on a court.
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
    if m.stage = 'pool' and exists (
      select 1 from public.events where id = m.event_id and playoffs_seeded_at is not null
    ) then
      raise exception 'Playoffs were already seeded from these results' using errcode = '55000';
    end if;
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
  perform private.auto_assign(m.tournament_id);
  return m;
end $$;

-- ---------------------------------------------------------------------------
-- API: running the stages
-- ---------------------------------------------------------------------------

-- Director: end pool play now. Pool matches not yet on a court are cancelled
-- (standings use the matches played); matches on court finish normally, and
-- the bracket is seeded once they do. Returns how many were cancelled.
create function public.end_pool_play(p_event uuid) returns int
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

  update public.matches
  set status = 'cancelled', on_hold = false
  where event_id = p_event and stage = 'pool' and status in ('waiting', 'queued');
  get diagnostics v_cancelled = row_count;
  perform private.seed_playoffs_when_pools_done(p_event);
  perform private.auto_assign(e.tournament_id);
  return v_cancelled;
end $$;

-- Director: release a bracket held for seed review (confirm_seeds).
create function public.start_bracket(p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  update public.matches set on_hold = false where event_id = p_event and stage = 'bracket';
  perform private.auto_assign(e.tournament_id);
end $$;

-- Director: swap two teams' places in the bracket (manual seeding). Neither
-- team may have played a bracket match yet.
create function public.swap_bracket_teams(p_event uuid, p_team_a uuid, p_team_b uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  if p_team_a = p_team_b then
    return;
  end if;
  if exists (
    select 1 from public.matches
    where event_id = p_event and stage = 'bracket' and not is_bye
      and status in ('assigned', 'in_progress', 'completed')
      and (team1_id in (p_team_a, p_team_b) or team2_id in (p_team_a, p_team_b))
  ) then
    raise exception 'One of these teams has already played in the bracket' using errcode = '55000';
  end if;
  if (select count(*) from public.matches
      where event_id = p_event and stage = 'bracket' and status in ('waiting', 'queued')
        and (team1_id in (p_team_a, p_team_b) or team2_id in (p_team_a, p_team_b))) = 0 then
    raise exception 'Those teams aren''t placed in the bracket yet' using errcode = '55000';
  end if;

  update public.matches
  set team1_id = case team1_id when p_team_a then p_team_b when p_team_b then p_team_a else team1_id end,
      team2_id = case team2_id when p_team_a then p_team_b when p_team_b then p_team_a else team2_id end
  where event_id = p_event and stage = 'bracket' and status in ('waiting', 'queued');
  -- Byes already played out carried a team forward: swap those records too.
  update public.matches
  set winner_team_id = case winner_team_id when p_team_a then p_team_b when p_team_b then p_team_a end,
      team1_id = case team1_id when p_team_a then p_team_b when p_team_b then p_team_a else team1_id end,
      team2_id = case team2_id when p_team_a then p_team_b when p_team_b then p_team_a else team2_id end
  where event_id = p_event and stage = 'bracket' and is_bye
    and (team1_id in (p_team_a, p_team_b) or team2_id in (p_team_a, p_team_b));
  perform private.auto_assign(e.tournament_id);
end $$;

-- The match behind a score link, with its format.
create or replace function public.get_match_by_code(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(md) || jsonb_build_object('tournament_name', t.name)
  from public.matches m
  join public.match_details md on md.id = m.id
  join public.tournaments t on t.id = m.tournament_id
  where m.report_code = p_code
$$;

-- Twilio delivery reports, recorded by the server's status webhook.
create function public.record_delivery_status(p_provider_id text, p_status text, p_error text default null)
returns jsonb
language sql security definer set search_path = '' as $$
  update public.notifications
  set delivery_status = p_status,
      error = coalesce(p_error, error)
  where provider_id = p_provider_id
  returning jsonb_build_object('id', id)
$$;

create or replace function public.finish_notification(
  p_id bigint, p_channel text, p_to text, p_sent_body text, p_error text
) returns jsonb
language sql security definer set search_path = '' as $$
  update public.notifications
  set sent_at = case when p_error is null then now() end, channel = p_channel,
      to_phone = case when via = 'sms' then p_to end,
      to_email = case when via = 'email' then p_to end,
      sent_body = p_sent_body, error = p_error
  where id = p_id
  returning jsonb_build_object('id', id)
$$;

-- The sender stores the provider's message id so delivery reports match up.
create function public.set_notification_provider_id(p_id bigint, p_provider_id text) returns jsonb
language sql security definer set search_path = '' as $$
  update public.notifications set provider_id = p_provider_id, delivery_status = 'sent'
  where id = p_id
  returning jsonb_build_object('id', id)
$$;

revoke execute on function public.record_delivery_status(text, text, text) from public, anon, authenticated;
revoke execute on function public.set_notification_provider_id(bigint, text) from public, anon, authenticated;
grant execute on function public.record_delivery_status(text, text, text),
  public.set_notification_provider_id(bigint, text) to service_role;
