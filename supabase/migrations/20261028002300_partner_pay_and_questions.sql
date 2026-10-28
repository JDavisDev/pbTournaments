-- Paying for a partner, and the director's own registration questions.
--
-- Paying for a partner: on a doubles entry a player can pay their partner's
-- entry too (the first-event price, for that event). The partner's spot is
-- held. The partner still registers themselves (details, ratings, waiver,
-- questions); the entry their partner paid costs them nothing, and any other
-- events they enter cost the extra-event fee each, so between them the
-- partner's events cost what they would have alone. If the partner withdraws
-- from it, the payer gets the credit. If the payer withdraws before the
-- partner registers, the partner's fee goes back to the payer too.
--
-- Registration questions: a tournament's own questions (T-shirt size, a club,
-- dietary needs): short text, one choice or several, required or not. Each
-- registration's answers are kept with it.

-- ---------------------------------------------------------------------------
-- Paying for a partner
-- ---------------------------------------------------------------------------

alter table public.registration_entries
  -- On the payer's entry: what they paid toward their partner's entry here.
  add column partner_paid_cents int not null default 0 check (partner_paid_cents >= 0),
  -- On the partner's entry: the registration that paid it, and how much.
  add column paid_by_registration_id uuid references public.registrations (id) on delete set null,
  add column paid_by_cents int not null default 0 check (paid_by_cents >= 0);
-- A partner's payment covers one entry.
create unique index registration_entries_paid_by on public.registration_entries (paid_by_registration_id, event_id)
  where paid_by_registration_id is not null;

alter table public.registration_withdrawals
  add column partner_paid_cents int not null default 0,
  -- Credited to whoever paid for the partner (the payer).
  add column cover_credit_cents int not null default 0;

-- A payer's entry whose partner hasn't registered yet: the partner's spot is held.
create function private.cover_unclaimed(p_registration uuid, p_event uuid, p_partner_paid_cents int) returns boolean
language sql stable set search_path = '' as $$
  select p_partner_paid_cents > 0 and not exists (
    select 1 from public.registration_entries c
    where c.paid_by_registration_id = p_registration and c.event_id = p_event
  )
$$;

-- Spots taken now include partners' spots that are paid for and held.
create or replace function private.event_spots_taken(p_event uuid) returns int
language sql stable set search_path = '' as $$
  select (count(*) + count(*) filter (where private.cover_unclaimed(re.registration_id, re.event_id, re.partner_paid_cents)))::int
  from public.registration_entries re
  join public.registrations r on r.id = re.registration_id
  where re.event_id = p_event and not re.waitlisted
    and (r.status = 'paid' or (r.status = 'pending' and r.created_at > private.clock() - interval '30 minutes'))
$$;

create or replace function private.tournament_players_taken(p_tournament uuid) returns int
language sql stable set search_path = '' as $$
  with live as (
    select r.player_id, re.registration_id, re.event_id, re.partner_email, re.partner_paid_cents
    from public.registrations r
    left join public.registration_entries re on re.registration_id = r.id
    where r.tournament_id = p_tournament
      and (r.status = 'paid' or (r.status = 'pending' and r.created_at > private.clock() - interval '30 minutes'))
  )
  select ((select count(distinct player_id) from live)
          + (select count(distinct lower(l.partner_email)) from live l
             where private.cover_unclaimed(l.registration_id, l.event_id, l.partner_paid_cents)))::int
$$;

-- What a registration costs now: its own events (each at the extra-event
-- fee if a partner paid one of them), plus what it pays for partners, less
-- its discount.
create function private.registration_amount(p_registration uuid) returns int
language sql stable set search_path = '' as $$
  select greatest(0,
    case when bool_or(re.paid_by_registration_id is not null)
         then (count(*) filter (where re.paid_by_registration_id is null))::int
              * (public.registration_price(r.tournament_id, 2) - public.registration_price(r.tournament_id, 1))
         else public.registration_price(r.tournament_id, (count(*) filter (where re.paid_by_registration_id is null))::int)
    end
    + coalesce(sum(re.partner_paid_cents), 0)::int
    - r.discount_cents)
  from public.registrations r
  left join public.registration_entries re on re.registration_id = r.id and not re.waitlisted
  where r.id = p_registration
  group by r.id
$$;

-- ---------------------------------------------------------------------------
-- Registration questions
-- ---------------------------------------------------------------------------

create table public.registration_questions (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 200),
  -- text: a short answer; choice: one of the options; choices: any of them.
  kind text not null default 'text' check (kind in ('text', 'choice', 'choices')),
  options text[] not null default '{}',
  required boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  check (kind = 'text' or cardinality(options) between 1 and 30)
);
create index on public.registration_questions (tournament_id, sort_order);

create table public.registration_answers (
  registration_id uuid not null references public.registrations (id) on delete cascade,
  question_id uuid not null references public.registration_questions (id) on delete cascade,
  -- One value for text and choice; any number for choices.
  answer text[] not null,
  primary key (registration_id, question_id)
);

-- Checks p_answers ([{question_id, answer: text | [text]}]) against the
-- tournament's questions and returns them cleaned up, keyed by question.
create function private.check_answers(p_tournament uuid, p_answers jsonb) returns table (question_id uuid, answer text[])
language plpgsql stable set search_path = '' as $$
declare
  q public.registration_questions;
  v_raw jsonb;
  v_answer text[];
begin
  for q in select * from public.registration_questions where tournament_id = p_tournament order by sort_order, created_at loop
    select a -> 'answer' into v_raw
    from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) a
    where (a ->> 'question_id')::uuid = q.id;
    v_answer := case
      when v_raw is null or jsonb_typeof(v_raw) = 'null' then '{}'
      when jsonb_typeof(v_raw) = 'array' then array(select trim(x) from jsonb_array_elements_text(v_raw) x where trim(x) <> '')
      else array_remove(array[trim(v_raw #>> '{}')], '')
    end;
    if cardinality(v_answer) = 0 then
      if q.required then
        raise exception 'Please answer “%”', q.label using errcode = '22023';
      end if;
      continue;
    end if;
    if q.kind = 'text' and (cardinality(v_answer) > 1 or length(v_answer[1]) > 500) then
      raise exception 'Keep your answer to “%” under 500 characters', q.label using errcode = '22023';
    end if;
    if q.kind = 'choice' and (cardinality(v_answer) > 1 or not v_answer[1] = any (q.options)) then
      raise exception 'Choose one of the answers for “%”', q.label using errcode = '22023';
    end if;
    if q.kind = 'choices' and not v_answer <@ q.options then
      raise exception 'Choose from the answers for “%”', q.label using errcode = '22023';
    end if;
    question_id := q.id;
    answer := v_answer;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Registration: paying for partners, partners already paid for, answers
-- ---------------------------------------------------------------------------

--   p_entries adds pay_for_partner (true): pay this doubles partner's entry too.
--   p_player adds answers: [{question_id, answer: "text" | ["choice", ...]}].
-- An entry a partner already paid for (matched by this player's email) is
-- free and its held spot is theirs, even if the division has filled since.
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
  v_first_fee int := public.registration_price(p_tournament, 1);
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
                   then v_count * (public.registration_price(p_tournament, 2) - v_first_fee)
                   else public.registration_price(p_tournament, v_count) end
              + cardinality(v_paying) * v_first_fee;

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
         case when x.event_id = any (v_paying) then v_first_fee else 0 end,
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

-- Anyone: the events where a partner already paid this email's entry, so
-- the sign-up form can show them as paid.
create function public.partner_paid_events(p_tournament uuid, p_email text) returns table (event_id uuid)
language sql stable security definer set search_path = '' as $$
  select distinct re.event_id
  from public.registration_entries re
  join public.registrations r on r.id = re.registration_id and r.status = 'paid'
  where r.tournament_id = p_tournament and lower(re.partner_email) = lower(trim(p_email)) and private.cover_unclaimed(re.registration_id, re.event_id, re.partner_paid_cents)
$$;
grant execute on function public.partner_paid_events(uuid, text) to anon, authenticated;

-- offer_waitlist_spot, now pricing an unpaid registration with what it pays
-- for partners (private.registration_amount). Otherwise unchanged.
create or replace function public.offer_waitlist_spot(p_registration uuid, p_event uuid) returns jsonb
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
    v_amount := private.registration_amount(p_registration);
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

-- ---------------------------------------------------------------------------
-- Ledger and withdrawals, with partners' fees
-- ---------------------------------------------------------------------------

-- As before, with what the player paid for each partner on its own line, and
-- the sign-up link for partners who still need to register in the email.
create or replace function private.record_registration_paid() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
  v_partners int;
  v_still text;
  c record;
begin
  if new.status <> 'paid' or (tg_op = 'UPDATE' and old.status = 'paid') then
    return null;
  end if;
  select * into t from public.tournaments where id = new.tournament_id;
  select coalesce(sum(partner_paid_cents), 0) into v_partners from public.registration_entries where registration_id = new.id;
  if new.amount_cents + new.discount_cents - v_partners > 0 then
    insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, created_at)
    values (new.tournament_id, new.player_id, new.id, 'entry_fees', new.amount_cents + new.discount_cents - v_partners, private.clock());
  end if;
  for c in
    select re.*, ev.name as event_name from public.registration_entries re
    join public.events ev on ev.id = re.event_id
    where re.registration_id = new.id and re.partner_paid_cents > 0
    order by ev.sort_order
  loop
    insert into public.ledger_entries (tournament_id, player_id, registration_id, event_id, kind, amount_cents, note, created_at)
    values (new.tournament_id, new.player_id, new.id, c.event_id, 'entry_fees', c.partner_paid_cents,
            'Partner’s entry: ' || coalesce(c.partner_name, c.partner_email) || ', ' || c.event_name, private.clock());
    if private.cover_unclaimed(c.registration_id, c.event_id, c.partner_paid_cents) then
      v_still := coalesce(v_still || ' ', '') || coalesce(c.partner_name, c.partner_email) || ' still needs to register for '
                 || c.event_name || ' (no charge): {url}/t/' || t.id || '/register?event=' || c.event_id;
    end if;
  end loop;
  if new.discount_cents > 0 then
    insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, note, created_at)
    values (new.tournament_id, new.player_id, new.id, 'discount', -new.discount_cents, new.discount_code, private.clock());
  end if;
  if new.amount_cents > 0 then
    insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, method, payment_ref, created_at)
    values (new.tournament_id, new.player_id, new.id, 'payment', -new.amount_cents,
            case when new.payment_provider in ('stripe', 'test') then new.payment_provider else 'other' end,
            new.payment_ref, private.clock());
  end if;
  -- {url} becomes the site address when the message is sent.
  insert into public.notifications (tournament_id, player_id, kind, via, subject, body)
  values (new.tournament_id, new.player_id, 'registration_confirmed', 'email', 'You’re registered for ' || t.name,
          'You’re registered for ' || t.name || '. See your events, or withdraw if you need to: {url}/t/' || t.id
          || '/register/done?r=' || new.id || coalesce(' ' || v_still, ''));
  return null;
end $$;

-- As before, plus partners' fees: an entry a partner paid for credits the
-- payer, not this player; a payer withdrawing before their partner registered
-- gets the partner's fee back too. A team paid for together can't be
-- separated by moving one of them (see move_registration_entry).
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

-- As before, but an entry paid together with a partner who isn't on a team
-- with them yet can't move alone (the payment is for that division).
create or replace function public.move_registration_entry(p_registration uuid, p_from_event uuid, p_to_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
  e public.registration_entries;
  target public.events;
  tm public.teams;
begin
  select * into r from public.registrations where id = p_registration;
  if not found then
    raise exception 'Registration not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(r.tournament_id);
  perform private.lock_tournament(r.tournament_id);
  select * into e from public.registration_entries where registration_id = p_registration and event_id = p_from_event;
  if not found then
    raise exception 'That event isn''t part of this registration' using errcode = 'P0002';
  end if;
  select * into target from public.events where id = p_to_event;
  if not found or target.tournament_id <> r.tournament_id then
    raise exception 'That division isn''t part of this tournament' using errcode = '22023';
  end if;
  if p_from_event = p_to_event then
    return;
  end if;

  if e.team_id is null then
    if e.paid_by_registration_id is not null or (e.partner_paid_cents > 0 and not private.cover_unclaimed(e.registration_id, e.event_id, e.partner_paid_cents)) then
      raise exception 'This entry was paid together with their partner. Pair them as a team first, then move the team.'
        using errcode = '55000';
    end if;
    if exists (select 1 from public.registration_entries where registration_id = p_registration and event_id = p_to_event) then
      raise exception 'Already entered in %', target.name using errcode = '55000';
    end if;
    update public.registration_entries set event_id = p_to_event
    where registration_id = p_registration and event_id = p_from_event;
    if r.status = 'paid' and not e.waitlisted then
      perform private.form_teams(p_registration);
    end if;
    return;
  end if;

  select * into tm from public.teams where id = e.team_id;
  if exists (select 1 from public.matches where tm.id in (team1_id, team2_id)) then
    raise exception '% already has matches. Clear that division’s schedule first, or withdraw the team.', tm.name
      using errcode = '55000';
  end if;
  if target.kind = 'singles' and (select count(*) from public.team_players where team_id = tm.id) > 1 then
    raise exception '% is a singles division', target.name using errcode = '22023';
  end if;
  if exists (
    select 1 from public.registration_entries
    where event_id = p_to_event and registration_id in (
      select registration_id from public.registration_entries where team_id = tm.id
    )
  ) then
    raise exception 'Someone on % is already entered in %', tm.name, target.name using errcode = '55000';
  end if;
  update public.teams set event_id = p_to_event, seed = null, pool = null where id = tm.id;
  update public.registration_entries set event_id = p_to_event where team_id = tm.id and event_id = p_from_event;
end $$;

-- ---------------------------------------------------------------------------
-- What players and admins see
-- ---------------------------------------------------------------------------

-- get_registration, now with who paid for whom and the player's answers.
create or replace function public.get_registration(p_registration uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id,
    'tournament_id', r.tournament_id,
    'tournament_name', t.name,
    'tournament_status', t.status,
    'refund_policy', t.refund_policy,
    'status', r.status,
    'amount_cents', r.amount_cents,
    'discount_cents', r.discount_cents,
    'player_name', p.first_name || ' ' || p.last_name,
    'email', p.email,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', ev.id, 'event_name', ev.name, 'partner_name', re.partner_name,
               'team_id', re.team_id, 'team_name', tm.name, 'waitlisted', re.waitlisted,
               'offered', re.offered_at is not null,
               'partner_paid_cents', re.partner_paid_cents,
               'partner_registered', re.partner_paid_cents > 0 and not private.cover_unclaimed(re.registration_id, re.event_id, re.partner_paid_cents),
               'paid_by_name', (select pp.first_name || ' ' || pp.last_name from public.registrations pr
                                join public.players pp on pp.id = pr.player_id where pr.id = re.paid_by_registration_id))
             order by ev.sort_order)
      from public.registration_entries re
      join public.events ev on ev.id = re.event_id
      left join public.teams tm on tm.id = re.team_id
      where re.registration_id = r.id
    ), '[]'::jsonb),
    'withdrawals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_name', w.event_name, 'withdrawn_at', w.withdrawn_at, 'withdrawn_by', w.withdrawn_by,
               'credit_cents', w.credit_cents, 'partner_paid_cents', w.partner_paid_cents) order by w.id)
      from public.registration_withdrawals w
      where w.registration_id = r.id
    ), '[]'::jsonb),
    'balance', (
      select to_jsonb(b) - 'tournament_id' - 'player_id'
      from public.player_balances b
      where b.tournament_id = r.tournament_id and b.player_id = r.player_id
    ),
    'extra_event_fee_cents', private.extra_event_fee(r),
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object('label', q.label, 'answer', to_jsonb(a.answer)) order by q.sort_order, q.created_at)
      from public.registration_answers a
      join public.registration_questions q on q.id = a.question_id
      where a.registration_id = r.id
    ), '[]'::jsonb)
  )
  from public.registrations r
  join public.tournaments t on t.id = r.tournament_id
  join public.players p on p.id = r.player_id
  where r.id = p_registration
$$;

-- Registrations for the director, now with partners' payments.
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
       r.discount_cents,
       re.partner_paid_cents,
       re.partner_paid_cents > 0 and not private.cover_unclaimed(re.registration_id, re.event_id, re.partner_paid_cents) as partner_registered,
       re.paid_by_registration_id,
       re.paid_by_cents,
       (select pp.first_name || ' ' || pp.last_name from public.registrations pr
        join public.players pp on pp.id = pr.player_id where pr.id = re.paid_by_registration_id) as paid_by_name
from public.registrations r
join public.players p on p.id = r.player_id
join public.registration_entries re on re.registration_id = r.id
join public.events ev on ev.id = re.event_id
left join public.teams tm on tm.id = re.team_id;

-- Withdrawals gained columns; the view picks them up.
create or replace view public.withdrawal_details with (security_invoker = true) as
select w.id, w.registration_id, w.event_id, w.event_name, w.partner_name, w.team_name, w.was_waitlisted,
       w.withdrawn_by, w.credit_cents, w.withdrawn_at,
       r.tournament_id,
       r.player_id,
       r.status,
       p.first_name,
       p.last_name,
       p.email,
       p.phone,
       w.partner_paid_cents,
       w.cover_credit_cents
from public.registration_withdrawals w
join public.registrations r on r.id = w.registration_id
join public.players p on p.id = r.player_id;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table public.registration_questions enable row level security;
alter table public.registration_answers enable row level security;

-- Anyone can read the questions of a tournament they can see (the sign-up
-- form); admins manage them. Answers: admins read; written at registration.
grant select on public.registration_questions to anon, authenticated;
grant insert, update, delete on public.registration_questions to authenticated;
grant select on public.registration_answers to authenticated;
create policy "Questions of visible tournaments" on public.registration_questions for select to anon, authenticated
  using (exists (select 1 from public.tournaments t where t.id = tournament_id));
create policy "Admins manage questions" on public.registration_questions for all to authenticated
  using (public.is_tournament_staff(tournament_id)) with check (public.is_tournament_staff(tournament_id));
create policy "Admins see answers" on public.registration_answers for select to authenticated
  using (exists (select 1 from public.registrations r
                 where r.id = registration_id and public.is_tournament_staff(r.tournament_id)));
