-- The checkout already started for a registration: its Stripe session and the
-- connected account it runs on. A new checkout closes the old one, so a player
-- can't pay twice, and the webhook only accepts a payment from that account.

-- As before (stripe_connect), plus that checkout.
create or replace function public.registration_for_checkout(p_registration uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.get_registration(p_registration) || jsonb_build_object(
    'stripe_account_id', a.stripe_account_id,
    'payments_ready', coalesce(a.ready, false),
    'platform_fee_cents', private.platform_fee(r),
    'checkout_session_id', case when r.payment_provider = 'stripe' then r.payment_ref end,
    'checkout_account', r.stripe_account_id)
  from public.registrations r
  join public.tournaments t on t.id = r.tournament_id
  left join private.payment_accounts a on a.organization_id = t.organization_id
  where r.id = p_registration
$$;
