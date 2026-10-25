-- Player registration and payment, the text outbox sender, and score
-- reporting from the link in players' texts.
--
-- Registration: a player (no account needed) picks events and names a
-- partner for each doubles event. start_registration() records it as pending
-- with the price. The server takes payment (Stripe Checkout, or the test
-- checkout) and calls confirm_registration_payment(), which only the service
-- role can run. Teams form when both partners have paid and named each other;
-- directors pair the rest by hand.

create type public.registration_status as enum ('pending', 'paid', 'cancelled', 'refunded');

create table public.registrations (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  status public.registration_status not null default 'pending',
  amount_cents int not null check (amount_cents >= 0),
  -- 'stripe' or 'test'; payment_ref is the Stripe Checkout session id.
  payment_provider text,
  payment_ref text unique,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index on public.registrations (tournament_id, status);

create table public.registration_entries (
  registration_id uuid not null references public.registrations (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  partner_name text,
  partner_email text,
  team_id uuid references public.teams (id) on delete set null,
  primary key (registration_id, event_id)
);
create index on public.registration_entries (event_id);

-- ---------------------------------------------------------------------------
-- Prices and registration
-- ---------------------------------------------------------------------------

-- First event at the entry fee, each extra event at the extra-event fee;
-- early prices until early_until.
create function public.registration_price(p_tournament uuid, p_event_count int) returns int
language sql stable security definer set search_path = '' as $$
  select case when p_event_count < 1 then 0 else
           case when t.early_until > private.clock()
                then coalesce(t.early_entry_fee_cents, t.entry_fee_cents)
                     + (p_event_count - 1) * coalesce(t.early_extra_event_fee_cents, t.extra_event_fee_cents)
                else t.entry_fee_cents + (p_event_count - 1) * t.extra_event_fee_cents
           end
         end
  from public.tournaments t
  where t.id = p_tournament
$$;

-- Why a player can't enter an event (finishing "Men's 3.5 ..."), or null
-- when they can. Same rules as web/src/lib/eligibility.ts, which shows them
-- on the registration form.
create function private.entry_problem(
  e public.events,
  t public.tournaments,
  p_gender text,
  p_birth_date date,
  p_dupr_doubles numeric,
  p_dupr_singles numeric,
  p_self_rating numeric,
  p_dupr_id text default null
) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_on date;
  v_age int;
  v_rating numeric;
  v_low numeric;
  v_high numeric;
begin
  if e.gender = 'mens' and p_gender is distinct from 'male' then
    return 'is for men';
  elsif e.gender = 'womens' and p_gender is distinct from 'female' then
    return 'is for women';
  elsif e.gender = 'mixed' and p_gender is null then
    return 'needs your gender (mixed doubles is one man and one woman)';
  end if;

  if e.min_age is not null or e.max_age is not null then
    if p_birth_date is null then
      return 'needs your date of birth';
    end if;
    v_on := case when e.age_basis = 'year_end'
                 then make_date(extract(year from t.starts_on)::int, 12, 31)
                 else t.starts_on end;
    v_age := extract(year from age(v_on, p_birth_date))::int;
    if v_age < coalesce(e.min_age, 0) or v_age > coalesce(e.max_age, 200) then
      return case
        when e.max_age is null then format('is for ages %s and up', e.min_age)
        when e.min_age is null then format('is for ages %s and under', e.max_age)
        else format('is for ages %s to %s', e.min_age, e.max_age)
      end;
    end if;
  end if;

  if e.require_dupr_id and nullif(trim(p_dupr_id), '') is null then
    return 'needs your DUPR ID';
  end if;

  if e.skill_rule <> 'open' then
    v_rating := case when e.kind = 'singles' then p_dupr_singles else p_dupr_doubles end;
    if v_rating is null and e.rating_source = 'dupr_or_self' then
      v_rating := p_self_rating;
    end if;
    if v_rating is null then
      return case when e.rating_source = 'dupr' then 'needs your DUPR rating' else 'needs your rating' end;
    end if;
    v_low := case when e.skill_rule in ('only', 'and_above', 'range') then e.skill_level end;
    v_high := case e.skill_rule
                when 'only' then e.skill_level + 0.5
                when 'and_under' then e.skill_level + 0.5
                when 'range' then e.skill_level_to + 0.5
              end;
    -- rating_tolerance lets players just over the top in (e.g. 0.25: a
    -- 4.20 may play 3.5–4.0); play_up_limit caps how far below the bottom a
    -- player may play up.
    if v_high is not null and v_rating >= v_high + e.rating_tolerance then
      return format('is for players rated under %s', v_high + e.rating_tolerance);
    end if;
    if v_low is not null and v_rating < v_low then
      if not e.allow_play_up then
        return format('is for players rated %s and up', v_low);
      elsif e.play_up_limit is not null and v_rating < v_low - e.play_up_limit then
        return format('lets players rated %s and up play up', v_low - e.play_up_limit);
      end if;
    end if;
  end if;
  return null;
end $$;

-- Makes a team for every paid entry whose partner has also paid and named
-- this player back (by email). Singles entries get a team of one. Mixed
-- doubles only pairs a man with a woman.
create function private.form_teams(p_registration uuid) returns void
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
    where re.registration_id = p_registration and re.team_id is null
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

-- Anyone (no account) can register while the tournament is open for
-- registration.
--   p_player:  {first_name, last_name, email, phone, sms_opt_in, gender
--               ('male'/'female'), birth_date, dupr_doubles, dupr_singles, self_rating}
--   p_entries: [{event_id, partner_name, partner_email}]
-- Checks every event's gender, age, skill and capacity rules. A spot in a
-- capped event is held for 30 minutes while payment is pending.
-- Returns {registration_id, amount_cents, status}.
create function public.start_registration(p_tournament uuid, p_player jsonb, p_entries jsonb) returns jsonb
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
  v_player uuid;
  v_registration uuid;
  v_count int;
  v_amount int;
  v_taken int;
  v_spots int;
  v_problem text;
  e record;
begin
  select * into t from public.tournaments where id = p_tournament;
  if not found then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  if t.status <> 'registration' then
    raise exception 'Registration for % is not open', t.name using errcode = '55000';
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
      join public.registrations r on r.id = re.registration_id and r.status = 'paid'
      join public.players p on p.id = r.player_id
      where re.event_id = (e.ev).id and lower(p.email) = v_email
    ) then
      raise exception 'You''re already registered for %', (e.ev).name using errcode = '55000';
    end if;
    if (e.ev).max_teams is not null then
      v_spots := (e.ev).max_teams * (case when (e.ev).kind = 'doubles' then 2 else 1 end);
      select count(*) into v_taken
      from public.registration_entries re
      join public.registrations r on r.id = re.registration_id
      where re.event_id = (e.ev).id
        and (r.status = 'paid' or (r.status = 'pending' and r.created_at > private.clock() - interval '30 minutes'));
      if v_taken >= v_spots then
        raise exception '% is full', (e.ev).name using errcode = '55000';
      end if;
    end if;
  end loop;

  select count(distinct x.event_id) into v_count
  from jsonb_to_recordset(p_entries) as x(event_id uuid);
  v_amount := public.registration_price(p_tournament, v_count);

  if v_dupr_id is not null and v_dupr_id !~ '^[A-Z0-9]{4,12}$' then
    raise exception 'A DUPR ID is letters and numbers, like 7K2QXW' using errcode = '22023';
  end if;

  insert into public.players (first_name, last_name, email, phone, sms_opt_in, gender, birth_date,
                              dupr_id, dupr_doubles, dupr_singles, self_rating, added_by)
  values (v_first, v_last, v_email, nullif(trim(p_player ->> 'phone'), ''),
          coalesce((p_player ->> 'sms_opt_in')::boolean, false), v_gender, v_birth,
          v_dupr_id, v_dupr_doubles, v_dupr_singles, v_self, null)
  returning id into v_player;

  insert into public.registrations (tournament_id, player_id, amount_cents, created_at)
  values (p_tournament, v_player, v_amount, private.clock())
  returning id into v_registration;

  insert into public.registration_entries (registration_id, event_id, partner_name, partner_email)
  select distinct on (x.event_id) v_registration, x.event_id, nullif(trim(x.partner_name), ''),
         lower(nullif(trim(x.partner_email), ''))
  from jsonb_to_recordset(p_entries) as x(event_id uuid, partner_name text, partner_email text);

  if v_amount = 0 then
    update public.registrations set status = 'paid', paid_at = private.clock(), payment_provider = 'free'
    where id = v_registration;
    perform private.form_teams(v_registration);
  end if;

  return jsonb_build_object(
    'registration_id', v_registration,
    'amount_cents', v_amount,
    'status', case when v_amount = 0 then 'paid' else 'pending' end
  );
end $$;

-- What the player sees after checkout: status, amount and each event's team
-- (or who they're waiting for). Anyone with the registration id can read it.
create function public.get_registration(p_registration uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id,
    'tournament_id', r.tournament_id,
    'tournament_name', t.name,
    'status', r.status,
    'amount_cents', r.amount_cents,
    'player_name', p.first_name || ' ' || p.last_name,
    'email', p.email,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', ev.id, 'event_name', ev.name, 'partner_name', re.partner_name,
               'team_id', re.team_id, 'team_name', tm.name) order by ev.sort_order)
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

-- Server only: the details needed to start a checkout.
create function public.registration_for_checkout(p_registration uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.get_registration(p_registration)
$$;

-- Server only: remember the Stripe Checkout session before redirecting.
create function public.attach_checkout_session(p_registration uuid, p_session_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update public.registrations
  set payment_provider = 'stripe', payment_ref = p_session_id
  where id = p_registration and status = 'pending';
  return jsonb_build_object('ok', found);
end $$;

-- Server only (Stripe webhook or test checkout): mark paid and form teams.
-- Safe to call twice for the same payment.
create function public.confirm_registration_payment(
  p_registration uuid, p_provider text, p_payment_ref text, p_amount_cents int
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
begin
  select * into r from public.registrations where id = p_registration for update;
  if not found then
    raise exception 'Registration not found' using errcode = 'P0002';
  end if;
  if r.status = 'paid' then
    return jsonb_build_object('status', 'paid', 'already', true);
  end if;
  if r.status <> 'pending' then
    raise exception 'Registration is %', r.status using errcode = '55000';
  end if;
  if p_amount_cents <> r.amount_cents then
    raise exception 'Paid % cents but the registration costs %', p_amount_cents, r.amount_cents using errcode = '22023';
  end if;
  update public.registrations
  set status = 'paid', paid_at = private.clock(), payment_provider = p_provider,
      payment_ref = coalesce(p_payment_ref, payment_ref)
  where id = p_registration;
  perform private.form_teams(p_registration);
  return jsonb_build_object('status', 'paid', 'already', false);
end $$;

-- Director: pair two paid registrations into a team for an event, when their
-- partner details didn't match up (typos, a partner who registered later).
create function public.pair_registrations(p_event uuid, p_registration_a uuid, p_registration_b uuid)
returns public.teams
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  a record;
  b record;
  t public.teams;
begin
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(e.tournament_id);
  perform private.lock_tournament(e.tournament_id);

  select re.team_id, p.id as player_id, p.last_name, p.gender into a
  from public.registration_entries re
  join public.registrations r on r.id = re.registration_id and r.status = 'paid'
  join public.players p on p.id = r.player_id
  where re.registration_id = p_registration_a and re.event_id = p_event;
  select re.team_id, p.id as player_id, p.last_name, p.gender into b
  from public.registration_entries re
  join public.registrations r on r.id = re.registration_id and r.status = 'paid'
  join public.players p on p.id = r.player_id
  where re.registration_id = p_registration_b and re.event_id = p_event;

  if a.player_id is null or b.player_id is null or p_registration_a = p_registration_b then
    raise exception 'Choose two different paid players entered in this event' using errcode = '22023';
  end if;
  if a.team_id is not null or b.team_id is not null then
    raise exception 'One of these players already has a team in this event' using errcode = '55000';
  end if;
  if e.gender = 'mixed' and a.gender is not distinct from b.gender then
    raise exception 'Mixed doubles teams are one man and one woman' using errcode = '22023';
  end if;

  insert into public.teams (event_id, name) values (p_event, a.last_name || '/' || b.last_name) returning * into t;
  insert into public.team_players (team_id, player_id) values (t.id, a.player_id), (t.id, b.player_id);
  update public.registration_entries set team_id = t.id
  where event_id = p_event and registration_id in (p_registration_a, p_registration_b);
  return t;
end $$;

-- Every registration in a tournament with its entries, for the director.
create view public.registration_details with (security_invoker = true) as
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
       tm.name as team_name
from public.registrations r
join public.players p on p.id = r.player_id
join public.registration_entries re on re.registration_id = r.id
join public.events ev on ev.id = re.event_id
left join public.teams tm on tm.id = re.team_id;

-- ---------------------------------------------------------------------------
-- Texts
-- ---------------------------------------------------------------------------

-- Server only: claim up to p_limit unsent texts, with what's needed to send
-- them. Claimed rows aren't handed out again.
create function public.claim_notifications(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rows jsonb;
begin
  with claimed as (
    update public.notifications n
    set claimed_at = now()
    where n.id in (
      select id from public.notifications
      where claimed_at is null
      order by id
      limit p_limit
      for update skip locked
    )
    returning n.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'body', c.body, 'kind', c.kind, 'via', c.via, 'subject', c.subject,
           'phone', p.phone, 'sms_opt_in', p.sms_opt_in, 'email', p.email, 'report_code', m.report_code
         ) order by c.id), '[]'::jsonb)
  into v_rows
  from claimed c
  join public.players p on p.id = c.player_id
  left join public.matches m on m.id = c.match_id;
  return v_rows;
end $$;

-- Server only: record what happened to a claimed message. p_to is the phone
-- number or email address it went to.
create function public.finish_notification(
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

-- What the director's Messages page shows.
create view public.notification_log with (security_invoker = true) as
select n.id, n.tournament_id, n.kind, n.via, n.subject, n.created_at, n.sent_at, n.channel,
       n.to_phone, n.to_email, coalesce(n.sent_body, n.body) as body, n.error,
       n.provider_id, n.delivery_status,
       p.first_name || ' ' || p.last_name as player_name,
       c.name as court_name
from public.notifications n
join public.players p on p.id = n.player_id
left join public.matches m on m.id = n.match_id
left join public.courts c on c.id = m.court_id;

-- ---------------------------------------------------------------------------
-- Score reporting from the text link (no account)
-- ---------------------------------------------------------------------------

create function private.match_by_code(p_code text) returns public.matches
language plpgsql set search_path = '' as $$
declare
  v_id uuid;
begin
  select id into v_id from public.matches where report_code = p_code;
  if v_id is null then
    raise exception 'This score link isn''t valid' using errcode = 'P0002';
  end if;
  return private.lock_match(v_id);
end $$;

-- The match behind a score link, with its scoring rules.
create function public.get_match_by_code(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(md) || jsonb_build_object(
           'games_to', case when md.stage = 'bracket' then coalesce(e.playoff_games_to, e.games_to) else e.games_to end,
           'best_of', case when md.stage = 'bracket' then coalesce(e.playoff_best_of, e.best_of) else e.best_of end,
           'point_cap', case when md.stage = 'bracket' then coalesce(e.playoff_point_cap, e.point_cap) else e.point_cap end,
           'tournament_name', t.name)
  from public.matches m
  join public.match_details md on md.id = m.id
  join public.events e on e.id = m.event_id
  join public.tournaments t on t.id = m.tournament_id
  where m.report_code = p_code
$$;

create function public.confirm_on_court_by_code(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.match_by_code(p_code);
  if m.status = 'assigned' then
    update public.matches set status = 'in_progress', started_at = private.clock() where id = m.id;
  elsif m.status <> 'in_progress' then
    raise exception 'This match isn''t on a court right now' using errcode = '55000';
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Players report once; corrections go through the director (correct_score).
create function public.report_score_by_code(p_code text, p_games jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.match_by_code(p_code);
  if m.status = 'completed' then
    raise exception 'A score was already reported for this match. Ask the desk to fix it if it''s wrong.'
      using errcode = '55000';
  end if;
  if m.status not in ('assigned', 'in_progress') then
    raise exception 'This match isn''t on a court right now' using errcode = '55000';
  end if;
  perform private.finish_match(m.id, private.score_winner(m, p_games), p_games, false);
  perform private.auto_assign(m.tournament_id);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

revoke all on public.registrations, public.registration_entries from anon, authenticated;
alter table public.registrations enable row level security;
alter table public.registration_entries enable row level security;

grant select on public.registrations, public.registration_entries, public.registration_details,
  public.notification_log, public.notifications to authenticated;

create policy "Staff see registrations" on public.registrations for select to authenticated
  using (public.is_tournament_staff(tournament_id));
create policy "Staff see registration entries" on public.registration_entries for select to authenticated
  using (exists (select 1 from public.registrations r
                 where r.id = registration_id and public.is_tournament_staff(r.tournament_id)));
create policy "Staff see their tournament's texts" on public.notifications for select to authenticated
  using (public.is_tournament_staff(tournament_id));
-- Staff see registered players' contact details (they may not be on a team yet).
create policy "Staff see registered players" on public.players for select to authenticated
  using (exists (select 1 from public.registrations r
                 where r.player_id = players.id and public.is_tournament_staff(r.tournament_id)));

-- Payment and sending functions are for the server (service role) only.
revoke execute on function public.registration_for_checkout(uuid) from public, anon, authenticated;
revoke execute on function public.attach_checkout_session(uuid, text) from public, anon, authenticated;
revoke execute on function public.confirm_registration_payment(uuid, text, text, int) from public, anon, authenticated;
revoke execute on function public.claim_notifications(int) from public, anon, authenticated;
revoke execute on function public.finish_notification(bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.registration_for_checkout(uuid), public.attach_checkout_session(uuid, text),
  public.confirm_registration_payment(uuid, text, text, int), public.claim_notifications(int),
  public.finish_notification(bigint, text, text, text, text) to service_role;
