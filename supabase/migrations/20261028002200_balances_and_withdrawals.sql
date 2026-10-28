-- What each registrant has paid and is owed, withdrawals, and moving an entry
-- to another division.
--
--  * Ledger: one row per money event for a player in a tournament. Entry
--    fees, the discount and the checkout payment are written when a
--    registration is paid; a withdrawal credits what the entry cost; admins
--    record payments at the desk, refunds, fees kept and credits. The sum is
--    the player's balance: above zero they owe the tournament, below zero the
--    tournament owes them.
--  * Withdrawals: players withdraw with their registration link (like
--    get_registration, the id is the key), admins from the registrations
--    screen. A withdrawal never refunds by itself: the tournament's refund
--    policy decides, and an admin records the refund or keeps the money.
--    Withdrawn entries move to registration_withdrawals, so every count of
--    entries (spots, waitlist, pairing) leaves them out without changes.
--  * Each tournament (and each outside listing) has a refund policy that
--    players see before they register and before they withdraw.

alter table public.tournaments add column refund_policy text check (length(refund_policy) <= 5000);
grant update (refund_policy) on public.tournaments to authenticated;

alter table public.tournament_listings add column refund_policy text check (length(refund_policy) <= 2000);
grant insert (refund_policy), update (refund_policy) on public.tournament_listings to authenticated;

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------

create table public.ledger_entries (
  id bigint generated always as identity primary key,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  registration_id uuid references public.registrations (id) on delete set null,
  event_id uuid references public.events (id) on delete set null,
  -- Written by the system: entry_fees, discount, payment (checkout), withdrawal.
  -- Recorded by admins: payment (at the desk), refund, fee, credit.
  kind text not null check (kind in ('entry_fees', 'discount', 'payment', 'withdrawal', 'refund', 'fee', 'credit')),
  -- Positive adds to what the player owes; negative takes off.
  amount_cents int not null,
  -- Payments and refunds: stripe, test, cash, check or other.
  method text check (method in ('stripe', 'test', 'cash', 'check', 'other')),
  -- The Stripe Checkout session for checkout payments.
  payment_ref text,
  note text check (length(note) <= 500),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (case when kind in ('entry_fees', 'refund', 'fee') then amount_cents > 0 else amount_cents < 0 end)
);
create index on public.ledger_entries (tournament_id, player_id);
create index on public.ledger_entries (registration_id);

-- One row per registrant with money on the books. Amounts are positive;
-- balance_cents > 0: the player owes; < 0: the tournament owes them.
create view public.player_balances with (security_invoker = true) as
select l.tournament_id,
       l.player_id,
       coalesce(sum(l.amount_cents) filter (where l.kind = 'entry_fees'), 0)::int as entry_fees_cents,
       coalesce(-sum(l.amount_cents) filter (where l.kind = 'discount'), 0)::int as discount_cents,
       coalesce(-sum(l.amount_cents) filter (where l.kind = 'payment'), 0)::int as paid_cents,
       coalesce(-sum(l.amount_cents) filter (where l.kind = 'withdrawal'), 0)::int as withdrawal_credit_cents,
       coalesce(sum(l.amount_cents) filter (where l.kind = 'refund'), 0)::int as refunded_cents,
       coalesce(sum(l.amount_cents) filter (where l.kind = 'fee'), 0)::int as fees_cents,
       coalesce(-sum(l.amount_cents) filter (where l.kind = 'credit'), 0)::int as credits_cents,
       sum(l.amount_cents)::int as balance_cents
from public.ledger_entries l
group by l.tournament_id, l.player_id;

-- When a registration is paid (checkout, a free entry, a free waitlist spot):
-- its fees, discount and payment go on the ledger, and the player gets an
-- email with their registration link, where they can see it or withdraw.
create function private.record_registration_paid() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  if new.status <> 'paid' or (tg_op = 'UPDATE' and old.status = 'paid') then
    return null;
  end if;
  select * into t from public.tournaments where id = new.tournament_id;
  if new.amount_cents + new.discount_cents > 0 then
    insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, created_at)
    values (new.tournament_id, new.player_id, new.id, 'entry_fees', new.amount_cents + new.discount_cents, private.clock());
  end if;
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
          || '/register/done?r=' || new.id);
  return null;
end $$;

create trigger registration_paid after insert or update of status on public.registrations
for each row execute function private.record_registration_paid();

-- Registrations paid before the ledger existed.
insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, created_at, created_by)
select tournament_id, player_id, id, 'entry_fees', amount_cents + discount_cents, coalesce(paid_at, created_at), null
from public.registrations where status = 'paid' and amount_cents + discount_cents > 0;
insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, note, created_at, created_by)
select tournament_id, player_id, id, 'discount', -discount_cents, discount_code, coalesce(paid_at, created_at), null
from public.registrations where status = 'paid' and discount_cents > 0;
insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, method, payment_ref, created_at, created_by)
select tournament_id, player_id, id, 'payment', -amount_cents,
       case when payment_provider in ('stripe', 'test') then payment_provider else 'other' end,
       payment_ref, coalesce(paid_at, created_at), null
from public.registrations where status = 'paid' and amount_cents > 0;

-- Admins: money handled outside checkout. 'payment' (paid at the desk),
-- 'refund' (paid back, in Stripe or otherwise), 'fee' (kept or charged, like
-- an amount kept under the refund policy) or 'credit' (taken off).
-- p_amount_cents is positive; the kind sets the sign. Refunds can't be more
-- than the player is owed, nor payments more than they owe.
create function public.record_ledger_entry(
  p_tournament uuid, p_player uuid, p_kind text, p_amount_cents int, p_method text default null, p_note text default null
) returns public.ledger_entries
language plpgsql security definer set search_path = '' as $$
declare
  v_balance int;
  l public.ledger_entries;
begin
  perform private.require_staff(p_tournament);
  if not exists (select 1 from public.registrations where tournament_id = p_tournament and player_id = p_player) then
    raise exception 'That player isn''t registered for this tournament' using errcode = 'P0002';
  end if;
  if p_kind not in ('payment', 'refund', 'fee', 'credit') then
    raise exception 'Unknown kind of entry: %', p_kind using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Enter an amount more than $0' using errcode = '22023';
  end if;
  if p_kind in ('payment', 'refund') and coalesce(p_method, '') not in ('stripe', 'cash', 'check', 'other') then
    raise exception 'Choose how the money was paid' using errcode = '22023';
  end if;
  select coalesce(sum(amount_cents), 0) into v_balance
  from public.ledger_entries where tournament_id = p_tournament and player_id = p_player;
  if p_kind = 'refund' and p_amount_cents > -v_balance then
    raise exception 'That’s more than the $% they’re owed', to_char(greatest(0, -v_balance) / 100.0, 'FM999990.00')
      using errcode = '22023';
  end if;
  if p_kind = 'payment' and p_amount_cents > v_balance then
    raise exception 'That’s more than the $% they owe', to_char(greatest(0, v_balance) / 100.0, 'FM999990.00')
      using errcode = '22023';
  end if;
  insert into public.ledger_entries (tournament_id, player_id, kind, amount_cents, method, note, created_at)
  values (p_tournament, p_player, p_kind,
          case when p_kind in ('refund', 'fee') then p_amount_cents else -p_amount_cents end,
          case when p_kind in ('payment', 'refund') then p_method end,
          nullif(trim(p_note), ''), private.clock())
  returning * into l;
  return l;
end $$;

-- ---------------------------------------------------------------------------
-- Withdrawals
-- ---------------------------------------------------------------------------

create table public.registration_withdrawals (
  id bigint generated always as identity primary key,
  registration_id uuid not null references public.registrations (id) on delete cascade,
  event_id uuid references public.events (id) on delete set null,
  event_name text not null,
  partner_name text,
  team_name text,
  -- Waitlisted entries cost nothing, so they're credited nothing.
  was_waitlisted boolean not null,
  withdrawn_by text not null check (withdrawn_by in ('player', 'director')),
  credit_cents int not null default 0,
  withdrawn_at timestamptz not null default now()
);
create index on public.registration_withdrawals (registration_id);

-- Withdrawals with who and where, for admins: someone who withdrew from
-- everything has no entries left in registration_details.
create view public.withdrawal_details with (security_invoker = true) as
select w.*,
       r.tournament_id,
       r.player_id,
       r.status,
       p.first_name,
       p.last_name,
       p.email,
       p.phone
from public.registration_withdrawals w
join public.registrations r on r.id = w.registration_id
join public.players p on p.id = r.player_id;

-- What one more event cost this registration: the extra-event fee, at the
-- early price if it registered early.
create function private.extra_event_fee(r public.registrations) returns int
language sql stable set search_path = '' as $$
  select case when t.early_until > r.created_at
              then coalesce(t.early_extra_event_fee_cents, t.extra_event_fee_cents)
              else t.extra_event_fee_cents end
  from public.tournaments t
  where t.id = r.tournament_id
$$;

-- Drops a team (withdraw_team without the checks): each match it has still
-- to play is forfeited to the opponent. Callers check access and lock the tournament.
create function private.drop_team(p_team uuid) returns int
language plpgsql set search_path = '' as $$
declare
  t public.teams;
  m public.matches;
  v_forfeits int := 0;
begin
  select * into t from public.teams where id = p_team;
  if t.withdrawn_at is not null then
    return 0;
  end if;
  update public.teams set withdrawn_at = private.clock(), checked_in_at = null where id = p_team;
  for m in
    select * from public.matches
    where p_team in (team1_id, team2_id)
      and status in ('queued', 'assigned', 'in_progress')
      and team1_id is not null and team2_id is not null
    order by queue_seq
  loop
    perform private.finish_match(m.id, case when m.team1_id = p_team then m.team2_id else m.team1_id end, null, true);
    v_forfeits := v_forfeits + 1;
  end loop;
  perform private.auto_assign(t.tournament_id);
  return v_forfeits;
end $$;

create or replace function public.withdraw_team(p_team uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  t public.teams;
begin
  select * into t from public.teams where id = p_team;
  if not found then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(t.tournament_id);
  perform private.lock_tournament(t.tournament_id);
  return private.drop_team(p_team);
end $$;

-- Withdraw from one event (p_event) or every event (null). Anyone with the
-- registration id (the player's link) or an admin. A paid entry is credited
-- what it cost: the extra-event fee, or all that's left of the registration
-- for its last event, so credits never add up to more than was paid. The
-- entry's team is dissolved if it has no matches yet (the partner goes back
-- to waiting for a partner), otherwise dropped with its matches forfeited.
-- Returns {credit_cents, withdrawn: [event names]}.
create function public.withdraw_registration(p_registration uuid, p_event uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
  t public.tournaments;
  e record;
  v_by text;
  v_counted int;
  v_left int;
  v_credit int;
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
  if t.status = 'complete' then
    raise exception '% is over' , t.name using errcode = '55000';
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
    if r.status = 'paid' and not e.waitlisted then
      select count(*) into v_counted from public.registration_entries where registration_id = r.id and not waitlisted;
      select r.amount_cents + coalesce(sum(amount_cents), 0) into v_left
      from public.ledger_entries where registration_id = r.id and kind = 'withdrawal';
      v_credit := greatest(0, case when v_counted <= 1 then v_left else least(private.extra_event_fee(r), v_left) end);
      if v_credit > 0 then
        insert into public.ledger_entries (tournament_id, player_id, registration_id, event_id, kind, amount_cents, note, created_at)
        values (t.id, r.player_id, r.id, e.event_id, 'withdrawal', -v_credit, 'Withdrew from ' || e.event_name, private.clock());
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
                                                 was_waitlisted, withdrawn_by, credit_cents, withdrawn_at)
    values (r.id, e.event_id, e.event_name, e.partner_name, e.team_name, e.waitlisted, v_by, v_credit, private.clock());
    delete from public.registration_entries where registration_id = r.id and event_id = e.event_id;
    v_total := v_total + v_credit;
    v_names := v_names || e.event_name;
  end loop;

  if not exists (select 1 from public.registration_entries where registration_id = r.id) then
    -- Out of the tournament: no longer counts toward its player limit.
    update public.registrations set status = 'cancelled' where id = r.id;
  elsif r.status = 'pending' then
    -- Not paid yet: it now costs less.
    update public.registrations
    set amount_cents = greatest(0, public.registration_price(t.id, (
          select count(*)::int from public.registration_entries where registration_id = r.id and not waitlisted
        )) - discount_cents)
    where id = r.id;
  end if;

  insert into public.notifications (tournament_id, player_id, kind, via, subject, body)
  values (t.id, r.player_id, 'withdrawal', 'email', 'You’ve withdrawn from ' || t.name,
          'You’ve withdrawn from ' || array_to_string(v_names, ', ') || ' at ' || t.name || '.'
          || case when v_total > 0
                  then ' Your entry fees of $' || to_char(v_total / 100.0, 'FM999990.00')
                       || ' are credited to you. Any refund follows the tournament’s refund policy.'
                  else '' end);

  return jsonb_build_object('credit_cents', v_total, 'withdrawn', to_jsonb(v_names));
end $$;
grant execute on function public.withdraw_registration(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Moving an entry to another division
-- ---------------------------------------------------------------------------

-- Admins: move a player's entry to another division of the tournament. A
-- team moves whole (partner included), as long as it has no matches yet. A
-- player waiting for a partner may be paired in the new division. Limits and
-- eligibility are the admin's call; the price doesn't change.
create function public.move_registration_entry(p_registration uuid, p_from_event uuid, p_to_event uuid) returns void
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
-- What the player sees on their registration page
-- ---------------------------------------------------------------------------

-- get_registration plus their withdrawals, what they've paid and are owed
-- (across all their registrations here), and the refund policy.
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
               'offered', re.offered_at is not null) order by ev.sort_order)
      from public.registration_entries re
      join public.events ev on ev.id = re.event_id
      left join public.teams tm on tm.id = re.team_id
      where re.registration_id = r.id
    ), '[]'::jsonb),
    'withdrawals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_name', w.event_name, 'withdrawn_at', w.withdrawn_at, 'withdrawn_by', w.withdrawn_by,
               'credit_cents', w.credit_cents) order by w.id)
      from public.registration_withdrawals w
      where w.registration_id = r.id
    ), '[]'::jsonb),
    -- Sum of every money event for this player here; null before they've paid anything.
    'balance', (
      select to_jsonb(b) - 'tournament_id' - 'player_id'
      from public.player_balances b
      where b.tournament_id = r.tournament_id and b.player_id = r.player_id
    ),
    -- What withdrawing from one more event would credit right now.
    'extra_event_fee_cents', private.extra_event_fee(r)
  )
  from public.registrations r
  join public.tournaments t on t.id = r.tournament_id
  join public.players p on p.id = r.player_id
  where r.id = p_registration
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table public.ledger_entries enable row level security;
alter table public.registration_withdrawals enable row level security;

-- Admins read; every write goes through the functions above.
grant select on public.ledger_entries, public.player_balances, public.registration_withdrawals,
  public.withdrawal_details to authenticated;
create policy "Admins see the ledger" on public.ledger_entries for select to authenticated
  using (public.is_tournament_staff(tournament_id));
create policy "Admins see withdrawals" on public.registration_withdrawals for select to authenticated
  using (exists (select 1 from public.registrations r
                 where r.id = registration_id and public.is_tournament_staff(r.tournament_id)));
