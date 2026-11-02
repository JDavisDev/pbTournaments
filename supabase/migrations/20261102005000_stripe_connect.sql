-- Stripe Connect: each organization connects its own Stripe account and
-- players pay into it directly. Courtside's per-player fee (and texting) comes
-- out of each payment as Stripe's application fee.
--
-- The account lives in the private schema: organizations are public.

create table private.payment_accounts (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  stripe_account_id text not null unique,
  -- Stripe says it can take payments (charges_enabled).
  ready boolean not null default false,
  details_submitted boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.registrations
  -- The Stripe account that took the payment, and Courtside's fee from it.
  add column stripe_account_id text,
  add column platform_fee_cents int;

-- Courtside's fee on a registration: per player (the registrant, plus any
-- partner they paid for) and texting, never more than the payment.
create function private.platform_fee(r public.registrations) returns int
language sql stable set search_path = '' as $$
  select coalesce((
    select least(r.amount_cents,
                 (pp.per_player_cents + case when t.texts_enabled then pp.texting_per_player_cents else 0 end)
                 * (1 + (select count(distinct coalesce(lower(re.partner_email), re.event_id::text))
                         from public.registration_entries re
                         where re.registration_id = r.id and re.partner_paid_cents > 0)))::int
    from private.platform_pricing pp, public.tournaments t
    where t.id = r.tournament_id and not t.is_demo
  ), 0)
$$;

-- Owners and admins of the tournament's organization (not tournament
-- managers): payouts go to the organization.
create function private.require_org_admin(p_tournament uuid) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_org uuid;
begin
  select t.organization_id into v_org from public.tournaments t where t.id = p_tournament;
  if not exists (select 1 from public.organization_members m
                 where m.organization_id = v_org and m.user_id = auth.uid() and m.role in ('owner', 'admin')) then
    raise exception 'Only the tournament’s owner can set up payments' using errcode = '42501';
  end if;
  return v_org;
end $$;

-- Staff: whether this tournament can take payments, for Setup.
create function public.payments_status(p_tournament uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tournaments;
  a private.payment_accounts;
begin
  perform private.require_staff(p_tournament);
  select * into t from public.tournaments where id = p_tournament;
  select * into a from private.payment_accounts where organization_id = t.organization_id;
  return jsonb_build_object(
    'connected', a.stripe_account_id is not null,
    'ready', coalesce(a.ready, false),
    'details_submitted', coalesce(a.details_submitted, false),
    'test', a.stripe_account_id like 'acct\_test\_%',
    'account_hint', right(a.stripe_account_id, 4),
    'can_manage', exists (select 1 from public.organization_members m
                          where m.organization_id = t.organization_id and m.user_id = auth.uid()
                            and m.role in ('owner', 'admin')));
end $$;

-- Owner, starting Stripe onboarding: the organization and its account so far.
create function public.payment_account_for_setup(p_tournament uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.require_org_admin(p_tournament);
begin
  return (
    select jsonb_build_object('organization_id', o.id, 'organization_name', o.name,
                              'stripe_account_id', a.stripe_account_id,
                              'email', (select u.email from auth.users u where u.id = auth.uid()))
    from public.organizations o
    left join private.payment_accounts a on a.organization_id = o.id
    where o.id = v_org);
end $$;

-- Server: record the organization's account (onboarding) and what Stripe
-- says about it (onboarding return, account.updated webhook).
create function public.save_payment_account(p_organization uuid, p_account text, p_ready boolean, p_details_submitted boolean)
returns jsonb
language sql security definer set search_path = '' as $$
  insert into private.payment_accounts (organization_id, stripe_account_id, ready, details_submitted)
  values (p_organization, p_account, p_ready, p_details_submitted)
  on conflict (organization_id) do update
  set stripe_account_id = excluded.stripe_account_id, ready = excluded.ready,
      details_submitted = excluded.details_submitted, updated_at = now()
  returning jsonb_build_object('organization_id', organization_id)
$$;

create function public.update_payment_account(p_account text, p_ready boolean, p_details_submitted boolean) returns jsonb
language sql security definer set search_path = '' as $$
  update private.payment_accounts
  set ready = p_ready, details_submitted = p_details_submitted, updated_at = now()
  where stripe_account_id = p_account
  returning jsonb_build_object('organization_id', organization_id)
$$;

create function public.payment_account_for_tournament(p_tournament uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('organization_id', t.organization_id, 'stripe_account_id', a.stripe_account_id)
  from public.tournaments t
  left join private.payment_accounts a on a.organization_id = t.organization_id
  where t.id = p_tournament
$$;

-- As before (registration_and_texts), plus where the money goes: the
-- organization's Stripe account and Courtside's fee.
create or replace function public.registration_for_checkout(p_registration uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.get_registration(p_registration) || jsonb_build_object(
    'stripe_account_id', a.stripe_account_id,
    'payments_ready', coalesce(a.ready, false),
    'platform_fee_cents', private.platform_fee(r))
  from public.registrations r
  join public.tournaments t on t.id = r.tournament_id
  left join private.payment_accounts a on a.organization_id = t.organization_id
  where r.id = p_registration
$$;

-- As before, plus the account the checkout runs on and Courtside's fee.
drop function public.attach_checkout_session(uuid, text);
create function public.attach_checkout_session(p_registration uuid, p_session_id text, p_account text default null,
                                               p_platform_fee_cents int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update public.registrations
  set payment_provider = 'stripe', payment_ref = p_session_id, stripe_account_id = p_account,
      platform_fee_cents = p_platform_fee_cents
  where id = p_registration and status = 'pending';
  return jsonb_build_object('ok', found);
end $$;

-- As before (registration_and_texts), plus Courtside's fee when the checkout
-- didn't note it (the test checkout).
create or replace function public.confirm_registration_payment(
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
      payment_ref = coalesce(p_payment_ref, payment_ref),
      platform_fee_cents = coalesce(platform_fee_cents, private.platform_fee(r))
  where id = p_registration;
  perform private.form_teams(p_registration);
  return jsonb_build_object('status', 'paid', 'already', false);
end $$;

-- As before (platform_fees), plus Courtside's fees taken from payments so far.
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
    'player_fees_cents', case when t.is_demo then 0
                              else v_players * (p.per_player_cents
                                                + case when t.texts_enabled then p.texting_per_player_cents else 0 end) end,
    'fees_collected_cents', (select coalesce(sum(r.platform_fee_cents), 0)::int from public.registrations r
                             where r.tournament_id = p_tournament and r.status = 'paid'));
end $$;

revoke execute on function public.save_payment_account(uuid, text, boolean, boolean),
                           public.update_payment_account(text, boolean, boolean),
                           public.payment_account_for_tournament(uuid),
                           public.attach_checkout_session(uuid, text, text, int)
  from public, anon, authenticated;
grant execute on function public.save_payment_account(uuid, text, boolean, boolean),
                          public.update_payment_account(text, boolean, boolean),
                          public.payment_account_for_tournament(uuid),
                          public.attach_checkout_session(uuid, text, text, int)
  to service_role;
revoke execute on function public.payments_status(uuid), public.payment_account_for_setup(uuid) from public, anon;
grant execute on function public.payments_status(uuid), public.payment_account_for_setup(uuid) to authenticated;
