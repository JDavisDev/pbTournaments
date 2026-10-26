-- Sharing a tournament with other people, and registration controls:
--  * Staff roles: admins (everything) and court monitors (see the courts and
--    queue, enter scores, check players in, send a no-show back). Invite by
--    email; people without an account get it when they sign up.
--  * Tournament: max players, registration close date, waiver, one image,
--    and start times that stay hidden from players until published.
--  * Waitlist: entries into a full division (or a full tournament) wait
--    unpaid; an admin offers the spot and the player gets a pay link.
--  * Discount codes.

-- ---------------------------------------------------------------------------
-- Staff roles and invites
-- ---------------------------------------------------------------------------

alter table public.tournament_staff
  add column role text not null default 'admin' check (role in ('admin', 'monitor'));

create table public.tournament_invites (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  email text not null,
  role text not null default 'admin' check (role in ('admin', 'monitor')),
  invited_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (tournament_id, email)
);
alter table public.tournament_invites enable row level security;

-- Admins: the organization's members, people added as admin for this
-- tournament, and anyone signed in on a practice tournament.
create or replace function public.is_tournament_staff(p_tournament uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tournament_staff s
    where s.tournament_id = p_tournament and s.user_id = auth.uid() and s.role = 'admin'
  ) or exists (
    select 1 from public.tournaments t
    join public.organization_members om on om.organization_id = t.organization_id
    where t.id = p_tournament and om.user_id = auth.uid()
  ) or (
    auth.uid() is not null
    and exists (select 1 from public.tournaments t where t.id = p_tournament and t.is_demo)
  )
$$;

-- Admins and court monitors.
create function public.is_court_monitor(p_tournament uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_tournament_staff(p_tournament) or exists (
    select 1 from public.tournament_staff s
    where s.tournament_id = p_tournament and s.user_id = auth.uid() and s.role = 'monitor'
  )
$$;

create function private.require_monitor(p_tournament uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if not public.is_court_monitor(p_tournament) then
    raise exception 'Only this tournament''s staff can do this' using errcode = '42501';
  end if;
end $$;

-- 'admin', 'monitor' or null, for the screens.
create function public.my_tournament_role(p_tournament uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when public.is_tournament_staff(p_tournament) then 'admin'
              when public.is_court_monitor(p_tournament) then 'monitor' end
$$;

-- Monitors see who's entered and checked in (names and phones), like the desk.
create policy "Court monitors see players" on public.players for select to authenticated
  using (exists (
    select 1 from public.team_players tp join public.teams t on t.id = tp.team_id
    where tp.player_id = players.id and public.is_court_monitor(t.tournament_id)
  ));
create policy "Court monitors see check-ins" on public.player_checkins for select to authenticated
  using (public.is_court_monitor(tournament_id));

-- Admin: add an admin or court monitor by email. If they don't have an
-- account yet, they're invited and get access when they sign up and open the
-- site. Adding someone again changes their role. Returns 'added' or 'invited'.
create function public.add_tournament_staff(p_tournament uuid, p_email text, p_role text default 'admin')
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_user uuid;
begin
  perform private.require_staff(p_tournament);
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if p_role not in ('admin', 'monitor') then
    raise exception 'Role must be admin or monitor' using errcode = '22023';
  end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is null then
    insert into public.tournament_invites (tournament_id, email, role) values (p_tournament, v_email, p_role)
    on conflict (tournament_id, email) do update set role = excluded.role;
    return 'invited';
  end if;
  insert into public.tournament_staff (tournament_id, user_id, role) values (p_tournament, v_user, p_role)
  on conflict (tournament_id, user_id) do update set role = excluded.role;
  delete from public.tournament_invites where tournament_id = p_tournament and email = v_email;
  return 'added';
end $$;

-- Admin: remove someone added to this tournament (or their invite).
-- Organization members are managed with the organization.
create function public.remove_tournament_staff(p_tournament uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
begin
  perform private.require_staff(p_tournament);
  delete from public.tournament_staff s
  using auth.users u
  where s.tournament_id = p_tournament and u.id = s.user_id and lower(u.email) = v_email
    and s.user_id <> auth.uid();
  delete from public.tournament_invites where tournament_id = p_tournament and email = v_email;
end $$;

-- Admin: everyone who can run this tournament: organization members (always
-- admins), people added here, and open invites.
create function public.tournament_team(p_tournament uuid)
returns table (email text, role text, source text, is_me boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff(p_tournament);
  return query
  select u.email::text, 'admin'::text, 'organization'::text, u.id = auth.uid()
  from public.tournaments t
  join public.organization_members om on om.organization_id = t.organization_id
  join auth.users u on u.id = om.user_id
  where t.id = p_tournament
  union all
  select u.email::text, s.role, 'tournament'::text, u.id = auth.uid()
  from public.tournament_staff s join auth.users u on u.id = s.user_id
  where s.tournament_id = p_tournament
  union all
  select i.email, i.role, 'invite'::text, false
  from public.tournament_invites i where i.tournament_id = p_tournament;
end $$;

-- Signed-in user: turn invites sent to their email into access. The screens
-- call this after sign-in. Returns how many were claimed.
create function public.claim_staff_invites() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
  v_count int;
begin
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is null then
    return 0;
  end if;
  insert into public.tournament_staff (tournament_id, user_id, role)
  select i.tournament_id, auth.uid(), i.role from public.tournament_invites i where i.email = v_email
  on conflict (tournament_id, user_id) do update set role = excluded.role;
  get diagnostics v_count = row_count;
  delete from public.tournament_invites where email = v_email;
  return v_count;
end $$;

-- Court monitors can check players in, send a no-show back and enter scores.
create or replace function public.check_in_player(p_tournament uuid, p_player uuid, p_checked_in boolean default true)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_monitor(p_tournament);
  perform private.lock_tournament(p_tournament);
  perform private.set_player_checked_in(p_tournament, p_player, p_checked_in);
  perform private.auto_assign(p_tournament);
end $$;

create or replace function public.check_in_team(p_team uuid, p_checked_in boolean default true)
returns public.teams
language plpgsql security definer set search_path = '' as $$
declare
  v_tournament uuid;
  t public.teams;
begin
  select tournament_id into v_tournament from public.teams where id = p_team;
  if v_tournament is null then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_monitor(v_tournament);
  perform private.lock_tournament(v_tournament);
  perform private.set_team_checked_in(v_tournament, p_team, p_checked_in);
  perform private.auto_assign(v_tournament);
  select * into t from public.teams where id = p_team;
  return t;
end $$;

create or replace function public.report_score(p_match uuid, p_games jsonb) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.lock_match(p_match);
  if not (public.is_court_monitor(m.tournament_id) or private.plays_in_match(p_match)) then
    raise exception 'Only players in this match or tournament staff can report its score' using errcode = '42501';
  end if;
  if m.status not in ('assigned', 'in_progress') then
    raise exception 'This match is not on a court, so it can''t be scored' using errcode = '55000';
  end if;
  perform private.finish_match(p_match, private.score_winner(m, p_games), p_games, false);
  perform private.auto_assign(m.tournament_id);
  select * into m from public.matches where id = p_match;
  return m;
end $$;

create or replace function public.requeue_match(p_match uuid, p_absent_team uuid default null)
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
  set status = 'queued', court_id = null, assigned_at = null, started_at = null
  where id = p_match;
  if p_absent_team is not null then
    perform private.set_team_checked_in(m.tournament_id, p_absent_team, false);
  end if;
  perform private.auto_assign(m.tournament_id);
  select * into m from public.matches where id = p_match;
  return m;
end $$;

-- ---------------------------------------------------------------------------
-- Tournament registration settings
-- ---------------------------------------------------------------------------

alter table public.tournaments
  -- Players (not teams) across the tournament; more go on the waitlist.
  add column max_players int check (max_players > 0),
  add column registration_closes_at timestamptz,
  -- Shown at registration; players must agree to register.
  add column waiver_text text,
  -- One image (logo or banner) as a data URL, kept small by the browser.
  add column image_data text check (length(image_data) < 1500000),
  -- Division start times show to players only once published.
  add column times_published_at timestamptz;

grant update (max_players, registration_closes_at, waiver_text, image_data, times_published_at)
  on public.tournaments to authenticated;

alter table public.registrations
  add column discount_code text,
  add column discount_cents int not null default 0,
  add column waiver_accepted_at timestamptz;

alter table public.registration_entries
  add column waitlisted boolean not null default false,
  add column waitlisted_at timestamptz,
  -- When an admin offered a waitlisted player the spot.
  add column offered_at timestamptz;

-- ---------------------------------------------------------------------------
-- Discount codes
-- ---------------------------------------------------------------------------

create table public.discount_codes (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  code text not null check (code = upper(code) and code ~ '^[A-Z0-9_-]{2,30}$'),
  percent_off int check (percent_off between 1 and 100),
  amount_off_cents int check (amount_off_cents > 0),
  max_uses int check (max_uses > 0),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tournament_id, code),
  check ((percent_off is null) <> (amount_off_cents is null))
);
alter table public.discount_codes enable row level security;
create policy "Admins manage discount codes" on public.discount_codes for all to authenticated
  using (public.is_tournament_staff(tournament_id)) with check (public.is_tournament_staff(tournament_id));
grant select, insert, update, delete on public.discount_codes to authenticated;

-- How much a code takes off p_amount right now (0 with a reason if it can't be used).
create function private.discount_for(p_tournament uuid, p_code text, p_amount int)
returns table (code text, cents int, problem text)
language plpgsql stable set search_path = '' as $$
declare
  d public.discount_codes;
  v_used int;
begin
  select * into d from public.discount_codes
  where tournament_id = p_tournament and discount_codes.code = upper(trim(p_code));
  if not found then
    return query select null::text, 0, 'That code isn''t valid'::text;
    return;
  end if;
  if d.expires_at is not null and d.expires_at < private.clock() then
    return query select d.code, 0, 'That code has expired'::text;
    return;
  end if;
  if d.max_uses is not null then
    select count(*) into v_used from public.registrations r
    where r.tournament_id = p_tournament and r.discount_code = d.code
      and (r.status = 'paid' or (r.status = 'pending' and r.created_at > private.clock() - interval '30 minutes'));
    if v_used >= d.max_uses then
      return query select d.code, 0, 'That code has been used up'::text;
      return;
    end if;
  end if;
  return query select d.code,
    least(p_amount, coalesce(d.amount_off_cents, round(p_amount * d.percent_off / 100.0)::int)),
    null::text;
end $$;

-- Anyone registering: check a code against a price, for the form.
create function public.check_discount_code(p_tournament uuid, p_code text, p_amount_cents int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('code', code, 'cents', cents, 'problem', problem)
  from private.discount_for(p_tournament, p_code, p_amount_cents)
$$;

-- ---------------------------------------------------------------------------
-- Registration with waitlist, discount code, waiver and close date
-- ---------------------------------------------------------------------------

-- Spots taken in an event: paid entries plus unpaid ones from the last 30
-- minutes (checkout in progress), not counting the waitlist.
create function private.event_spots_taken(p_event uuid) returns int
language sql stable set search_path = '' as $$
  select count(*)::int
  from public.registration_entries re
  join public.registrations r on r.id = re.registration_id
  where re.event_id = p_event and not re.waitlisted
    and (r.status = 'paid' or (r.status = 'pending' and r.created_at > private.clock() - interval '30 minutes'))
$$;

create function private.tournament_players_taken(p_tournament uuid) returns int
language sql stable set search_path = '' as $$
  select count(distinct r.player_id)::int
  from public.registrations r
  where r.tournament_id = p_tournament
    and (r.status = 'paid' or (r.status = 'pending' and r.created_at > private.clock() - interval '30 minutes'))
$$;

--   p_player adds: discount_code, waiver_accepted (true).
-- Full events (or a full tournament) put the entry on the waitlist instead of
-- failing; waitlisted entries cost nothing until an admin offers the spot.
-- Returns {registration_id, amount_cents, status, waitlisted: [event names]}.
create or replace function public.start_registration(p_tournament uuid, p_player jsonb, p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
  v_first text := trim(p_player ->> 'first_name');
  v_last text := trim(p_player ->> 'last_name');
  v_email text := lower(trim(p_player ->> 'email'));
  v_gender text := nullif(p_player ->> 'gender', '');
  v_birth date := nullif(p_player ->> 'birth_date', '')::date;
  v_dupr_doubles numeric := nullif(p_player ->> 'dupr_doubles', '')::numeric;
  v_dupr_singles numeric := nullif(p_player ->> 'dupr_singles', '')::numeric;
  v_self numeric := nullif(p_player ->> 'self_rating', '')::numeric;
  v_dupr_id text := upper(nullif(trim(p_player ->> 'dupr_id'), ''));
  v_code text := nullif(trim(p_player ->> 'discount_code'), '');
  v_player uuid;
  v_registration uuid;
  v_count int;
  v_amount int;
  v_discount_code text;
  v_discount_cents int := 0;
  v_discount_problem text;
  v_problem text;
  v_tournament_full boolean;
  v_waitlisted uuid[] := '{}';
  v_waitlisted_names text[] := '{}';
  v_status public.registration_status;
  e record;
begin
  select * into t from public.tournaments where id = p_tournament;
  if not found then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  if t.status <> 'registration' then
    raise exception 'Registration for % is not open', t.name using errcode = '55000';
  end if;
  if t.registration_closes_at is not null and t.registration_closes_at < private.clock() then
    raise exception 'Registration for % closed on %', t.name,
      to_char(t.registration_closes_at at time zone t.time_zone, 'FMMonth FMDD') using errcode = '55000';
  end if;
  if coalesce(v_first, '') = '' or coalesce(v_last, '') = '' then
    raise exception 'Enter your first and last name' using errcode = '22023';
  end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if v_gender is not null and v_gender not in ('male', 'female') then
    raise exception 'Unknown gender' using errcode = '22023';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'Choose at least one event' using errcode = '22023';
  end if;
  if nullif(trim(t.waiver_text), '') is not null and not coalesce((p_player ->> 'waiver_accepted')::boolean, false) then
    raise exception 'Please read and agree to the waiver' using errcode = '22023';
  end if;
  if v_dupr_id is not null and v_dupr_id !~ '^[A-Z0-9]{4,12}$' then
    raise exception 'A DUPR ID is letters and numbers, like 7K2QXW' using errcode = '22023';
  end if;

  v_tournament_full := t.max_players is not null and private.tournament_players_taken(p_tournament) >= t.max_players;

  for e in
    select x.partner_name, x.partner_email, ev
    from jsonb_to_recordset(p_entries) as x(event_id uuid, partner_name text, partner_email text)
    left join public.events ev on ev.id = x.event_id and ev.tournament_id = p_tournament
  loop
    if (e.ev).id is null then
      raise exception 'That event isn''t part of this tournament' using errcode = '22023';
    end if;
    v_problem := private.entry_problem(e.ev, t, v_gender, v_birth, v_dupr_doubles, v_dupr_singles, v_self, v_dupr_id);
    if v_problem is not null then
      raise exception '% %', (e.ev).name, v_problem using errcode = '22023';
    end if;
    if (e.ev).kind = 'doubles' and (e.ev).partner_required
       and (coalesce(trim(e.partner_name), '') = '' or coalesce(trim(e.partner_email), '') = '') then
      raise exception 'Enter your partner''s name and email for %', (e.ev).name using errcode = '22023';
    end if;
    if exists (
      select 1 from public.registration_entries re
      join public.registrations r on r.id = re.registration_id and r.status in ('paid', 'waitlisted')
      join public.players p on p.id = r.player_id
      where re.event_id = (e.ev).id and lower(p.email) = v_email
    ) then
      raise exception 'You''re already registered for %', (e.ev).name using errcode = '55000';
    end if;
    if v_tournament_full
       or ((e.ev).max_teams is not null
           and private.event_spots_taken((e.ev).id)
               >= (e.ev).max_teams * (case when (e.ev).kind = 'doubles' then 2 else 1 end)) then
      v_waitlisted := v_waitlisted || (e.ev).id;
      v_waitlisted_names := v_waitlisted_names || (e.ev).name;
    end if;
  end loop;

  select count(distinct x.event_id) into v_count
  from jsonb_to_recordset(p_entries) as x(event_id uuid)
  where not (x.event_id = any (v_waitlisted));
  v_amount := public.registration_price(p_tournament, v_count);

  if v_code is not null then
    select d.code, d.cents, d.problem into v_discount_code, v_discount_cents, v_discount_problem
    from private.discount_for(p_tournament, v_code, v_amount) d;
    if v_discount_problem is not null then
      raise exception '%', v_discount_problem using errcode = '22023';
    end if;
  end if;
  v_amount := v_amount - coalesce(v_discount_cents, 0);
  v_status := case when v_count = 0 then 'waitlisted' when v_amount = 0 then 'paid' else 'pending' end;

  insert into public.players (first_name, last_name, email, phone, sms_opt_in, gender, birth_date,
                              dupr_id, dupr_doubles, dupr_singles, self_rating, added_by)
  values (v_first, v_last, v_email, nullif(trim(p_player ->> 'phone'), ''),
          coalesce((p_player ->> 'sms_opt_in')::boolean, false), v_gender, v_birth,
          v_dupr_id, v_dupr_doubles, v_dupr_singles, v_self, null)
  returning id into v_player;

  insert into public.registrations (tournament_id, player_id, amount_cents, created_at, status,
                                    paid_at, payment_provider, discount_code, discount_cents, waiver_accepted_at)
  values (p_tournament, v_player, v_amount, private.clock(), v_status,
          case when v_status = 'paid' then private.clock() end, case when v_status = 'paid' then 'free' end,
          v_discount_code, coalesce(v_discount_cents, 0),
          case when nullif(trim(t.waiver_text), '') is not null then private.clock() end)
  returning id into v_registration;

  insert into public.registration_entries (registration_id, event_id, partner_name, partner_email, waitlisted, waitlisted_at)
  select distinct on (x.event_id) v_registration, x.event_id, nullif(trim(x.partner_name), ''),
         lower(nullif(trim(x.partner_email), '')), x.event_id = any (v_waitlisted),
         case when x.event_id = any (v_waitlisted) then private.clock() end
  from jsonb_to_recordset(p_entries) as x(event_id uuid, partner_name text, partner_email text);

  if v_status = 'paid' then
    perform private.form_teams(v_registration);
  end if;

  return jsonb_build_object(
    'registration_id', v_registration,
    'amount_cents', v_amount,
    'status', v_status,
    'waitlisted', to_jsonb(v_waitlisted_names)
  );
end $$;

-- Teams form from paid, non-waitlisted entries only.
create or replace function private.form_teams(p_registration uuid) returns void
language plpgsql set search_path = '' as $$
declare
  r public.registrations;
  me public.players;
  e record;
  v_partner record;
  v_team uuid;
begin
  select * into r from public.registrations where id = p_registration;
  select * into me from public.players where id = r.player_id;

  for e in
    select re.*, ev.kind, ev.gender as event_gender from public.registration_entries re
    join public.events ev on ev.id = re.event_id
    where re.registration_id = p_registration and re.team_id is null and not re.waitlisted
  loop
    if e.kind = 'singles' then
      insert into public.teams (event_id, name) values (e.event_id, me.first_name || ' ' || me.last_name)
      returning id into v_team;
      insert into public.team_players (team_id, player_id) values (v_team, me.id);
      update public.registration_entries set team_id = v_team
      where registration_id = p_registration and event_id = e.event_id;
      continue;
    end if;

    select re2.registration_id, p2.id as player_id, p2.last_name
    into v_partner
    from public.registration_entries re2
    join public.registrations r2 on r2.id = re2.registration_id and r2.status = 'paid'
    join public.players p2 on p2.id = r2.player_id
    where re2.event_id = e.event_id
      and re2.team_id is null
      and not re2.waitlisted
      and re2.registration_id <> p_registration
      and lower(p2.email) = lower(e.partner_email)
      and lower(re2.partner_email) = lower(me.email)
      and (e.event_gender <> 'mixed' or p2.gender is distinct from me.gender)
    limit 1;

    if v_partner.registration_id is not null then
      insert into public.teams (event_id, name) values (e.event_id, me.last_name || '/' || v_partner.last_name)
      returning id into v_team;
      insert into public.team_players (team_id, player_id) values (v_team, me.id), (v_team, v_partner.player_id);
      update public.registration_entries set team_id = v_team
      where event_id = e.event_id and registration_id in (p_registration, v_partner.registration_id);
    end if;
  end loop;
end $$;

-- What the player sees after registering, now with waitlist status per event.
create or replace function public.get_registration(p_registration uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id,
    'tournament_id', r.tournament_id,
    'tournament_name', t.name,
    'status', r.status,
    'amount_cents', r.amount_cents,
    'discount_cents', r.discount_cents,
    'player_name', p.first_name || ' ' || p.last_name,
    'email', p.email,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', ev.id, 'event_name', ev.name, 'partner_name', re.partner_name,
               'team_id', re.team_id, 'team_name', tm.name, 'waitlisted', re.waitlisted,
               'offered', re.offered_at is not null) order by ev.sort_order)
      from public.registration_entries re
      join public.events ev on ev.id = re.event_id
      left join public.teams tm on tm.id = re.team_id
      where re.registration_id = r.id
    ), '[]'::jsonb)
  )
  from public.registrations r
  join public.tournaments t on t.id = r.tournament_id
  join public.players p on p.id = r.player_id
  where r.id = p_registration
$$;

-- ---------------------------------------------------------------------------
-- Waitlist management (admins)
-- ---------------------------------------------------------------------------

-- Offer a waitlisted player the spot. Their entry leaves the waitlist and
-- they owe for it: a waitlist-only registration becomes payable; one already
-- paid for other events gets a new payable registration for this event. The
-- player gets a text and an email with the link to pay (free entries are
-- confirmed straight away). Returns {registration_id, amount_cents, status}.
create function public.offer_waitlist_spot(p_registration uuid, p_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
  t public.tournaments;
  ev public.events;
  p public.players;
  v_target uuid;
  v_amount int;
  v_status public.registration_status;
  v_link text;
begin
  select * into r from public.registrations where id = p_registration for update;
  if not found then
    raise exception 'Registration not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(r.tournament_id);
  select * into t from public.tournaments where id = r.tournament_id;
  select * into ev from public.events where id = p_event;
  select * into p from public.players where id = r.player_id;
  if not exists (
    select 1 from public.registration_entries
    where registration_id = p_registration and event_id = p_event and waitlisted
  ) then
    raise exception 'That entry isn''t on the waitlist' using errcode = '55000';
  end if;

  if r.status = 'paid' then
    -- Already paid for other events: this one is an extra event, on its own registration.
    v_amount := public.registration_price(r.tournament_id, 2) - public.registration_price(r.tournament_id, 1);
    insert into public.registrations (tournament_id, player_id, amount_cents, created_at)
    values (r.tournament_id, r.player_id, v_amount, private.clock())
    returning id into v_target;
    update public.registration_entries
    set registration_id = v_target, waitlisted = false, offered_at = private.clock()
    where registration_id = p_registration and event_id = p_event;
  else
    v_target := p_registration;
    update public.registration_entries set waitlisted = false, offered_at = private.clock()
    where registration_id = p_registration and event_id = p_event;
    select greatest(0, public.registration_price(r.tournament_id, count(*)::int) - r.discount_cents) into v_amount
    from public.registration_entries where registration_id = p_registration and not waitlisted;
    -- A fresh 30-minute hold for the spot starts now.
    update public.registrations set amount_cents = v_amount, status = 'pending', created_at = private.clock()
    where id = p_registration;
  end if;

  if v_amount = 0 then
    update public.registrations set status = 'paid', paid_at = private.clock(), payment_provider = 'free'
    where id = v_target;
    perform private.form_teams(v_target);
    v_status := 'paid';
  else
    v_status := 'pending';
  end if;

  -- {url} becomes the site address when the message is sent.
  v_link := '{url}/t/' || t.id || '/register/done?r=' || v_target;
  insert into public.notifications (tournament_id, player_id, kind, via, subject, body)
  values
    (t.id, p.id, 'waitlist_offer', 'sms', null,
     'A spot opened in ' || ev.name || ' at ' || t.name || '! '
     || case when v_status = 'paid' then 'You''re in.' else 'Complete your registration here: ' || v_link end),
    (t.id, p.id, 'waitlist_offer', 'email', 'A spot opened in ' || ev.name,
     'Good news: a spot opened in ' || ev.name || ' at ' || t.name || '. '
     || case when v_status = 'paid' then 'You''re in.' else 'Complete your registration here: ' || v_link end);

  return jsonb_build_object('registration_id', v_target, 'amount_cents', v_amount, 'status', v_status);
end $$;

-- Remove a waitlisted entry. A registration left with no entries is cancelled.
create function public.remove_waitlist_entry(p_registration uuid, p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
begin
  select * into r from public.registrations where id = p_registration;
  if not found then
    raise exception 'Registration not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(r.tournament_id);
  delete from public.registration_entries
  where registration_id = p_registration and event_id = p_event and waitlisted;
  if not exists (select 1 from public.registration_entries where registration_id = p_registration) then
    update public.registrations set status = 'cancelled' where id = p_registration;
  end if;
end $$;

-- Registrations for the director, now with the waitlist and discounts.
create or replace view public.registration_details with (security_invoker = true) as
select r.id as registration_id,
       r.tournament_id,
       r.status,
       r.amount_cents,
       r.payment_provider,
       r.created_at,
       r.paid_at,
       p.id as player_id,
       p.first_name,
       p.last_name,
       p.email,
       p.phone,
       p.sms_opt_in,
       p.gender,
       p.birth_date,
       p.dupr_doubles,
       p.dupr_singles,
       p.self_rating,
       re.event_id,
       ev.name as event_name,
       re.partner_name,
       re.partner_email,
       re.team_id,
       tm.name as team_name,
       re.waitlisted,
       re.waitlisted_at,
       re.offered_at,
       r.discount_code,
       r.discount_cents
from public.registrations r
join public.players p on p.id = r.player_id
join public.registration_entries re on re.registration_id = r.id
join public.events ev on ev.id = re.event_id
left join public.teams tm on tm.id = re.team_id;

-- Texts not about a match (like a waitlist offer) carry their own link after
-- {url}; on practice tournaments {url} becomes nothing so the path stays.
create or replace function public.demo_inbox(p_team uuid)
returns table (id bigint, created_at timestamptz, player_name text, body text)
language sql stable security definer set search_path = '' as $$
  select n.id, n.created_at, p.first_name || ' ' || p.last_name,
         replace(n.body, '{url}', coalesce('/s/' || m.report_code, ''))
  from public.teams tm
  join public.tournaments t on t.id = tm.tournament_id and t.is_demo
  join public.team_players tp on tp.team_id = tm.id
  join public.players p on p.id = tp.player_id
  join public.notifications n on n.player_id = p.id and n.tournament_id = t.id
  left join public.matches m on m.id = n.match_id
  where tm.id = p_team
  order by n.id desc
  limit 20
$$;

create or replace function private.log_demo_texts() returns void
language sql set search_path = '' as $$
  update public.notifications n
  set channel = 'log', sent_at = now(),
      to_phone = case when n.via = 'sms' then p.phone end,
      to_email = case when n.via = 'email' then p.email end,
      sent_body = replace(n.body, '{url}',
                          coalesce('/s/' || (select m.report_code from public.matches m where m.id = n.match_id), ''))
  from public.tournaments t, public.players p
  where n.channel is null and t.id = n.tournament_id and t.is_demo and p.id = n.player_id
$$;

-- Anyone: which divisions are full (new entries join the waitlist) and how
-- many spots are left, for the sign-up form.
create function public.registration_availability(p_tournament uuid)
returns table (event_id uuid, spots_left int, full boolean)
language sql stable security definer set search_path = '' as $$
  select e.id,
         case when e.max_teams is not null
              then greatest(0, e.max_teams * (case when e.kind = 'doubles' then 2 else 1 end)
                               - private.event_spots_taken(e.id)) end,
         (e.max_teams is not null
          and private.event_spots_taken(e.id) >= e.max_teams * (case when e.kind = 'doubles' then 2 else 1 end))
         or (t.max_players is not null and private.tournament_players_taken(t.id) >= t.max_players)
  from public.events e
  join public.tournaments t on t.id = e.tournament_id
  where e.tournament_id = p_tournament
$$;
grant execute on function public.registration_availability(uuid) to anon, authenticated;
