-- What Stripe tells us after a payment, shown to directors (Finance, and each
-- player's details on the Players page) and to players (their profile):
--   * a payment that couldn't be applied: the registration was cancelled,
--     its price changed while checkout was open, or it was already paid.
--     Before, the webhook failed and Stripe retried for days, unseen.
--   * a refund made in the Stripe dashboard instead of here: it goes on the
--     player's ledger like one made here.
--   * a dispute (chargeback), and how it ended. A lost dispute returns the
--     payment to the player, so it goes on their ledger as a refund.
-- Plus the setup fee and player fees: one open checkout at a time, and a
-- duplicate payment or overpayment comes back to the director.

create table public.stripe_notices (
  id bigint generated always as identity primary key,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  registration_id uuid references public.registrations (id) on delete set null,
  player_id uuid references public.players (id) on delete set null,
  kind text not null check (kind in ('unmatched_payment', 'outside_refund', 'dispute')),
  -- Payments and refunds: open until a director dismisses them. Disputes:
  -- open while Stripe decides, then won or lost.
  status text not null default 'open' check (status in ('open', 'resolved', 'won', 'lost')),
  amount_cents int not null,
  stripe_account_id text,
  payment_intent_id text,
  -- The checkout session, refund or dispute: one notice each, so Stripe
  -- sending an event again changes nothing.
  stripe_ref text not null unique,
  detail text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index on public.stripe_notices (tournament_id, created_at desc);
create index on public.stripe_notices (payment_intent_id);

alter table public.stripe_notices enable row level security;
create policy "Admins see Stripe notices" on public.stripe_notices for select to authenticated
  using (public.is_tournament_staff(tournament_id));
grant select on public.stripe_notices to authenticated;

-- ---------------------------------------------------------------------------
-- From the webhook (service role)
-- ---------------------------------------------------------------------------

-- A registration payment that couldn't be applied. The money is in the
-- organization's Stripe account; the director refunds it or sorts it out.
create function public.record_unmatched_payment(
  p_registration uuid, p_session text, p_account text, p_payment_intent text, p_amount_cents int, p_detail text
) returns jsonb
language sql security definer set search_path = '' as $$
  insert into public.stripe_notices (tournament_id, registration_id, player_id, kind, amount_cents, stripe_account_id,
                                     payment_intent_id, stripe_ref, detail)
  select r.tournament_id, r.id, r.player_id, 'unmatched_payment', p_amount_cents, p_account, p_payment_intent, p_session, p_detail
  from public.registrations r where r.id = p_registration
  on conflict (stripe_ref) do nothing
  returning jsonb_build_object('id', id)
$$;

-- A refund Stripe reports. One made here is already on the ledger (same
-- refund id) and is skipped. One of a payment that never applied closes that
-- notice. Otherwise it's a refund from the Stripe dashboard: on the ledger,
-- with a notice. `p_ours`: made here (its recording may have failed).
create function public.record_stripe_refund(
  p_registration uuid, p_account text, p_payment_intent text, p_refund text, p_amount_cents int, p_ours boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
begin
  if exists (select 1 from public.ledger_entries where stripe_refund_id = p_refund) then
    return jsonb_build_object('recorded', false, 'why', 'already');
  end if;
  update public.stripe_notices set status = 'resolved', resolved_at = now()
  where kind = 'unmatched_payment' and payment_intent_id = p_payment_intent and status = 'open';
  if found then
    return jsonb_build_object('recorded', false, 'why', 'unmatched');
  end if;

  select * into r from public.registrations where id = p_registration;
  if not found or r.status <> 'paid' or r.stripe_account_id is distinct from p_account then
    return jsonb_build_object('recorded', false, 'why', 'not ours');
  end if;
  perform private.lock_tournament(r.tournament_id);
  insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, method, payment_ref,
                                     stripe_refund_id, note, created_by, created_at)
  values (r.tournament_id, r.player_id, r.id, 'refund', p_amount_cents, 'stripe', p_refund, p_refund,
          case when p_ours then 'Refunded to card' else 'Refunded in Stripe' end, null, private.clock())
  on conflict (stripe_refund_id) do nothing;
  if not p_ours then
    insert into public.stripe_notices (tournament_id, registration_id, player_id, kind, amount_cents, stripe_account_id,
                                       payment_intent_id, stripe_ref, detail)
    values (r.tournament_id, r.id, r.player_id, 'outside_refund', p_amount_cents, p_account, p_payment_intent, p_refund,
            'Refunded in the Stripe dashboard. It’s on their payments here too.')
    on conflict (stripe_ref) do nothing;
  end if;
  return jsonb_build_object('recorded', true);
end $$;

-- A dispute opened or closed. `p_status` is Stripe's: won and lost end it.
create function public.record_stripe_dispute(
  p_registration uuid, p_account text, p_payment_intent text, p_dispute text, p_amount_cents int, p_status text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
  v_status text := case p_status when 'won' then 'won' when 'lost' then 'lost' else 'open' end;
  v_detail text := 'Disputed by the cardholder' || coalesce(' (' || replace(p_reason, '_', ' ') || ')', '')
                   || case v_status when 'won' then '. You won: the payment stays yours.'
                                    when 'lost' then '. Lost: the payment went back to the player.'
                                    else '. Answer it in your Stripe dashboard before the deadline.' end;
begin
  select * into r from public.registrations where id = p_registration;
  if not found or r.stripe_account_id is distinct from p_account then
    return jsonb_build_object('recorded', false);
  end if;
  insert into public.stripe_notices (tournament_id, registration_id, player_id, kind, status, amount_cents, stripe_account_id,
                                     payment_intent_id, stripe_ref, detail, resolved_at)
  values (r.tournament_id, r.id, r.player_id, 'dispute', v_status, p_amount_cents, p_account, p_payment_intent, p_dispute,
          v_detail, case when v_status <> 'open' then now() end)
  on conflict (stripe_ref) do update
    set status = excluded.status, detail = excluded.detail, resolved_at = excluded.resolved_at, amount_cents = excluded.amount_cents;
  -- Lost: the money went back to the player, like a refund.
  if v_status = 'lost' and r.status = 'paid' then
    perform private.lock_tournament(r.tournament_id);
    insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, method, payment_ref,
                                       stripe_refund_id, note, created_by, created_at)
    values (r.tournament_id, r.player_id, r.id, 'refund', p_amount_cents, 'stripe', p_dispute, p_dispute,
            'Dispute lost: returned to their card', null, private.clock())
    on conflict (stripe_refund_id) do nothing;
  end if;
  return jsonb_build_object('recorded', true, 'status', v_status);
end $$;

-- As before (refunds_fees_finance), but a refund the webhook already
-- recorded (Stripe can report it first) is skipped, not counted twice.
create or replace function public.record_card_refunds(p_tournament uuid, p_player uuid, p_refunds jsonb, p_keep_cents int, p_user uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owed int;
  v_total int;
  v_new jsonb;
begin
  perform private.lock_tournament(p_tournament);
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_new
  from jsonb_array_elements(p_refunds) x
  where not exists (select 1 from public.ledger_entries l where l.stripe_refund_id = x ->> 'refund_id');
  select greatest(0, -coalesce(sum(amount_cents), 0))::int into v_owed
  from public.ledger_entries where tournament_id = p_tournament and player_id = p_player;
  select coalesce(sum((x ->> 'amount_cents')::int), 0) into v_total from jsonb_array_elements(v_new) x;
  if v_total + coalesce(p_keep_cents, 0) > v_owed then
    raise exception 'That’s more than the $% they’re owed', to_char(v_owed / 100.0, 'FM999990.00') using errcode = '22023';
  end if;
  insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, method, payment_ref,
                                     stripe_refund_id, note, created_by, created_at)
  select p_tournament, p_player, (x ->> 'registration_id')::uuid, 'refund', (x ->> 'amount_cents')::int, x ->> 'method',
         x ->> 'refund_id', x ->> 'refund_id', 'Refunded to card', p_user, private.clock()
  from jsonb_array_elements(v_new) x
  on conflict (stripe_refund_id) do nothing;
  if coalesce(p_keep_cents, 0) > 0 then
    insert into public.ledger_entries (tournament_id, player_id, kind, amount_cents, note, created_by, created_at)
    values (p_tournament, p_player, 'fee', p_keep_cents, 'Refund fee', p_user, private.clock());
  end if;
  return jsonb_build_object('refunded_cents', v_total, 'kept_cents', coalesce(p_keep_cents, 0));
end $$;

-- Staff: dismiss a payment or refund notice once it's dealt with.
create function public.resolve_stripe_notice(p_notice bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_tournament uuid;
begin
  select tournament_id into v_tournament from public.stripe_notices where id = p_notice;
  if not found then
    raise exception 'Notice not found' using errcode = 'P0002';
  end if;
  perform private.require_staff(v_tournament);
  update public.stripe_notices set status = 'resolved', resolved_at = now()
  where id = p_notice and status = 'open' and kind <> 'dispute';
end $$;

-- ---------------------------------------------------------------------------
-- The setup fee and player fees: one open checkout at a time
-- ---------------------------------------------------------------------------

create table private.platform_checkouts (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  kind text not null check (kind in ('setup', 'fees')),
  session_id text not null,
  amount_cents int not null,
  created_at timestamptz not null default now(),
  primary key (tournament_id, kind)
);

-- The checkout already started for this fee, if any.
create function public.platform_checkout(p_tournament uuid, p_kind text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('session_id', session_id, 'amount_cents', amount_cents)
  from private.platform_checkouts where tournament_id = p_tournament and kind = p_kind
$$;

create function public.save_platform_checkout(p_tournament uuid, p_kind text, p_session text, p_amount_cents int) returns void
language sql security definer set search_path = '' as $$
  insert into private.platform_checkouts (tournament_id, kind, session_id, amount_cents)
  values (p_tournament, p_kind, p_session, p_amount_cents)
  on conflict (tournament_id, kind) do update
    set session_id = excluded.session_id, amount_cents = excluded.amount_cents, created_at = now()
$$;

-- As before (platform_fees), plus whether an earlier payment already covered
-- it (`duplicate`: this one is extra, to give back). Stripe sending the same
-- payment again isn't a duplicate.
create or replace function public.confirm_setup_payment(p_tournament uuid, p_provider text, p_payment_ref text, p_amount_cents int)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  select * into t from public.tournaments where id = p_tournament for update;
  if not found then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  if t.setup_paid_at is not null then
    return jsonb_build_object('paid', true, 'already', true,
                              'duplicate', t.setup_payment_ref is distinct from p_provider || ':' || p_payment_ref);
  end if;
  if p_amount_cents < private.setup_fee_due(t) then
    raise exception 'Paid % cents but the setup fee is %', p_amount_cents, private.setup_fee_due(t) using errcode = '22023';
  end if;
  update public.tournaments set setup_paid_at = now(), setup_payment_ref = p_provider || ':' || p_payment_ref
  where id = p_tournament;
  return jsonb_build_object('paid', true, 'already', false, 'duplicate', false);
end $$;

-- As before (refunds_fees_finance), but only what's owed counts: anything
-- over (a second checkout, or fewer players by then) is `excess_cents`, to
-- give back. Stripe sending the same payment again records nothing.
create or replace function public.confirm_player_fees_payment(p_tournament uuid, p_provider text, p_payment_ref text, p_amount_cents int)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
  v_owed int;
  v_kept int;
begin
  select * into t from public.tournaments where id = p_tournament for update;
  if not found then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from private.player_fee_payments where payment_ref = p_provider || ':' || p_payment_ref) then
    return jsonb_build_object('paid', true, 'already', true, 'excess_cents', 0);
  end if;
  v_owed := private.player_fees_owed(t);
  v_kept := least(p_amount_cents, v_owed);
  if v_kept > 0 then
    insert into private.player_fee_payments (tournament_id, amount_cents, payment_ref)
    values (p_tournament, v_kept, p_provider || ':' || p_payment_ref);
  end if;
  return jsonb_build_object('paid', true, 'already', false, 'excess_cents', p_amount_cents - v_kept);
end $$;

-- ---------------------------------------------------------------------------
-- Players: their own registrations and where their payments stand
-- ---------------------------------------------------------------------------

create function public.my_registrations()
returns table (registration_id uuid, tournament_id uuid, tournament_name text, starts_on date, status text,
               amount_cents int, paid_at timestamptz, events text[], balance_cents int, refunded_cents int,
               disputed boolean)
language sql stable security definer set search_path = '' as $$
  select r.id, t.id, t.name, t.starts_on, r.status::text, r.amount_cents, r.paid_at,
         coalesce((select array_agg(e.name order by e.sort_order) from public.registration_entries re
                   join public.events e on e.id = re.event_id where re.registration_id = r.id), '{}'),
         coalesce(b.balance_cents, 0), coalesce(b.refunded_cents, 0),
         exists (select 1 from public.stripe_notices n where n.registration_id = r.id and n.kind = 'dispute' and n.status = 'open')
  from public.registrations r
  join public.tournaments t on t.id = r.tournament_id
  join public.players p on p.id = r.player_id
  left join public.player_balances b on b.tournament_id = r.tournament_id and b.player_id = r.player_id
  where auth.uid() is not null
    and (p.user_id = auth.uid() or lower(p.email) = (select lower(u.email) from auth.users u where u.id = auth.uid()))
    and r.status <> 'cancelled'
  order by t.starts_on desc, r.created_at desc
  limit 100
$$;

revoke execute on function public.record_unmatched_payment(uuid, text, text, text, int, text),
                           public.record_stripe_refund(uuid, text, text, text, int, boolean),
                           public.record_stripe_dispute(uuid, text, text, text, int, text, text),
                           public.platform_checkout(uuid, text),
                           public.save_platform_checkout(uuid, text, text, int)
  from public, anon, authenticated;
grant execute on function public.record_unmatched_payment(uuid, text, text, text, int, text),
                          public.record_stripe_refund(uuid, text, text, text, int, boolean),
                          public.record_stripe_dispute(uuid, text, text, text, int, text, text),
                          public.platform_checkout(uuid, text),
                          public.save_platform_checkout(uuid, text, text, int)
  to service_role;
revoke execute on function public.resolve_stripe_notice(bigint), public.my_registrations() from public, anon;
grant execute on function public.resolve_stripe_notice(bigint), public.my_registrations() to authenticated;
