-- Running a real day: scores from paper sheets, merging divisions that came up
-- short, and players checking themselves in at the door.

-- ---------------------------------------------------------------------------
-- Scores from paper
-- ---------------------------------------------------------------------------

-- As before (staff_and_registration), and staff can enter a score for a match
-- still in the queue: when play ran on paper, it never went on a court here.
create or replace function public.report_score(p_match uuid, p_games jsonb) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  v_staff boolean;
begin
  m := private.lock_match(p_match);
  v_staff := public.is_court_monitor(m.tournament_id);
  if not (v_staff or private.plays_in_match(p_match)) then
    raise exception 'Only players in this match or tournament staff can report its score' using errcode = '42501';
  end if;
  if not (m.status in ('assigned', 'in_progress') or (v_staff and m.status = 'queued')) then
    raise exception 'This match is not on a court, so it can''t be scored' using errcode = '55000';
  end if;
  perform private.finish_match(p_match, private.score_winner(m, p_games), p_games, false);
  perform private.auto_assign(m.tournament_id);
  select * into m from public.matches where id = p_match;
  return m;
end $$;

-- ---------------------------------------------------------------------------
-- Merging divisions
-- ---------------------------------------------------------------------------

-- A merged division's settings, to bring it back. Ids stay the same.
create table public.event_merges (
  source_event_id uuid primary key,
  into_event_id uuid not null references public.events (id) on delete cascade,
  source_name text not null,
  snapshot jsonb not null,
  ledger_entry_ids bigint[] not null default '{}',
  created_at timestamptz not null default now()
);
create index on public.event_merges (into_event_id);
alter table public.event_merges enable row level security;
grant select (source_event_id, into_event_id, source_name, created_at) on public.event_merges to authenticated;
create policy "Staff see merges" on public.event_merges for select to authenticated
  using (exists (select 1 from public.events e where e.id = into_event_id and public.is_tournament_staff(e.tournament_id)));

-- Which merged division a team or entry came from, to send it back.
alter table public.teams add column merged_from_event_id uuid;
alter table public.registration_entries add column merged_from_event_id uuid;

create function private.notify_division_change(p_event uuid, p_source uuid, p_text text) returns void
language sql set search_path = '' as $$
  insert into public.notifications (tournament_id, player_id, kind, via, subject, body)
  select distinct on (r.player_id) r.tournament_id, r.player_id, 'division_merged', 'email', 'Your division has changed', p_text
  from public.registration_entries re
  join public.registrations r on r.id = re.registration_id
  where re.event_id = p_event and re.merged_from_event_id = p_source
$$;

-- Director: move a division's teams and entries into another, and take the
-- division away. Before either has a schedule. Returns how many teams moved.
create function public.merge_events(p_from uuid, p_into uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  src public.events;
  dst public.events;
  v_moved int;
  v_name text;
  v_ledger bigint[];
begin
  select * into src from public.events where id = p_from;
  select * into dst from public.events where id = p_into;
  if src.id is null or dst.id is null then
    raise exception 'Division not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(src.tournament_id);
  perform private.lock_tournament(src.tournament_id);
  if src.tournament_id <> dst.tournament_id or p_from = p_into then
    raise exception 'Choose another division in this tournament' using errcode = '22023';
  end if;
  if src.kind <> dst.kind then
    raise exception 'Singles and doubles can’t be merged' using errcode = '22023';
  end if;
  if src.started_at is not null or dst.started_at is not null
     or exists (select 1 from public.matches where event_id in (p_from, p_into)) then
    raise exception 'Clear the schedule first: a division with a schedule can’t be merged' using errcode = '55000';
  end if;
  if exists (select 1 from public.event_merges where into_event_id = p_from) then
    raise exception 'Unmerge the divisions in % first', src.name using errcode = '55000';
  end if;
  select p.first_name || ' ' || p.last_name into v_name
  from public.registration_entries a
  join public.registration_entries b on b.registration_id = a.registration_id
  join public.registrations r on r.id = a.registration_id
  join public.players p on p.id = r.player_id
  where a.event_id = p_from and b.event_id = p_into
  limit 1;
  if v_name is null then
    select p.first_name || ' ' || p.last_name into v_name
    from public.team_players a
    join public.teams ta on ta.id = a.team_id and ta.event_id = p_from
    join public.team_players b on b.player_id = a.player_id
    join public.teams tb on tb.id = b.team_id and tb.event_id = p_into
    join public.players p on p.id = a.player_id
    limit 1;
  end if;
  if v_name is not null then
    raise exception '% is entered in both divisions. Withdraw them from one first.', v_name using errcode = '55000';
  end if;

  -- Seeded after the division's own teams, in their own order.
  with ranked as (
    select t.id, row_number() over (order by t.seed nulls last, t.created_at, t.id) as n
    from public.teams t where t.event_id = p_from
  )
  update public.teams t
  set event_id = p_into, merged_from_event_id = p_from,
      seed = r.n + (select coalesce(max(x.seed), 0) from public.teams x where x.event_id = p_into)
  from ranked r where r.id = t.id;
  get diagnostics v_moved = row_count;
  update public.registration_entries set event_id = p_into, merged_from_event_id = p_from where event_id = p_from;
  update public.registration_withdrawals set event_id = p_into where event_id = p_from;
  select coalesce(array_agg(id), '{}') into v_ledger from public.ledger_entries where event_id = p_from;
  update public.ledger_entries set event_id = p_into where event_id = p_from;

  perform private.notify_division_change(p_into, p_from,
    src.name || ' has been merged into ' || dst.name || '. You’re now entered in ' || dst.name || '.');
  insert into public.event_merges (source_event_id, into_event_id, source_name, snapshot, ledger_entry_ids)
  values (p_from, p_into, src.name, to_jsonb(src), v_ledger);
  delete from public.events where id = p_from;
  return v_moved;
end $$;

-- Director: undo a merge, while the division it went into has no schedule.
create function public.unmerge_event(p_source uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  mg public.event_merges;
  dst public.events;
begin
  select * into mg from public.event_merges where source_event_id = p_source;
  if not found then
    raise exception 'That merge isn’t there anymore' using errcode = 'P0002';
  end if;
  select * into dst from public.events where id = mg.into_event_id;
  perform private.require_staff(dst.tournament_id);
  perform private.lock_tournament(dst.tournament_id);
  if dst.started_at is not null or exists (select 1 from public.matches where event_id = dst.id) then
    raise exception 'Clear % first: it has a schedule', dst.name using errcode = '55000';
  end if;

  insert into public.events select * from jsonb_populate_record(null::public.events, mg.snapshot);
  -- Teams paired since the merge go with their entries.
  update public.teams t
  set event_id = p_source, merged_from_event_id = null
  where t.event_id = dst.id
    and (t.merged_from_event_id = p_source or exists (
      select 1 from public.registration_entries re where re.team_id = t.id and re.merged_from_event_id = p_source));
  update public.registration_entries set event_id = p_source
  where event_id = dst.id and merged_from_event_id = p_source;
  update public.ledger_entries set event_id = p_source where id = any (mg.ledger_entry_ids);
  perform private.notify_division_change(p_source, p_source,
    mg.source_name || ' is its own division again. You’re entered in ' || mg.source_name || '.');
  update public.registration_entries set merged_from_event_id = null where event_id = p_source;
  delete from public.event_merges where source_event_id = p_source;
end $$;

-- ---------------------------------------------------------------------------
-- Self check-in
-- ---------------------------------------------------------------------------

-- The link is the permission, so its code can't sit on the public tournaments table.
create table private.self_checkin (
  tournament_id uuid primary key references public.tournaments (id) on delete cascade,
  code text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
);

-- Staff: the tournament's self check-in code, or null when it's off.
create function public.get_self_checkin(p_tournament uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_monitor(p_tournament);
  return (select code from private.self_checkin where tournament_id = p_tournament);
end $$;

-- Staff: turn self check-in on or off. Off and on again makes a new link.
create function public.set_self_checkin(p_tournament uuid, p_on boolean) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_monitor(p_tournament);
  if not p_on then
    delete from private.self_checkin where tournament_id = p_tournament;
    return null;
  end if;
  insert into private.self_checkin (tournament_id) values (p_tournament) on conflict do nothing;
  return (select code from private.self_checkin where tournament_id = p_tournament);
end $$;

create function private.self_checkin_tournament(p_code text) returns uuid
language sql stable set search_path = '' as $$
  select s.tournament_id
  from private.self_checkin s join public.tournaments t on t.id = s.tournament_id
  where s.code = p_code and t.status in ('registration', 'live')
$$;

-- Anyone with the link: the tournament's name, or null if the link is off.
create function public.self_checkin_info(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('tournament_name', t.name)
  from public.tournaments t where t.id = private.self_checkin_tournament(p_code)
$$;

-- Anyone with the link: players matching a name (at least 2 letters), with no
-- contact details. Team names are public anyway.
create function public.self_checkin_search(p_code text, p_query text)
returns table (player_id uuid, first_name text, last_name text, teams text[], checked_in boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.first_name, p.last_name,
         array_agg(e.name || ': ' || tm.name order by e.sort_order),
         exists (select 1 from public.player_checkins pc where pc.tournament_id = tm.tournament_id and pc.player_id = p.id)
  from public.teams tm
  join public.events e on e.id = tm.event_id
  join public.team_players tp on tp.team_id = tm.id
  join public.players p on p.id = tp.player_id
  where tm.tournament_id = private.self_checkin_tournament(p_code)
    and tm.withdrawn_at is null
    and length(trim(p_query)) >= 2
    and strpos(lower(p.first_name || ' ' || p.last_name), lower(trim(p_query))) > 0
  group by p.id, tm.tournament_id
  order by p.last_name, p.first_name
  limit 15
$$;

-- Anyone with the link: check a player on this tournament's teams in, or undo it.
create function public.self_check_in(p_code text, p_player uuid, p_checked_in boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_tournament uuid := private.self_checkin_tournament(p_code);
begin
  if v_tournament is null then
    raise exception 'Self check-in isn’t on right now. Please see the desk.' using errcode = '55000';
  end if;
  perform private.lock_tournament(v_tournament);
  if not exists (
    select 1 from public.team_players tp join public.teams tm on tm.id = tp.team_id
    where tp.player_id = p_player and tm.tournament_id = v_tournament and tm.withdrawn_at is null
  ) then
    raise exception 'That player isn’t entered here. Please see the desk.' using errcode = 'P0002';
  end if;
  perform private.set_player_checked_in(v_tournament, p_player, p_checked_in);
  perform private.auto_assign(v_tournament);
end $$;
