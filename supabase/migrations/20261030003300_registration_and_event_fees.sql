-- Registration and event fees, and price schedules.
--
-- A player pays the registration fee once (tournaments.entry_fee_cents) and
-- the event fee for each event (tournaments.extra_event_fee_cents). With
-- tournaments.first_event_included, the registration fee covers one event:
-- one of the player's events whose division allows it
-- (events.included_in_registration). Every tournament so far priced this
-- way ("first event, each extra"), so they keep the same prices.
--
-- tournaments.price_schedule steps prices up on dates, e.g. $40 through
-- Oct 31, $50 through Nov 14, then the regular price: [{through,
-- registration_cents, event_cents}]. Each step applies through the end of its
-- `through` day in the tournament's time zone; the earliest step that hasn't
-- passed applies. It replaces the single early price (early_entry_fee_cents,
-- early_extra_event_fee_cents, early_until).

alter table public.tournaments add column first_event_included boolean not null default true;
alter table public.events add column included_in_registration boolean not null default true;
grant update (first_event_included) on public.tournaments to authenticated;
grant update (included_in_registration) on public.events to authenticated;

-- A schedule's steps: dates, and whole non-negative cents.
create function private.valid_price_schedule(p_schedule jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_schedule) = 'array'
     and coalesce((
       select bool_and(
                jsonb_typeof(s) = 'object'
                and s ->> 'through' ~ '^\d{4}-\d{2}-\d{2}$'
                and jsonb_typeof(s -> 'registration_cents') = 'number'
                and jsonb_typeof(s -> 'event_cents') = 'number'
                and (s ->> 'registration_cents')::numeric >= 0
                and (s ->> 'event_cents')::numeric >= 0
                and (s ->> 'registration_cents')::numeric = trunc((s ->> 'registration_cents')::numeric)
                and (s ->> 'event_cents')::numeric = trunc((s ->> 'event_cents')::numeric))
       from jsonb_array_elements(p_schedule) s), true)
$$;

alter table public.tournaments
  add column price_schedule jsonb not null default '[]'::jsonb
  check (private.valid_price_schedule(price_schedule));
grant update (price_schedule) on public.tournaments to authenticated;

-- An early price becomes a one-step schedule, through its last day.
update public.tournaments
set price_schedule = jsonb_build_array(jsonb_build_object(
      'through', to_char(((early_until - interval '1 microsecond') at time zone time_zone)::date, 'YYYY-MM-DD'),
      'registration_cents', coalesce(early_entry_fee_cents, entry_fee_cents),
      'event_cents', coalesce(early_extra_event_fee_cents, extra_event_fee_cents)))
where early_until is not null;

-- The registration and event fees at a moment.
create function private.price_at(t public.tournaments, p_at timestamptz)
returns table (registration_cents int, event_cents int)
language sql stable set search_path = '' as $$
  select coalesce(s.registration_cents, t.entry_fee_cents), coalesce(s.event_cents, t.extra_event_fee_cents)
  from (select 1) one
  left join lateral (
    select (step ->> 'registration_cents')::int as registration_cents, (step ->> 'event_cents')::int as event_cents
    from jsonb_array_elements(t.price_schedule) step
    where (p_at at time zone t.time_zone)::date <= (step ->> 'through')::date
    order by (step ->> 'through')::date
    limit 1
  ) s on true
$$;

-- The event fee now.
create function private.event_fee_now(p_tournament uuid) returns int
language sql stable set search_path = '' as $$
  select p.event_cents
  from public.tournaments t
  cross join lateral private.price_at(t, private.clock()) p
  where t.id = p_tournament
$$;

-- What a player paying their own registration owes now for these events:
-- the registration fee, and the event fee for each, less one when the
-- registration covers an event and one of these may be it.
create function private.entry_cost(p_tournament uuid, p_events uuid[]) returns int
language sql stable set search_path = '' as $$
  select case when coalesce(cardinality(p_events), 0) = 0 then 0 else
           p.registration_cents + p.event_cents * (cardinality(p_events)
             - case when t.first_event_included
                         and exists (select 1 from public.events e where e.id = any (p_events) and e.included_in_registration)
                    then 1 else 0 end)
         end
  from public.tournaments t
  cross join lateral private.price_at(t, private.clock()) p
  where t.id = p_tournament
$$;

-- Price in cents for this many events whose divisions may all be the
-- included one: the registration fee, and the event fee for each event it
-- doesn't cover.
create or replace function public.registration_price(p_tournament uuid, p_event_count int) returns int
language sql stable security definer set search_path = '' as $$
  select case when p_event_count < 1 then 0
              else p.registration_cents + p.event_cents * (p_event_count - case when t.first_event_included then 1 else 0 end)
         end
  from public.tournaments t
  cross join lateral private.price_at(t, private.clock()) p
  where t.id = p_tournament
$$;

-- As before: the event fee a registration paid, at the price when it registered.
create or replace function private.extra_event_fee(r public.registrations) returns int
language sql stable set search_path = '' as $$
  select p.event_cents
  from public.tournaments t
  cross join lateral private.price_at(t, r.created_at) p
  where t.id = r.tournament_id
$$;

-- As before: its own events (each at the event fee if a partner paid one of
-- them), plus what it pays for partners, less its discount; its own events
-- now cost what entry_cost says for them.
create or replace function private.registration_amount(p_registration uuid) returns int
language sql stable set search_path = '' as $$
  select greatest(0,
    case when bool_or(re.paid_by_registration_id is not null)
         then (count(*) filter (where re.paid_by_registration_id is null))::int * private.event_fee_now(r.tournament_id)
         else private.entry_cost(r.tournament_id,
                coalesce(array_agg(re.event_id) filter (where re.paid_by_registration_id is null and re.event_id is not null), '{}'))
    end
    + coalesce(sum(re.partner_paid_cents), 0)::int
    - r.discount_cents)
  from public.registrations r
  left join public.registration_entries re on re.registration_id = r.id and not re.waitlisted
  where r.id = p_registration
  group by r.id
$$;


-- As before (partner_pay_and_questions), with its own events at what entry_cost says
-- for them, and each partner it pays for at their registration and, unless it is
-- the one included, the event.
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
  -- Entries a partner paid for, and the registration that paid each.
  v_covered uuid[] := '{}';
  v_covered_by uuid[] := '{}';
  v_cover uuid;
  -- Entries where this player pays for their partner too.
  v_paying uuid[] := '{}';
  v_partner text;
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
  -- Checked now, so a missing answer fails before anything is saved.
  perform private.check_answers(p_tournament, p_player -> 'answers');

  v_tournament_full := t.max_players is not null and private.tournament_players_taken(p_tournament) >= t.max_players;

  for e in
    select x.partner_name, x.partner_email, coalesce(x.pay_for_partner, false) as pay_for_partner, ev
    from jsonb_to_recordset(p_entries) as x(event_id uuid, partner_name text, partner_email text, pay_for_partner boolean)
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

    -- A partner already paid this entry: free, and the held spot is theirs.
    select re.registration_id into v_cover
    from public.registration_entries re
    join public.registrations r on r.id = re.registration_id and r.status = 'paid'
    where re.event_id = (e.ev).id and lower(re.partner_email) = v_email and private.cover_unclaimed(re.registration_id, re.event_id, re.partner_paid_cents)
    order by r.paid_at
    limit 1;
    if v_cover is not null then
      if e.pay_for_partner then
        raise exception 'Your partner already paid for both of you in %', (e.ev).name using errcode = '22023';
      end if;
      v_covered := v_covered || (e.ev).id;
      v_covered_by := v_covered_by || v_cover;
      continue;
    end if;

    if e.pay_for_partner then
      v_partner := lower(nullif(trim(e.partner_email), ''));
      if (e.ev).kind <> 'doubles' or v_partner is null then
        raise exception 'Enter your partner''s email to pay for them in %', (e.ev).name using errcode = '22023';
      end if;
      if v_partner = v_email then
        raise exception 'Enter your partner''s email, not yours, to pay for them in %', (e.ev).name using errcode = '22023';
      end if;
      if exists (
        select 1 from public.registration_entries re
        join public.registrations r on r.id = re.registration_id and r.status = 'paid'
        join public.players p on p.id = r.player_id
        where re.event_id = (e.ev).id and lower(p.email) = v_partner
      ) then
        raise exception '% is already registered for %', coalesce(nullif(trim(e.partner_name), ''), v_partner), (e.ev).name
          using errcode = '55000';
      end if;
      if exists (
        select 1 from public.registration_entries re
        join public.registrations r on r.id = re.registration_id and r.status = 'paid'
        where re.event_id = (e.ev).id and lower(re.partner_email) = v_partner and private.cover_unclaimed(re.registration_id, re.event_id, re.partner_paid_cents)
      ) then
        raise exception 'Someone already paid for % in %', coalesce(nullif(trim(e.partner_name), ''), v_partner), (e.ev).name
          using errcode = '55000';
      end if;
    end if;

    -- Full: the waitlist, at no charge (and nothing paid for a partner).
    if v_tournament_full
       or ((e.ev).max_teams is not null
           and private.event_spots_taken((e.ev).id) + (case when e.pay_for_partner then 2 else 1 end)
               > (e.ev).max_teams * (case when (e.ev).kind = 'doubles' then 2 else 1 end)) then
      v_waitlisted := v_waitlisted || (e.ev).id;
      v_waitlisted_names := v_waitlisted_names || (e.ev).name;
    elsif e.pay_for_partner then
      v_paying := v_paying || (e.ev).id;
    end if;
  end loop;

  -- Events this player pays for themselves.
  select count(distinct x.event_id) into v_count
  from jsonb_to_recordset(p_entries) as x(event_id uuid)
  where not (x.event_id = any (v_waitlisted)) and not (x.event_id = any (v_covered));
  -- With an event paid by a partner, each of their own costs the extra-event fee.
  v_amount := case when cardinality(v_covered) > 0
                   then v_count * private.event_fee_now(p_tournament)
                   else private.entry_cost(p_tournament, array(
                          select distinct x.event_id from jsonb_to_recordset(p_entries) as x(event_id uuid)
                          where not (x.event_id = any (v_waitlisted)) and not (x.event_id = any (v_covered))))
              end
              -- Paying for a partner: their registration, and the event unless it is the one included.
              + coalesce((select sum(private.entry_cost(p_tournament, array[pe])) from unnest(v_paying) pe), 0)::int;

  if v_code is not null then
    select d.code, d.cents, d.problem into v_discount_code, v_discount_cents, v_discount_problem
    from private.discount_for(p_tournament, v_code, v_amount) d;
    if v_discount_problem is not null then
      raise exception '%', v_discount_problem using errcode = '22023';
    end if;
  end if;
  v_amount := v_amount - coalesce(v_discount_cents, 0);
  v_status := case when v_count + cardinality(v_covered) = 0 then 'waitlisted'
                   when v_amount = 0 then 'paid' else 'pending' end;

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

  insert into public.registration_entries (registration_id, event_id, partner_name, partner_email, waitlisted, waitlisted_at,
                                           partner_paid_cents, paid_by_registration_id, paid_by_cents)
  select distinct on (x.event_id) v_registration, x.event_id, nullif(trim(x.partner_name), ''),
         lower(nullif(trim(x.partner_email), '')), x.event_id = any (v_waitlisted),
         case when x.event_id = any (v_waitlisted) then private.clock() end,
         case when x.event_id = any (v_paying) then private.entry_cost(p_tournament, array[x.event_id]) else 0 end,
         v_covered_by[array_position(v_covered, x.event_id)],
         coalesce((select pe.partner_paid_cents from public.registration_entries pe
                   where pe.registration_id = v_covered_by[array_position(v_covered, x.event_id)]
                     and pe.event_id = x.event_id), 0)
  from jsonb_to_recordset(p_entries) as x(event_id uuid, partner_name text, partner_email text);

  insert into public.registration_answers (registration_id, question_id, answer)
  select v_registration, a.question_id, a.answer from private.check_answers(p_tournament, p_player -> 'answers') a;

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

alter table public.tournaments
  drop column early_entry_fee_cents,
  drop column early_extra_event_fee_cents,
  drop column early_until;
