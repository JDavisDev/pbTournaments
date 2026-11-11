-- Double and triple round robins: teams in a pool play each other
-- events.round_robin_times times (1, 2 or 3). The round robin repeats with
-- team 1 and team 2 swapped on each repeat, so every team plays everyone once
-- before anyone plays the same opponent again. max_rounds still caps the total
-- rounds. A bracket afterward works as before: it's built after the last pool
-- round. Swiss rounds ignore this.

alter table public.events
  add column round_robin_times int not null default 1 check (round_robin_times between 1 and 3);
grant update (round_robin_times) on public.events to authenticated;

-- As before (brackets), repeating the round robin round_robin_times times.
create or replace function private.generate_pools(p_event public.events, p_teams uuid[]) returns int
language plpgsql set search_path = '' as $$
declare
  v_pools int := p_event.pool_count;
  v_pool int;
  v_ring uuid[];
  v_size int;
  v_rounds int;
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
    v_rounds := (v_size - 1) * p_event.round_robin_times;

    for v_round in 1 .. least(v_rounds, coalesce(p_event.max_rounds, v_rounds)) loop
      -- The ring comes back to the start every v_size - 1 rounds; each repeat
      -- swaps the sides.
      v_swap := ((v_round - 1) / (v_size - 1)) % 2 = 1;
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
      -- Keep the first team fixed and rotate the rest one place.
      v_ring := v_ring[1:1] || v_ring[v_size:v_size] || v_ring[2:v_size - 1];
    end loop;
  end loop;
  return v_created;
end $$;

-- As before (unwinding), with round_robin_times matches against each team in
-- the pool: everyone once, then everyone again.
create or replace function public.place_team_in_pool(p_team uuid, p_pool int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  t public.teams;
  e public.events;
  v_round int;
  v_other uuid;
  v_time int;
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
    for v_time in 1 .. e.round_robin_times loop
      for v_other in
        select id from public.teams
        where event_id = e.id and pool = p_pool and withdrawn_at is null and id <> p_team
        order by seed nulls last, created_at, id
      loop
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
    end loop;
  end if;
  perform private.auto_assign(e.tournament_id);
  return v_created;
end $$;
