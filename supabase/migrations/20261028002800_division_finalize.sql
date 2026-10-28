-- Finalizing a division: once every match is played, a director reviews the
-- results and marks them final. Final results are locked (reopen to change
-- them) and only final divisions go to DUPR.

alter table public.events add column finalized_at timestamptz;

-- Scores, winners and line-ups can't change in a final division. Marking
-- matches as sent to DUPR still works.
create function private.matches_locked_when_final() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.games, new.winner_team_id, new.status, new.forfeit, new.team1_id, new.team2_id)
       is distinct from (old.games, old.winner_team_id, old.status, old.forfeit, old.team1_id, old.team2_id)
     and exists (select 1 from public.events where id = old.event_id and finalized_at is not null) then
    raise exception 'This division’s results are final. Reopen it to change them.' using errcode = '55000';
  end if;
  return new;
end $$;

create trigger matches_locked_when_final
before update on public.matches
for each row execute function private.matches_locked_when_final();

-- Director: mark a finished division's results final.
create function public.finalize_event(p_event uuid) returns public.events
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_left int;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);
  if e.finalized_at is not null then
    raise exception 'This division is already final' using errcode = '55000';
  end if;
  if e.started_at is null then
    raise exception 'This division hasn’t started' using errcode = '55000';
  end if;
  select count(*) into v_left from public.matches
  where event_id = p_event and not is_bye and status in ('waiting', 'queued', 'assigned', 'in_progress');
  if v_left > 0 then
    raise exception 'Finish every match first: % left', v_left using errcode = '55000';
  end if;
  update public.events set finalized_at = now() where id = p_event returning * into e;
  return e;
end $$;

-- Director: reopen a final division to fix a result.
create function public.reopen_event(p_event uuid) returns public.events
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  update public.events set finalized_at = null where id = p_event returning * into e;
  return e;
end $$;

-- As before; a copy isn't final.
create or replace function public.copy_event(p_event uuid) returns public.events
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  copy public.events;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  -- Every column carries over, including ones added later, except these.
  copy := jsonb_populate_record(null::public.events, to_jsonb(e) || jsonb_build_object(
    'id', gen_random_uuid(),
    'name', left(e.name || ' (copy)', 200),
    'sort_order', null,
    'playoffs_seeded_at', null,
    'started_at', null,
    'finalized_at', null,
    'created_at', now()
  ));
  insert into public.events select copy.* returning * into copy;
  return copy;
end $$;

-- dupr_results: only final divisions. Otherwise as before.
create or replace function public.dupr_results(p_tournament uuid)
returns table (
  match_id uuid, event_id uuid, event_name text, label text, completed_at timestamptz,
  match_type text, event text, date text,
  player_a1 text, player_a1_dupr_id text, player_a2 text, player_a2_dupr_id text,
  player_b1 text, player_b1_dupr_id text, player_b2 text, player_b2_dupr_id text,
  games jsonb, location text, score_type text, missing_ids text[], exported_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff(p_tournament);
  return query
  with sides as (
    select m.id, s.slot,
           array_agg(p.first_name || ' ' || p.last_name order by p.last_name, p.first_name) as names,
           array_agg(upper(p.dupr_id) order by p.last_name, p.first_name) as ids
    from public.matches m
    cross join lateral (values (1, m.team1_id), (2, m.team2_id)) as s(slot, team_id)
    join public.team_players tp on tp.team_id = s.team_id
    join public.players p on p.id = tp.player_id
    where m.tournament_id = p_tournament and m.status = 'completed' and not m.forfeit and not m.is_bye
    group by m.id, s.slot
  )
  select m.id, e.id, e.name, m.label, m.completed_at,
         case when e.kind = 'singles' then 'S' else 'D' end,
         t.name || ' - ' || e.name,
         to_char(m.completed_at at time zone t.time_zone, 'YYYY-MM-DD'),
         a.names[1], a.ids[1], a.names[2], a.ids[2],
         b.names[1], b.ids[1], b.names[2], b.ids[2],
         m.games, t.location, t.dupr_score_type,
         array(select n from unnest(a.names || b.names, a.ids || b.ids) as x(n, i) where i is null),
         m.dupr_exported_at
  from public.matches m
  join public.tournaments t on t.id = m.tournament_id
  join public.events e on e.id = m.event_id and e.dupr_rated and e.finalized_at is not null
  join sides a on a.id = m.id and a.slot = 1
  join sides b on b.id = m.id and b.slot = 2
  order by e.sort_order, m.completed_at;
end $$;
