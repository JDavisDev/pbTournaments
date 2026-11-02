-- Refunds to the player's card from Courtside (the Players page), Courtside's
-- fee for players who didn't pay by card, and a tournament's money and player
-- numbers for the Finance page.
--
-- Courtside never loses money on a refund: its fee from the payment stays,
-- and so does Stripe's card fee. The tournament can keep its refund fee too.

-- The Stripe refund behind a card refund on the books.
alter table public.ledger_entries add column stripe_refund_id text unique;

-- Courtside's fee per player in a tournament: per player, plus texting when it's on.
create function private.player_fee_rate(t public.tournaments) returns int
language sql stable set search_path = '' as $$
  select case when t.is_demo then 0
              else pp.per_player_cents + case when t.texts_enabled then pp.texting_per_player_cents else 0 end end
  from private.platform_pricing pp
$$;

-- Players on a team whose fee no card payment covered: added by the director,
-- free entries, paid at the desk. Courtside bills the director for these.
create function private.uncovered_players(p_tournament uuid) returns int
language sql stable set search_path = '' as $$
  select count(distinct tp.player_id)::int
  from public.teams tm
  join public.team_players tp on tp.team_id = tm.id
  join public.tournaments t on t.id = tm.tournament_id
  where tm.tournament_id = p_tournament and tm.withdrawn_at is null and not t.is_demo
    and not exists (select 1 from public.registrations r
                    where r.tournament_id = p_tournament and r.player_id = tp.player_id and r.status = 'paid'
                      and coalesce(r.platform_fee_cents, 0) > 0)
    and not exists (select 1 from public.registrations r
                    join public.registration_entries re on re.registration_id = r.id
                    join public.registrations payer on payer.id = re.paid_by_registration_id
                    where r.tournament_id = p_tournament and r.player_id = tp.player_id and payer.status = 'paid'
                      and coalesce(payer.platform_fee_cents, 0) > 0)
$$;

-- What the director has paid Courtside for those players.
create table private.player_fee_payments (
  id bigint generated always as identity primary key,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  amount_cents int not null check (amount_cents > 0),
  payment_ref text not null unique,
  paid_at timestamptz not null default now()
);

create function private.player_fees_owed(t public.tournaments) returns int
language sql stable set search_path = '' as $$
  select greatest(0, private.uncovered_players(t.id) * private.player_fee_rate(t)
                     - (select coalesce(sum(f.amount_cents), 0)::int from private.player_fee_payments f where f.tournament_id = t.id))
$$;

-- Server only: the checkout for those fees, and its confirmation.
create function public.player_fees_for_checkout(p_tournament uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('tournament_id', t.id, 'tournament_name', t.name, 'amount_cents', private.player_fees_owed(t),
                            'players', private.uncovered_players(t.id))
  from public.tournaments t where t.id = p_tournament
$$;

create function public.confirm_player_fees_payment(p_tournament uuid, p_provider text, p_payment_ref text, p_amount_cents int)
returns jsonb
language sql security definer set search_path = '' as $$
  insert into private.player_fee_payments (tournament_id, amount_cents, payment_ref)
  values (p_tournament, p_amount_cents, p_provider || ':' || p_payment_ref)
  on conflict (payment_ref) do nothing
  returning jsonb_build_object('paid', true)
$$;

-- As before (stripe_connect), plus the fees owed for players not paid by card.
create or replace function public.tournament_fees(p_tournament uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tournaments;
  p private.platform_pricing;
  v_players int;
begin
  perform private.require_staff(p_tournament);
  select * into t from public.tournaments where id = p_tournament;
  select * into p from private.platform_pricing;
  select count(distinct tp.player_id) into v_players
  from public.teams tm join public.team_players tp on tp.team_id = tm.id
  where tm.tournament_id = p_tournament and tm.withdrawn_at is null;
  return jsonb_build_object(
    'is_demo', t.is_demo,
    'setup_fee_cents', p.setup_fee_cents,
    'setup_due_cents', private.setup_fee_due(t),
    'setup_paid_at', t.setup_paid_at,
    'players', v_players,
    'per_player_cents', p.per_player_cents,
    'texting_per_player_cents', p.texting_per_player_cents,
    'texts_enabled', t.texts_enabled,
    'player_fees_cents', case when t.is_demo then 0 else v_players * private.player_fee_rate(t) end,
    'fees_collected_cents', (select coalesce(sum(r.platform_fee_cents), 0)::int from public.registrations r
                             where r.tournament_id = p_tournament and r.status = 'paid'),
    'uncovered_players', private.uncovered_players(p_tournament),
    'fees_owed_cents', private.player_fees_owed(t));
end $$;

-- ---------------------------------------------------------------------------
-- Refunds to card
-- ---------------------------------------------------------------------------

-- Staff: what a player is owed and the card payments it can go back to,
-- newest first, each with what's left to refund on it.
create function public.card_refund_plan(p_tournament uuid, p_player uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff(p_tournament);
  return jsonb_build_object(
    'owed_cents', (select greatest(0, -coalesce(sum(l.amount_cents), 0))::int from public.ledger_entries l
                   where l.tournament_id = p_tournament and l.player_id = p_player),
    'refund_fee_cents', (select t.refund_fee_cents from public.tournaments t where t.id = p_tournament),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'registration_id', r.id, 'provider', r.payment_provider, 'payment_ref', r.payment_ref,
               'stripe_account_id', r.stripe_account_id,
               'refundable_cents', r.amount_cents - coalesce((
                 select sum(l.amount_cents) from public.ledger_entries l
                 where l.registration_id = r.id and l.kind = 'refund' and l.stripe_refund_id is not null), 0))
             order by r.paid_at desc)
      from public.registrations r
      where r.tournament_id = p_tournament and r.player_id = p_player and r.status = 'paid'
        and r.payment_provider in ('stripe', 'test') and r.payment_ref is not null and r.amount_cents > 0
    ), '[]'::jsonb));
end $$;

-- Server only, after the refunds went through: p_refunds = [{registration_id,
-- amount_cents, refund_id, method}]; p_keep_cents is the refund fee kept.
-- Together they can't be more than the player is owed.
create function public.record_card_refunds(p_tournament uuid, p_player uuid, p_refunds jsonb, p_keep_cents int, p_user uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owed int;
  v_total int;
begin
  perform private.lock_tournament(p_tournament);
  select greatest(0, -coalesce(sum(amount_cents), 0))::int into v_owed
  from public.ledger_entries where tournament_id = p_tournament and player_id = p_player;
  select coalesce(sum((x ->> 'amount_cents')::int), 0) into v_total from jsonb_array_elements(p_refunds) x;
  if v_total + coalesce(p_keep_cents, 0) > v_owed then
    raise exception 'That’s more than the $% they’re owed', to_char(v_owed / 100.0, 'FM999990.00') using errcode = '22023';
  end if;
  insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, method, payment_ref,
                                     stripe_refund_id, note, created_by, created_at)
  select p_tournament, p_player, (x ->> 'registration_id')::uuid, 'refund', (x ->> 'amount_cents')::int, x ->> 'method',
         x ->> 'refund_id', x ->> 'refund_id', 'Refunded to card', p_user, private.clock()
  from jsonb_array_elements(p_refunds) x;
  if coalesce(p_keep_cents, 0) > 0 then
    insert into public.ledger_entries (tournament_id, player_id, kind, amount_cents, note, created_by, created_at)
    values (p_tournament, p_player, 'fee', p_keep_cents, 'Refund fee', p_user, private.clock());
  end if;
  return jsonb_build_object('refunded_cents', v_total, 'kept_cents', coalesce(p_keep_cents, 0));
end $$;

-- ---------------------------------------------------------------------------
-- The Finance page
-- ---------------------------------------------------------------------------

create function public.tournament_finance(p_tournament uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  perform private.require_staff(p_tournament);
  select * into t from public.tournaments where id = p_tournament;
  return jsonb_build_object(
    'money', (
      select jsonb_build_object(
        'entry_fees_cents', coalesce(sum(l.amount_cents) filter (where l.kind = 'entry_fees'), 0),
        'discounts_cents', coalesce(-sum(l.amount_cents) filter (where l.kind = 'discount'), 0),
        'card_payments_cents', coalesce(-sum(l.amount_cents) filter (where l.kind = 'payment' and l.method in ('stripe', 'test')), 0),
        'card_payment_count', count(*) filter (where l.kind = 'payment' and l.method in ('stripe', 'test')),
        'desk_payments_cents', coalesce(-sum(l.amount_cents) filter (where l.kind = 'payment' and l.method in ('cash', 'check', 'other')), 0),
        'card_refunds_cents', coalesce(sum(l.amount_cents) filter (where l.kind = 'refund' and l.method in ('stripe', 'test')), 0),
        'other_refunds_cents', coalesce(sum(l.amount_cents) filter (where l.kind = 'refund' and l.method in ('cash', 'check', 'other')), 0),
        'kept_fees_cents', coalesce(sum(l.amount_cents) filter (where l.kind = 'fee'), 0)
      )::jsonb
      from public.ledger_entries l where l.tournament_id = p_tournament),
    'balances', (
      select jsonb_build_object(
        'owed_by_players_cents', coalesce(sum(b.balance_cents) filter (where b.balance_cents > 0), 0),
        'players_owing', count(*) filter (where b.balance_cents > 0),
        'owed_to_players_cents', coalesce(-sum(b.balance_cents) filter (where b.balance_cents < 0), 0),
        'players_owed', count(*) filter (where b.balance_cents < 0))
      from public.player_balances b where b.tournament_id = p_tournament),
    'courtside', jsonb_build_object(
      'from_cards_cents', (select coalesce(sum(r.platform_fee_cents), 0) from public.registrations r
                           where r.tournament_id = p_tournament and r.status = 'paid'),
      'paid_separately_cents', (select coalesce(sum(f.amount_cents), 0) from private.player_fee_payments f
                                where f.tournament_id = p_tournament),
      'owed_cents', private.player_fees_owed(t),
      'uncovered_players', private.uncovered_players(p_tournament),
      'rate_cents', private.player_fee_rate(t)),
    'registrations', (
      select jsonb_build_object(
        'paid', count(*) filter (where r.status = 'paid'),
        'pending', count(*) filter (where r.status = 'pending'),
        'waitlisted', count(*) filter (where r.status = 'waitlisted'),
        'cancelled', count(*) filter (where r.status in ('cancelled', 'refunded')))
      from public.registrations r where r.tournament_id = p_tournament),
    'players', (select count(distinct tp.player_id) from public.teams tm
                join public.team_players tp on tp.team_id = tm.id
                where tm.tournament_id = p_tournament and tm.withdrawn_at is null),
    'withdrawals', (select count(*) from public.registration_withdrawals w
                    join public.registrations r on r.id = w.registration_id
                    where r.tournament_id = p_tournament),
    'divisions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', e.id, 'name', e.name, 'kind', e.kind, 'max_teams', e.max_teams,
               'teams', (select count(*) from public.teams tm where tm.event_id = e.id and tm.withdrawn_at is null),
               'players', (select count(distinct tp.player_id) from public.teams tm
                           join public.team_players tp on tp.team_id = tm.id
                           where tm.event_id = e.id and tm.withdrawn_at is null),
               'waitlisted', (select count(*) from public.registration_entries re where re.event_id = e.id and re.waitlisted),
               'unpaired', (select count(*) from public.registration_entries re
                            join public.registrations r on r.id = re.registration_id
                            where re.event_id = e.id and re.team_id is null and not re.waitlisted and r.status = 'paid'))
             order by e.sort_order, e.name)
      from public.events e where e.tournament_id = p_tournament
    ), '[]'::jsonb));
end $$;

revoke execute on function public.player_fees_for_checkout(uuid), public.confirm_player_fees_payment(uuid, text, text, int),
                           public.record_card_refunds(uuid, uuid, jsonb, int, uuid)
  from public, anon, authenticated;
grant execute on function public.player_fees_for_checkout(uuid), public.confirm_player_fees_payment(uuid, text, text, int),
                          public.record_card_refunds(uuid, uuid, jsonb, int, uuid)
  to service_role;
revoke execute on function public.card_refund_plan(uuid, uuid), public.tournament_finance(uuid) from public, anon;
grant execute on function public.card_refund_plan(uuid, uuid), public.tournament_finance(uuid) to authenticated;
