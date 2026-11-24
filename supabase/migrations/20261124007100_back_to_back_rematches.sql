-- Back-to-back rematches: in a double or triple round robin, a division can
-- play each meeting's repeats in a row (e.g. one game of pickleball, then
-- one of cornhole against the same team) instead of everyone once, then
-- everyone again. Rounds go 1st meeting, rematch, next opponent, rematch...
-- Sides still swap on each repeat. max_rounds still caps the total.

alter table public.events
  add column round_robin_back_to_back boolean not null default false;
grant update (round_robin_back_to_back) on public.events to authenticated;

-- As before (round_robin_times), with the repeats either after the whole
-- round robin or straight after each meeting.
create or replace function private.generate_pools(p_event public.events, p_teams uuid[]) returns int
language plpgsql set search_path = '' as $$
declare
  v_pools int := p_event.pool_count;
  v_times int := greatest(1, p_event.round_robin_times);
  v_pool int;
  v_ring uuid[];
  v_size int;
  v_base int;
  v_time int;
  v_cap int;
  v_round int;
  v_slot int;
  v_position int;
  v_swap boolean;
  v_a uuid;
  v_b uuid;
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
    v_cap := least((v_size - 1) * v_times, coalesce(p_event.max_rounds, (v_size - 1) * v_times));

    -- v_base is the round of the single round robin, v_time which meeting
    -- this is. Back to back: round = (base - 1) * times + time. Otherwise
    -- the whole round robin repeats: round = (time - 1) * (size - 1) + base.
    for v_base in 1 .. v_size - 1 loop
      for v_time in 1 .. v_times loop
        v_round := case when p_event.round_robin_back_to_back
                        then (v_base - 1) * v_times + v_time
                        else (v_time - 1) * (v_size - 1) + v_base end;
        continue when v_round > v_cap;
        -- Each repeat swaps the sides.
        v_swap := (v_time - 1) % 2 = 1;
        v_position := 0;
        for v_slot in 1 .. v_size / 2 loop
          v_a := v_ring[v_slot];
          v_b := v_ring[v_size + 1 - v_slot];
          if v_a is not null and v_b is not null then
            v_position := v_position + 1;
            insert into public.matches
              (tournament_id, event_id, stage, pool, round, position, label, round_key,
               team1_id, team2_id, wave, queue_seq)
            values
              (p_event.tournament_id, p_event.id, 'pool', v_pool, v_round, v_position,
               case when v_pools > 1 then 'Pool ' || chr(64 + v_pool) || ' · Round ' || v_round
                    else 'Round ' || v_round end,
               'pool',
               case when v_swap then v_b else v_a end,
               case when v_swap then v_a else v_b end,
               v_round, private.default_queue_seq(p_event.id, v_round, v_pool, v_position));
            v_created := v_created + 1;
          end if;
        end loop;
      end loop;
      -- Keep the first team fixed and rotate the rest one place.
      v_ring := v_ring[1:1] || v_ring[v_size:v_size] || v_ring[2:v_size - 1];
    end loop;
  end loop;
  return v_created;
end $$;

-- As before (round_robin_times), with back-to-back rematches played right
-- after each first meeting.
create or replace function public.place_team_in_pool(p_team uuid, p_pool int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  t public.teams;
  e public.events;
  v_round int;
  v_other uuid;
  v_others uuid[];
  v_time int;
  v_i int;
  v_n int;
  v_created int := 0;
begin
  select * into t from public.teams where id = p_team;
  if not found then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(t.tournament_id);
  perform private.lock_tournament(t.tournament_id);
  select * into e from public.events where id = t.event_id;
  if e.format = 'single_elim' or not exists (select 1 from public.matches where event_id = e.id and stage = 'pool') then
    raise exception 'This division has no pool play under way' using errcode = '22023';
  end if;
  if e.finalized_at is not null or e.pools_finalized_at is not null then
    raise exception 'Pool play is final. Reset the bracket first.' using errcode = '55000';
  end if;
  if t.withdrawn_at is not null then
    raise exception '% was dropped. Put them back first.', t.name using errcode = '55000';
  end if;
  if p_pool is null or p_pool < 1 or p_pool > e.pool_count then
    raise exception 'That pool doesn’t exist' using errcode = '22023';
  end if;
  if t.pool = p_pool then
    raise exception '% is already in that pool', t.name using errcode = '22023';
  end if;
  if exists (select 1 from public.matches m where p_team in (m.team1_id, m.team2_id) and private.was_played(m)) then
    raise exception '% has already played, so they can’t move', t.name using errcode = '55000';
  end if;
  if t.pool is not null and (select count(*) from public.teams x
      where x.event_id = e.id and x.pool = t.pool and x.withdrawn_at is null and x.id <> p_team) < 2 then
    raise exception 'That would leave their pool with one team' using errcode = '55000';
  end if;

  delete from public.matches where p_team in (team1_id, team2_id);
  update public.teams
  set pool = p_pool, no_show_at = null, arrived_at = coalesce(arrived_at, private.clock())
  where id = p_team;

  if e.pool_play <> 'swiss' then
    select coalesce(max(round), 0) into v_round from public.matches where event_id = e.id and stage = 'pool' and pool = p_pool;
    v_others := array(
      select id from public.teams
      where event_id = e.id and pool = p_pool and withdrawn_at is null and id <> p_team
      order by seed nulls last, created_at, id
    );
    v_n := cardinality(v_others);
    -- Each (opponent, time) pair once: back to back runs the times for one
    -- opponent in a row; otherwise every opponent once, then again.
    for v_i in 0 .. v_n * e.round_robin_times - 1 loop
      if e.round_robin_back_to_back then
        v_other := v_others[v_i / e.round_robin_times + 1];
        v_time := v_i % e.round_robin_times + 1;
      else
        v_other := v_others[v_i % v_n + 1];
        v_time := v_i / v_n + 1;
      end if;
      v_round := v_round + 1;
      insert into public.matches
        (tournament_id, event_id, stage, pool, round, position, label, round_key, team1_id, team2_id, wave, queue_seq)
      values
        (e.tournament_id, e.id, 'pool', p_pool, v_round, 1,
         case when e.pool_count > 1 then 'Pool ' || chr(64 + p_pool) || ' · Round ' || v_round else 'Round ' || v_round end,
         'pool',
         case when v_time % 2 = 1 then p_team else v_other end,
         case when v_time % 2 = 1 then v_other else p_team end,
         v_round, private.default_queue_seq(e.id, v_round, p_pool, 1));
      v_created := v_created + 1;
    end loop;
  end if;
  perform private.auto_assign(e.tournament_id);
  return v_created;
end $$;
