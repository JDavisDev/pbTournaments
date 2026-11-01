-- Unwinding. Scores get entered wrong, people get hurt, drop out or show up
-- late, seeds change. Directors can back out of each of those; players still
-- only report scores and watch.
--
-- The rule: anything can be unwound until a later match has been played on
-- top of it. A bracket can be reset until its second round has started. After
-- that the bracket stands, but scores and winners stay correctable for the
-- record (results, medals and DUPR).

-- First check-in, or a director excusing the team; never cleared. The check-in
-- deadline only applies before this, so checking a team out later (gone to
-- lunch, missing from a court call, a substitute on the way) doesn't forfeit it.
alter table public.teams
  add column arrived_at timestamptz,
  -- The alternate that took this team's place (replace_team), to undo it.
  add column replaced_by_team_id uuid references public.teams (id) on delete set null,
  -- Players substituted off this team, so subbing them back keeps their DUPR details.
  add column past_player_ids uuid[] not null default '{}';
update public.teams set arrived_at = checked_in_at where checked_in_at is not null;

-- Swiss rounds planned before pool play was ended early (resume_pool_play).
alter table public.events add column rounds_before_end int;

create function private.teams_arrived() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.arrived_at := coalesce(new.arrived_at, new.checked_in_at);
  return new;
end $$;
create trigger teams_arrived
before insert or update of checked_in_at on public.teams
for each row when (new.checked_in_at is not null)
execute function private.teams_arrived();

-- ---------------------------------------------------------------------------
-- Unwinding results
-- ---------------------------------------------------------------------------

-- Played, or on a court now. Byes and forfeits that never reached a court
-- aren't: they settled by themselves and can settle again.
create function private.was_played(m public.matches) returns boolean
language sql immutable set search_path = '' as $$
  select m.status in ('assigned', 'in_progress')
         or (m.status = 'completed' and not m.is_bye and not (m.forfeit and m.games is null and m.started_at is null))
$$;

-- The first match played on top of this one's result (its label), or null.
create function private.started_after(p_match uuid) returns text
language plpgsql stable set search_path = '' as $$
declare
  m public.matches;
  n public.matches;
  v_label text;
begin
  select * into m from public.matches where id = p_match;
  for n in
    select * from public.matches x
    where x.id in (m.winner_to_match_id, m.loser_to_match_id)
       or (m.round_key = 'grand_final' and m.round = 1 and x.event_id = m.event_id
           and x.round_key = 'grand_final' and x.round = 2)
  loop
    if private.was_played(n) then
      return n.label;
    end if;
    if n.status = 'completed' then
      v_label := private.started_after(n.id);
      if v_label is not null then
        return v_label;
      end if;
    end if;
  end loop;
  if m.stage = 'pool' and exists (select 1 from public.events e where e.id = m.event_id and e.pool_play = 'swiss') then
    select x.label into v_label from public.matches x
    where x.event_id = m.event_id and x.stage = 'pool' and x.round > m.round and private.was_played(x)
    limit 1;
  end if;
  return v_label;
end $$;

-- Takes the team out of a match slot, along with anything that settled from
-- it. Callers check started_after first.
create function private.retract_slot(p_match uuid, p_slot smallint) returns void
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.matches where id = p_match and status = 'completed') then
    perform private.clear_result(p_match);
  end if;
  update public.matches
  set team1_id = case when p_slot = 1 then null else team1_id end,
      team1_bye = case when p_slot = 1 then false else team1_bye end,
      team2_id = case when p_slot = 2 then null else team2_id end,
      team2_bye = case when p_slot = 2 then false else team2_bye end,
      status = case when status = 'queued' then 'waiting' else status end
  where id = p_match;
end $$;

-- A finished or cancelled match, unplayed again, with its teams taken back out
-- of later matches. Callers check started_after first.
create function private.clear_result(p_match uuid) returns void
language plpgsql set search_path = '' as $$
declare
  m public.matches;
begin
  select * into m from public.matches where id = p_match;
  if m.winner_to_match_id is not null then
    perform private.retract_slot(m.winner_to_match_id, m.winner_to_slot);
  end if;
  if m.loser_to_match_id is not null then
    perform private.retract_slot(m.loser_to_match_id, m.loser_to_slot);
  end if;
  if m.round_key = 'grand_final' and m.round = 1 then
    update public.matches set team1_id = null, team2_id = null, status = 'waiting'
    where event_id = m.event_id and round_key = 'grand_final' and round = 2;
  end if;
  update public.matches
  set status = 'waiting', winner_team_id = null, games = null, forfeit = false, is_bye = false,
      completed_at = null, started_at = null, assigned_at = null, court_id = null, dupr_exported_at = null
  where id = p_match;
end $$;

-- Swiss: a result changed under a later round no one has played. That round is
-- drawn again from the new standings (now, or when this round finishes).
create function private.redraw_swiss(p_event uuid, p_round int) returns void
language plpgsql set search_path = '' as $$
declare
  e public.events;
begin
  select * into e from public.events where id = p_event;
  if e.pool_play <> 'swiss' or e.pools_finalized_at is not null or exists (
    select 1 from public.matches m
    where m.event_id = p_event and m.stage = 'pool' and m.round > p_round and private.was_played(m)
  ) then
    return;
  end if;
  delete from public.matches where event_id = p_event and stage = 'pool' and round > p_round;
  perform private.next_swiss_round(p_event);
end $$;

-- Changes a finished match's result. A new winner moves through the bracket
-- while nothing has been played on top of the old one; once something has, the
-- bracket stands and this is for the record. A corrected match goes to DUPR again.
create function private.change_result(m public.matches, p_winner uuid, p_games jsonb, p_forfeit boolean)
returns public.matches
language plpgsql set search_path = '' as $$
declare
  v_loser uuid := case when p_winner = m.team1_id then m.team2_id else m.team1_id end;
begin
  if p_winner is distinct from m.winner_team_id and private.started_after(m.id) is null then
    if m.winner_to_match_id is not null then
      perform private.retract_slot(m.winner_to_match_id, m.winner_to_slot);
      perform private.advance(m.winner_to_match_id, m.winner_to_slot, p_winner, false);
    end if;
    if m.loser_to_match_id is not null then
      perform private.retract_slot(m.loser_to_match_id, m.loser_to_slot);
      perform private.advance(m.loser_to_match_id, m.loser_to_slot, v_loser, false);
    end if;
    -- The reset final is only played when the losers-bracket team (team 2) wins.
    if m.round_key = 'grand_final' and m.round = 1 then
      if p_winner = m.team2_id then
        update public.matches set team1_id = m.team1_id, team2_id = m.team2_id, status = 'waiting'
        where event_id = m.event_id and round_key = 'grand_final' and round = 2;
      else
        update public.matches set team1_id = null, team2_id = null, status = 'cancelled'
        where event_id = m.event_id and round_key = 'grand_final' and round = 2;
      end if;
    end if;
  end if;

  update public.matches
  set games = p_games, winner_team_id = p_winner, forfeit = p_forfeit, dupr_exported_at = null
  where id = m.id
  returning * into m;
  if m.stage = 'pool' then
    perform private.redraw_swiss(m.event_id, m.round);
  end if;
  return m;
end $$;

-- ---------------------------------------------------------------------------
-- Brackets
-- ---------------------------------------------------------------------------

-- As before (finalize_pool_play), not counting forfeits that never reached a court.
create or replace function private.bracket_started(p_event uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.matches m
    where m.event_id = p_event and m.stage = 'bracket' and private.was_played(m)
  )
$$;

-- Whether anything past the bracket's first played round has been played.
create function private.bracket_past_first_round(p_event uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.matches m
    where m.event_id = p_event and m.stage = 'bracket' and private.was_played(m)
      and m.wave > (select min(f.wave) from public.matches f
                    where f.event_id = p_event and f.stage = 'bracket'
                      and not f.is_bye and not f.team1_bye and not f.team2_bye)
  )
$$;

-- Tells the players on court that their match won't count. Not tied to the
-- match, which is about to be deleted (its texts go with it).
create function private.notify_called_off(p_event uuid) returns void
language sql set search_path = '' as $$
  insert into public.notifications (tournament_id, player_id, kind, body)
  select m.tournament_id, tp.player_id, 'match_called_off',
         'Your match on ' || upper(c.name) || ' has been called off. Please wait for a new text before you play.'
  from public.matches m
  join public.courts c on c.id = m.court_id
  join public.team_players tp on tp.team_id in (m.team1_id, m.team2_id)
  where m.event_id = p_event and m.status in ('assigned', 'in_progress')
$$;

-- Back to pool play's review: pools aren't final and the bracket is unseeded.
create function private.unseed_bracket(p_event uuid) returns void
language plpgsql set search_path = '' as $$
declare
  e public.events;
begin
  delete from public.matches where event_id = p_event and stage = 'bracket';
  update public.events set pools_finalized_at = null, playoffs_seeded_at = null
  where id = p_event returning * into e;
  perform private.build_playoffs(e, private.bracket_seeds(e), null,
    case when e.pool_play = 'swiss' then e.max_rounds
         else (select max(round) from public.matches where event_id = p_event and stage = 'pool') end);
end $$;

-- Director: start the bracket over, until its second round has started.
-- Results and matches on court in the first round are discarded. After pools,
-- the division goes back to reviewing pool play. A bracket-only division is
-- rebuilt from the current seeds and held. Returns how many matches were discarded.
create function public.reset_bracket(p_event uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_discarded int;
  v_teams uuid[];
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  if e.finalized_at is not null then
    raise exception 'This division’s results are final. Reopen it to change them.' using errcode = '55000';
  end if;
  if e.format = 'round_robin' or not exists (select 1 from public.matches where event_id = p_event and stage = 'bracket') then
    raise exception 'This division has no bracket to reset' using errcode = '22023';
  end if;
  if e.format = 'pools_to_bracket' and e.pools_finalized_at is null then
    raise exception 'The bracket hasn’t been seeded yet' using errcode = '55000';
  end if;
  if private.bracket_past_first_round(p_event) then
    raise exception 'The second round has started, so the bracket stands. Scores can still be corrected.' using errcode = '55000';
  end if;

  select count(*) into v_discarded from public.matches m
  where m.event_id = p_event and m.stage = 'bracket' and private.was_played(m);
  perform private.notify_called_off(p_event);
  if e.format = 'pools_to_bracket' then
    perform private.unseed_bracket(p_event);
  else
    delete from public.matches where event_id = p_event and stage = 'bracket';
    v_teams := array(
      select id from public.teams
      where event_id = p_event and withdrawn_at is null
      order by seed nulls last, created_at, id
    );
    if cardinality(v_teams) < 2 then
      raise exception 'An event needs at least 2 teams' using errcode = '22023';
    end if;
    perform private.build_playoffs(e, cardinality(v_teams), v_teams, 0);
    update public.matches set on_hold = true where event_id = p_event;
  end if;
  perform private.auto_assign(e.tournament_id);
  return v_discarded;
end $$;

-- ---------------------------------------------------------------------------
-- Scores
-- ---------------------------------------------------------------------------

-- A pool result changed after seeding: seeds again while no bracket match has been played.
create function private.after_result_change(m public.matches) returns void
language plpgsql set search_path = '' as $$
begin
  if m.stage = 'pool'
     and exists (select 1 from public.events where id = m.event_id and playoffs_seeded_at is not null)
     and not private.bracket_started(m.event_id) then
    perform private.reseed_bracket(m.event_id);
  end if;
  perform private.auto_assign(m.tournament_id);
end $$;

-- Director: fix a finished match's score, at any time before the division is
-- final. See change_result for what a new winner does.
create or replace function public.correct_score(p_match uuid, p_games jsonb) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  if m.status <> 'completed' or m.is_bye then
    raise exception 'Only finished matches can be corrected' using errcode = '55000';
  end if;
  m := private.change_result(m, private.score_winner(m, p_games), p_games, false);
  perform private.after_result_change(m);
  return m;
end $$;

-- Director: award a match to p_winner_team without a score. A finished match
-- can be changed to a forfeit too, or its forfeit given to the other team.
create or replace function public.forfeit_match(p_match uuid, p_winner_team uuid) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  if m.status not in ('queued', 'assigned', 'in_progress', 'completed') or m.is_bye then
    raise exception 'Only a queued, live or finished match can be forfeited' using errcode = '55000';
  end if;
  if p_winner_team is null or p_winner_team not in (m.team1_id, m.team2_id) then
    raise exception 'The winner must be one of the match''s two teams' using errcode = '22023';
  end if;
  if m.status = 'completed' then
    m := private.change_result(m, p_winner_team, null, true);
    perform private.after_result_change(m);
    return m;
  end if;
  perform private.finish_match(p_match, p_winner_team, null, true);
  perform private.auto_assign(m.tournament_id);
  select * into m from public.matches where id = p_match;
  return m;
end $$;

-- Director: undo a result (or restore a cancelled pool match). The match goes
-- back in the queue to be played, unless something's been played on top of it.
create function public.reopen_match(p_match uuid) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  e public.events;
  v_out text;
  v_after text;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  select * into e from public.events where id = m.event_id;
  if m.is_bye or not (m.status = 'completed' or (m.status = 'cancelled' and m.stage = 'pool')) then
    raise exception 'Only a finished or cancelled match can go back in the queue' using errcode = '55000';
  end if;
  select name into v_out from public.teams
  where id in (m.team1_id, m.team2_id) and (withdrawn_at is not null or no_show_at is not null)
  limit 1;
  if v_out is not null then
    raise exception '% is out of this division. Put them back first.', v_out using errcode = '55000';
  end if;
  if m.stage = 'pool' and e.pools_finalized_at is not null then
    if private.bracket_started(m.event_id) then
      raise exception 'The bracket is under way. Reset the bracket first, or correct the score instead.' using errcode = '55000';
    end if;
    perform private.unseed_bracket(m.event_id);
  end if;
  v_after := private.started_after(p_match);
  if v_after is not null then
    raise exception 'The next match (%) has already started. Correct the score instead.', v_after using errcode = '55000';
  end if;

  perform private.clear_result(p_match);
  if m.stage = 'pool' then
    perform private.redraw_swiss(m.event_id, m.round);
  end if;
  perform private.auto_assign(m.tournament_id);
  select * into m from public.matches where id = p_match;
  return m;
end $$;

-- As before (staff_and_registration). With p_hold the match stays off courts
-- until a director releases it; otherwise it can be called again straight away
-- if a court is free. Holding it first lets a director fix what feeds it.
drop function public.requeue_match(uuid, uuid);
create function public.requeue_match(p_match uuid, p_absent_team uuid default null, p_hold boolean default false)
returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.lock_match(p_match);
  perform private.require_monitor(m.tournament_id);
  if m.status not in ('assigned', 'in_progress') then
    raise exception 'This match is not on a court' using errcode = '55000';
  end if;
  if p_absent_team is not null and p_absent_team not in (m.team1_id, m.team2_id) then
    raise exception 'The absent team must be one of the match''s two teams' using errcode = '22023';
  end if;
  update public.matches
  set status = 'queued', court_id = null, assigned_at = null, started_at = null, on_hold = p_hold
  where id = p_match;
  if p_absent_team is not null then
    perform private.set_team_checked_in(m.tournament_id, p_absent_team, false);
  end if;
  perform private.auto_assign(m.tournament_id);
  select * into m from public.matches where id = p_match;
  return m;
end $$;

-- ---------------------------------------------------------------------------
-- Round robin and Swiss: changing pool play once it's under way
-- ---------------------------------------------------------------------------

-- Director: take an unplayed pool match off the schedule (reopen_match restores it).
create function public.cancel_match(p_match uuid) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.lock_match(p_match);
  perform private.require_staff(m.tournament_id);
  if m.stage <> 'pool' then
    raise exception 'Bracket matches can’t be cancelled: forfeit it instead' using errcode = '22023';
  end if;
  if m.status not in ('waiting', 'queued') then
    raise exception 'Only a match still in the queue can be cancelled' using errcode = '55000';
  end if;
  update public.matches set status = 'cancelled', on_hold = false where id = p_match returning * into m;
  perform private.next_swiss_round(m.event_id);
  perform private.auto_assign(m.tournament_id);
  return m;
end $$;

-- As before (division_formats), remembering the Swiss rounds that were planned.
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
    set rounds_before_end = coalesce(rounds_before_end, max_rounds),
        max_rounds = (select coalesce(max(round), 0) from public.matches where event_id = p_event and stage = 'pool')
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

-- Director: undo end_pool_play. Cancelled matches go back in the queue and
-- Swiss rounds carry on. Returns how many matches came back.
create function public.resume_pool_play(p_event uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_match uuid;
  v_restored int := 0;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  if e.finalized_at is not null then
    raise exception 'This division’s results are final. Reopen it to change them.' using errcode = '55000';
  end if;
  if e.pools_finalized_at is not null then
    raise exception 'Pool play is final. Reset the bracket first.' using errcode = '55000';
  end if;
  if not exists (select 1 from public.matches where event_id = p_event and stage = 'pool' and status = 'cancelled')
     and e.rounds_before_end is null then
    raise exception 'Pool play wasn’t ended early' using errcode = '55000';
  end if;
  for v_match in
    select m.id from public.matches m
    where m.event_id = p_event and m.stage = 'pool' and m.status = 'cancelled'
      and not exists (select 1 from public.teams t
                      where t.id in (m.team1_id, m.team2_id) and (t.withdrawn_at is not null or t.no_show_at is not null))
  loop
    perform private.clear_result(v_match);
    v_restored := v_restored + 1;
  end loop;
  update public.events set max_rounds = coalesce(rounds_before_end, max_rounds), rounds_before_end = null where id = p_event;
  perform private.next_swiss_round(p_event);
  perform private.auto_assign(e.tournament_id);
  return v_restored;
end $$;

-- Director: put a team in a pool once pool play is under way: an alternate or
-- late entry, or a team moving pools that hasn't played yet. It gets a match
-- against each team there, after what's already scheduled. In Swiss it joins
-- the next draw. Returns how many matches were added.
create function public.place_team_in_pool(p_team uuid, p_pool int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  t public.teams;
  e public.events;
  v_round int;
  v_other uuid;
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
         'pool', p_team, v_other, v_round, private.default_queue_seq(e.id, v_round, p_pool, 1));
      v_created := v_created + 1;
    end loop;
  end if;
  perform private.auto_assign(e.tournament_id);
  return v_created;
end $$;

-- Director: two teams trade places in pool play, schedule and all. Neither
-- may have a result yet.
create function public.swap_pool_teams(p_event uuid, p_team_a uuid, p_team_b uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_pool_a int;
  v_pool_b int;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  if p_team_a = p_team_b then
    return;
  end if;
  select pool into v_pool_a from public.teams where id = p_team_a and event_id = p_event;
  select pool into v_pool_b from public.teams where id = p_team_b and event_id = p_event;
  if v_pool_a is null or v_pool_b is null then
    raise exception 'Both teams need a place in pool play' using errcode = '22023';
  end if;
  if e.pools_finalized_at is not null then
    raise exception 'Pool play is final. Reset the bracket first.' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.matches
    where event_id = p_event and stage = 'pool' and status in ('assigned', 'in_progress', 'completed')
      and (team1_id in (p_team_a, p_team_b) or team2_id in (p_team_a, p_team_b))
  ) then
    raise exception 'One of these teams has already played or is on a court' using errcode = '55000';
  end if;
  update public.matches
  set team1_id = case team1_id when p_team_a then p_team_b when p_team_b then p_team_a else team1_id end,
      team2_id = case team2_id when p_team_a then p_team_b when p_team_b then p_team_a else team2_id end
  where event_id = p_event and stage = 'pool'
    and (team1_id in (p_team_a, p_team_b) or team2_id in (p_team_a, p_team_b));
  update public.teams set pool = v_pool_b where id = p_team_a;
  update public.teams set pool = v_pool_a where id = p_team_b;
  perform private.auto_assign(e.tournament_id);
end $$;

-- Director: move a team to a place in its division's seed order; the others
-- shift around it. Used whenever the schedule or a bracket is next built.
create function public.set_team_seed(p_team uuid, p_seed int) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.teams;
  v_ids uuid[];
  v_place int;
begin
  select * into t from public.teams where id = p_team;
  if not found then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(t.tournament_id);
  perform private.lock_tournament(t.tournament_id);
  v_ids := array(
    select id from public.teams
    where event_id = t.event_id and id <> p_team
    order by seed nulls last, created_at, id
  );
  v_place := greatest(1, least(coalesce(p_seed, 1), cardinality(v_ids) + 1));
  v_ids := v_ids[1:v_place - 1] || array[p_team] || v_ids[v_place:];
  update public.teams x set seed = o.n from unnest(v_ids) with ordinality o(id, n) where x.id = o.id;
end $$;

-- As before (division_start), and a division can be un-started: nothing's been
-- played, so matches on court are called off and the schedule goes. Forfeits
-- for missing check-in go with it. It's built again from the teams at the next start.
create or replace function public.clear_matches(p_event uuid) returns void
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
  if exists (
    select 1 from public.matches m
    where m.event_id = p_event and m.status = 'completed' and private.was_played(m)
  ) then
    raise exception 'Matches in this event have already been played' using errcode = '55000';
  end if;
  perform private.notify_called_off(p_event);
  delete from public.matches where event_id = p_event;
  update public.teams set pool = null, no_show_at = null where event_id = p_event;
  update public.events
  set playoffs_seeded_at = null, pools_finalized_at = null, started_at = null,
      max_rounds = coalesce(rounds_before_end, max_rounds), rounds_before_end = null
  where id = p_event;
  perform private.auto_assign(e.tournament_id);
end $$;

-- ---------------------------------------------------------------------------
-- People: late, hurt, dropped
-- ---------------------------------------------------------------------------

-- As before (division_start), only for a team that has never arrived and is
-- on the schedule. Alternates have no matches to forfeit.
create or replace function private.forfeit_no_shows(p_tournament uuid) returns void
language plpgsql set search_path = '' as $$
declare
  v_team uuid;
  v_match uuid;
begin
  for v_team in
    select tm.id
    from public.teams tm
    join public.events e on e.id = tm.event_id
    join public.tournaments t on t.id = e.tournament_id
    where tm.tournament_id = p_tournament and tm.checked_in_at is null and tm.withdrawn_at is null
      and tm.arrived_at is null
      and tm.no_show_at is null and e.started_at is not null and t.checkin_grace_minutes is not null
      and e.started_at + make_interval(mins => t.checkin_grace_minutes) <= private.clock()
      and exists (select 1 from public.matches m where tm.id in (m.team1_id, m.team2_id))
  loop
    update public.teams set no_show_at = private.clock() where id = v_team;
    for v_match in
      select id from public.matches
      where v_team in (team1_id, team2_id) and status in ('waiting', 'queued')
      order by wave, queue_seq
    loop
      perform private.settle(v_match);
    end loop;
  end loop;
end $$;

-- A team back in play gets back the matches it forfeited by leaving (since
-- p_since), unless something's been played on top of them, pool play is final
-- or the opponent has gone too. Those stand.
create function private.restore_forfeits(p_team uuid, p_since timestamptz) returns void
language plpgsql set search_path = '' as $$
declare
  t public.teams;
  e public.events;
  m public.matches;
begin
  select * into t from public.teams where id = p_team;
  select * into e from public.events where id = t.event_id;
  if t.withdrawn_at is not null or t.no_show_at is not null or e.finalized_at is not null then
    return;
  end if;
  for m in
    select * from public.matches x
    where p_team in (x.team1_id, x.team2_id) and x.status = 'completed' and x.forfeit and not x.is_bye
      and x.games is null and x.winner_team_id is distinct from p_team and x.completed_at >= p_since
    order by x.wave desc, x.queue_seq desc
  loop
    continue when m.stage = 'pool' and e.pools_finalized_at is not null;
    continue when private.started_after(m.id) is not null;
    continue when exists (select 1 from public.teams o where o.id in (m.team1_id, m.team2_id)
                            and (o.withdrawn_at is not null or o.no_show_at is not null));
    perform private.clear_result(m.id);
    if m.stage = 'pool' then
      perform private.redraw_swiss(m.event_id, m.round);
    end if;
  end loop;
end $$;

-- Covers every way back: a late check-in clearing no_show_at, and reinstate_team.
create function private.teams_restore_matches() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.restore_forfeits(new.id, least(old.withdrawn_at, old.no_show_at));
  return null;
end $$;
create trigger teams_restore_matches
after update on public.teams
for each row when ((old.withdrawn_at is not null and new.withdrawn_at is null)
                   or (old.no_show_at is not null and new.no_show_at is null))
execute function private.teams_restore_matches();

-- Director: bring back a team that was dropped, replaced or marked a no-show.
-- It's excused from the check-in deadline, and gets back the matches it can
-- (restore_forfeits). Undoing a replacement moves the alternate's unplayed
-- matches back, as long as the alternate hasn't started. Returns how many
-- forfeits were undone.
create function public.reinstate_team(p_team uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  t public.teams;
  v_sub public.teams;
  v_before int;
  v_after int;
  v_player uuid;
begin
  select * into t from public.teams where id = p_team;
  if not found then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(t.tournament_id);
  perform private.lock_tournament(t.tournament_id);
  if t.withdrawn_at is null and t.no_show_at is null then
    return 0;
  end if;

  if t.replaced_by_team_id is not null then
    select * into v_sub from public.teams where id = t.replaced_by_team_id;
    if exists (select 1 from public.matches where v_sub.id in (team1_id, team2_id)
               and status in ('assigned', 'in_progress', 'completed')) then
      raise exception '% has already started in their place', v_sub.name using errcode = '55000';
    end if;
    update public.matches set team1_id = p_team where team1_id = v_sub.id;
    update public.matches set team2_id = p_team where team2_id = v_sub.id;
    update public.teams set pool = null where id = v_sub.id;
  end if;

  select count(*) into v_before from public.matches
  where p_team in (team1_id, team2_id) and status = 'completed' and forfeit;
  update public.teams
  set withdrawn_at = null, no_show_at = null, replaced_by_team_id = null,
      arrived_at = coalesce(arrived_at, private.clock())
  where id = p_team;
  select count(*) into v_after from public.matches
  where p_team in (team1_id, team2_id) and status = 'completed' and forfeit;

  -- Dropping checked the team out; players who are still checked in count again.
  for v_player in select player_id from public.team_players where team_id = p_team loop
    perform private.sync_team_checkins(t.tournament_id, v_player);
  end loop;
  perform private.auto_assign(t.tournament_id);
  return v_before - v_after;
end $$;

-- As before (called_is_playing). Remembers who it replaced, and the alternate
-- isn't held to a check-in deadline that passed before it was called on.
create or replace function public.replace_team(p_old_team uuid, p_new_team uuid) returns public.teams
language plpgsql security definer set search_path = '' as $$
declare
  old_t public.teams;
  new_t public.teams;
  v_match uuid;
begin
  select * into old_t from public.teams where id = p_old_team;
  select * into new_t from public.teams where id = p_new_team;
  if old_t.id is null or new_t.id is null then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(old_t.tournament_id);
  perform private.lock_tournament(old_t.tournament_id);
  if old_t.event_id <> new_t.event_id then
    raise exception 'The replacement must be entered in the same event' using errcode = '22023';
  end if;
  if new_t.withdrawn_at is not null
     or exists (select 1 from public.matches where p_new_team in (team1_id, team2_id)) then
    raise exception '% already has matches. Choose an unscheduled alternate.', new_t.name using errcode = '55000';
  end if;

  update public.teams
  set pool = old_t.pool, seed = coalesce(old_t.seed, seed), no_show_at = null,
      arrived_at = coalesce(arrived_at, private.clock())
  where id = p_new_team;
  update public.matches set team1_id = p_new_team
  where team1_id = p_old_team and status in ('waiting', 'queued', 'in_progress');
  update public.matches set team2_id = p_new_team
  where team2_id = p_old_team and status in ('waiting', 'queued', 'in_progress');
  update public.teams
  set withdrawn_at = private.clock(), checked_in_at = null, replaced_by_team_id = p_new_team
  where id = p_old_team;

  for v_match in
    select id from public.matches where p_new_team in (team1_id, team2_id) and status = 'in_progress'
  loop
    perform private.notify_match_players(v_match, 'court_assigned');
  end loop;
  perform private.auto_assign(old_t.tournament_id);

  select * into new_t from public.teams where id = p_new_team;
  return new_t;
end $$;

-- As before (desk_tools). Subbing a player back on (same name) brings back
-- their own record, with their DUPR details, instead of a new one.
create or replace function public.substitute_player(
  p_team uuid, p_old_player uuid, p_first_name text, p_last_name text, p_phone text default null,
  p_email text default null
) returns public.teams
language plpgsql security definer set search_path = '' as $$
declare
  t public.teams;
  v_old public.players;
  v_new uuid;
begin
  select * into t from public.teams where id = p_team;
  if not found then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(t.tournament_id);
  perform private.lock_tournament(t.tournament_id);
  select p.* into v_old from public.players p
  join public.team_players tp on tp.player_id = p.id and tp.team_id = p_team
  where p.id = p_old_player;
  if v_old.id is null then
    raise exception 'That player isn''t on this team' using errcode = '22023';
  end if;
  if coalesce(trim(p_last_name), '') = '' then
    raise exception 'Enter the new player''s name' using errcode = '22023';
  end if;

  select p.id into v_new from public.players p
  where p.id = any (t.past_player_ids)
    and lower(p.last_name) = lower(trim(p_last_name))
    and lower(p.first_name) = lower(coalesce(nullif(trim(p_first_name), ''), '-'))
  limit 1;
  if v_new is null then
    insert into public.players (first_name, last_name, phone, email, sms_opt_in, added_by)
    values (coalesce(nullif(trim(p_first_name), ''), '-'), trim(p_last_name), nullif(trim(p_phone), ''),
            lower(nullif(trim(p_email), '')), nullif(trim(p_phone), '') is not null, auth.uid())
    returning id into v_new;
  end if;
  update public.team_players set player_id = v_new where team_id = p_team and player_id = p_old_player;
  update public.teams
  set name = replace(name, v_old.last_name, trim(p_last_name)),
      past_player_ids = array_append(array_remove(past_player_ids, v_new), p_old_player)
  where id = p_team;
  perform private.sync_team_checkins(t.tournament_id, v_new);

  select * into t from public.teams where id = p_team;
  return t;
end $$;

-- The Players page offers to bring back no-shows and shows who was replaced.
create or replace view public.team_roster with (security_invoker = true) as
select t.id as team_id,
       t.tournament_id,
       t.event_id,
       e.name as event_name,
       e.sort_order as event_sort_order,
       t.name,
       t.seed,
       t.pool,
       t.checked_in_at,
       t.withdrawn_at,
       (select count(*) from public.matches m where t.id in (m.team1_id, m.team2_id))::int as match_count,
       coalesce(jsonb_agg(jsonb_build_object(
                  'player_id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
                  'phone', p.phone, 'email', p.email, 'sms_opt_in', p.sms_opt_in,
                  'checked_in', pc.player_id is not null,
                  'dupr_id', p.dupr_id, 'dupr_doubles', p.dupr_doubles, 'dupr_singles', p.dupr_singles,
                  'self_rating', p.self_rating, 'rating_checked_at', p.rating_checked_at
                ) order by p.last_name) filter (where p.id is not null), '[]'::jsonb) as players,
       t.no_show_at,
       t.replaced_by_team_id
from public.teams t
join public.events e on e.id = t.event_id
left join public.team_players tp on tp.team_id = t.id
left join public.players p on p.id = tp.player_id
left join public.player_checkins pc on pc.tournament_id = t.tournament_id and pc.player_id = p.id
group by t.id, e.name, e.sort_order;

-- ---------------------------------------------------------------------------
-- Swiss draws and players
-- ---------------------------------------------------------------------------

-- As before (division_formats), leaving out no-shows: paired in a later round
-- they'd never check in, and their match would hold up the whole division.
create or replace function private.pair_swiss_round(p_event public.events, p_round int) returns int
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
  v_teams := array(
    select s.team_id from public.standings s
    join public.teams t on t.id = s.team_id
    where s.event_id = p_event.id and t.no_show_at is null
    order by s.pool_rank
  );
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


-- As before (partner_pay_and_questions). Once a division has started, leaving
-- it forfeits matches for the partner and opponents too: that's the desk's call.
create or replace function public.withdraw_registration(p_registration uuid, p_event uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
  t public.tournaments;
  me public.players;
  payer public.registrations;
  e record;
  v_by text;
  v_counted int;
  v_left int;
  v_credit int;
  v_cover_credit int;
  v_total int := 0;
  v_names text[] := '{}';
begin
  select * into r from public.registrations where id = p_registration;
  if not found then
    raise exception 'Registration not found' using errcode = 'P0002';
  end if;
  perform private.lock_tournament(r.tournament_id);
  select * into r from public.registrations where id = p_registration for update;
  select * into t from public.tournaments where id = r.tournament_id;
  select * into me from public.players where id = r.player_id;
  if t.status = 'complete' then
    raise exception '% is over', t.name using errcode = '55000';
  end if;
  if p_event is not null and not exists (
    select 1 from public.registration_entries where registration_id = r.id and event_id = p_event
  ) then
    raise exception 'That event isn''t part of this registration' using errcode = 'P0002';
  end if;
  v_by := case when public.is_tournament_staff(t.id) then 'director' else 'player' end;
  if v_by = 'player' and exists (
    select 1 from public.registration_entries re
    join public.events ev on ev.id = re.event_id
    where re.registration_id = r.id and (p_event is null or re.event_id = p_event) and ev.started_at is not null
  ) then
    raise exception 'Your division has started. Please see the desk to withdraw.' using errcode = '55000';
  end if;

  for e in
    select re.*, ev.name as event_name, tm.name as team_name
    from public.registration_entries re
    join public.events ev on ev.id = re.event_id
    left join public.teams tm on tm.id = re.team_id
    where re.registration_id = r.id and (p_event is null or re.event_id = p_event)
    order by ev.sort_order
  loop
    v_credit := 0;
    v_cover_credit := 0;
    if r.status = 'paid' and not e.waitlisted then
      if e.paid_by_registration_id is not null then
        -- Their partner paid this entry: the partner gets it back.
        select * into payer from public.registrations where id = e.paid_by_registration_id;
        v_cover_credit := e.paid_by_cents;
        if v_cover_credit > 0 and payer.id is not null then
          insert into public.ledger_entries (tournament_id, player_id, registration_id, event_id, kind, amount_cents, note, created_at)
          values (t.id, payer.player_id, payer.id, e.event_id, 'withdrawal', -v_cover_credit,
                  me.first_name || ' ' || me.last_name || ' withdrew from ' || e.event_name || ' (you paid their entry)',
                  private.clock());
        end if;
      else
        select count(*) into v_counted from public.registration_entries where registration_id = r.id and not waitlisted;
        -- What this player paid for their own events and hasn't had credited.
        v_left := r.amount_cents
                  - (select coalesce(sum(partner_paid_cents), 0) from public.registration_entries where registration_id = r.id)
                  - (select coalesce(sum(partner_paid_cents + credit_cents), 0) from public.registration_withdrawals
                     where registration_id = r.id);
        v_credit := greatest(0, case when v_counted <= 1 then v_left else least(private.extra_event_fee(r), v_left) end);
        if v_credit > 0 then
          insert into public.ledger_entries (tournament_id, player_id, registration_id, event_id, kind, amount_cents, note, created_at)
          values (t.id, r.player_id, r.id, e.event_id, 'withdrawal', -v_credit, 'Withdrew from ' || e.event_name, private.clock());
        end if;
        -- Paid for a partner who hasn't registered: that comes back too.
        if private.cover_unclaimed(e.registration_id, e.event_id, e.partner_paid_cents) then
          v_cover_credit := e.partner_paid_cents;
          insert into public.ledger_entries (tournament_id, player_id, registration_id, event_id, kind, amount_cents, note, created_at)
          values (t.id, r.player_id, r.id, e.event_id, 'withdrawal', -v_cover_credit,
                  'Partner’s entry in ' || e.event_name || ', not used', private.clock());
          v_total := v_total + v_cover_credit;
        end if;
      end if;
    end if;

    if e.team_id is not null then
      if exists (select 1 from public.matches where e.team_id in (team1_id, team2_id)) then
        perform private.drop_team(e.team_id);
      else
        -- No schedule yet: the partner's entry loses its team and can be paired again.
        delete from public.teams where id = e.team_id;
      end if;
    end if;

    insert into public.registration_withdrawals (registration_id, event_id, event_name, partner_name, team_name,
                                                 was_waitlisted, withdrawn_by, credit_cents, withdrawn_at,
                                                 partner_paid_cents, cover_credit_cents)
    values (r.id, e.event_id, e.event_name, e.partner_name, e.team_name, e.waitlisted, v_by, v_credit, private.clock(),
            e.partner_paid_cents, v_cover_credit);
    delete from public.registration_entries where registration_id = r.id and event_id = e.event_id;
    v_total := v_total + v_credit;
    v_names := v_names || e.event_name;
  end loop;

  if not exists (select 1 from public.registration_entries where registration_id = r.id) then
    -- Out of the tournament: no longer counts toward its player limit.
    update public.registrations set status = 'cancelled' where id = r.id;
  elsif r.status = 'pending' then
    -- Not paid yet: it now costs less.
    update public.registrations set amount_cents = private.registration_amount(r.id) where id = r.id;
  end if;

  insert into public.notifications (tournament_id, player_id, kind, via, subject, body)
  values (t.id, r.player_id, 'withdrawal', 'email', 'You’ve withdrawn from ' || t.name,
          'You’ve withdrawn from ' || array_to_string(v_names, ', ') || ' at ' || t.name || '.'
          || case when v_total > 0
                  then ' $' || to_char(v_total / 100.0, 'FM999990.00')
                       || ' of what you paid is credited to you. Any refund follows the tournament’s refund policy.'
                  else '' end);

  return jsonb_build_object('credit_cents', v_total, 'withdrawn', to_jsonb(v_names));
end $$;
