-- What directors pay the platform:
--   * a one-time setup fee per tournament, due before it opens registration
--     or goes live (practice tournaments are free);
--   * a fee per player;
--   * texting per player, unless the director turns texting off.
-- Prices live in one row, private.platform_pricing, so they can change
-- without code: update private.platform_pricing set setup_fee_cents = 2000;

create table private.platform_pricing (
  id boolean primary key default true check (id),
  setup_fee_cents int not null default 1500 check (setup_fee_cents >= 0),
  per_player_cents int not null default 200 check (per_player_cents >= 0),
  texting_per_player_cents int not null default 25 check (texting_per_player_cents >= 0)
);
insert into private.platform_pricing default values;

-- Anyone: the current prices, for the fee screens.
create function public.platform_pricing() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('setup_fee_cents', setup_fee_cents, 'per_player_cents', per_player_cents,
                            'texting_per_player_cents', texting_per_player_cents)
  from private.platform_pricing
$$;
grant execute on function public.platform_pricing() to anon, authenticated;

alter table public.tournaments
  -- Off: no texts at all (court calls, messages, waitlist offers); emails still go.
  add column texts_enabled boolean not null default true,
  add column setup_paid_at timestamptz,
  add column setup_payment_ref text;
grant update (texts_enabled) on public.tournaments to authenticated;

-- Texting off: texts are never created, so they're never sent or charged.
create function private.skip_disabled_texts() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.via = 'sms' and exists (
    select 1 from public.tournaments where id = new.tournament_id and not texts_enabled
  ) then
    return null;
  end if;
  return new;
end $$;

create trigger notifications_skip_disabled_texts
before insert on public.notifications
for each row execute function private.skip_disabled_texts();

-- The setup fee for a tournament: what's due (0 for practice tournaments and
-- ones already paid).
create function private.setup_fee_due(t public.tournaments) returns int
language sql stable set search_path = '' as $$
  select case when t.is_demo or t.setup_paid_at is not null then 0
              else (select setup_fee_cents from private.platform_pricing) end
$$;

-- Opening registration or going live needs the setup fee paid.
create or replace function public.set_tournament_status(p_tournament uuid, p_status public.tournament_status)
returns public.tournaments
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  perform private.require_staff(p_tournament);
  perform private.lock_tournament(p_tournament);
  select * into t from public.tournaments where id = p_tournament;
  if p_status in ('registration', 'live') and private.setup_fee_due(t) > 0 then
    raise exception 'Pay the % setup fee to open this tournament (Setup → Fees)',
      to_char(private.setup_fee_due(t) / 100.0, 'FM$999,990.00') using errcode = '55000';
  end if;
  update public.tournaments set status = p_status where id = p_tournament returning * into t;
  perform private.auto_assign(p_tournament);
  return t;
end $$;

-- Admin: this tournament's platform fees so far. Players = everyone on a
-- team that hasn't withdrawn.
create function public.tournament_fees(p_tournament uuid) returns jsonb
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
    'player_fees_cents', case when t.is_demo then 0
                              else v_players * (p.per_player_cents
                                                + case when t.texts_enabled then p.texting_per_player_cents else 0 end) end
  );
end $$;

-- Server only: the setup fee checkout.
create function public.setup_fee_for_checkout(p_tournament uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('tournament_id', t.id, 'tournament_name', t.name,
                            'amount_cents', private.setup_fee_due(t), 'paid', t.setup_paid_at is not null)
  from public.tournaments t where t.id = p_tournament
$$;

-- Server only (Stripe webhook or test checkout): mark the setup fee paid.
create function public.confirm_setup_payment(p_tournament uuid, p_provider text, p_payment_ref text, p_amount_cents int)
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
    return jsonb_build_object('paid', true, 'already', true);
  end if;
  if p_amount_cents < private.setup_fee_due(t) then
    raise exception 'Paid % cents but the setup fee is %', p_amount_cents, private.setup_fee_due(t) using errcode = '22023';
  end if;
  update public.tournaments set setup_paid_at = now(), setup_payment_ref = p_provider || ':' || p_payment_ref
  where id = p_tournament;
  return jsonb_build_object('paid', true, 'already', false);
end $$;

revoke execute on function public.setup_fee_for_checkout(uuid) from public, anon, authenticated;
revoke execute on function public.confirm_setup_payment(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.setup_fee_for_checkout(uuid), public.confirm_setup_payment(uuid, text, text, int) to service_role;
