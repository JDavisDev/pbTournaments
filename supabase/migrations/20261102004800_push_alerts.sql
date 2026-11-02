-- Match alerts as push notifications to a player's phone, from the site added
-- to their Home Screen. Each phone subscribes for a signed-in account; texts
-- for that account's players go there instead when it does.

create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz
);
create index on public.push_subscriptions (user_id);
-- Only through the functions below.
alter table public.push_subscriptions enable row level security;

-- Signed in: this phone gets the account's match alerts. A phone that was
-- someone else's moves to this account.
create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Log in to get match alerts' using errcode = '42501';
  end if;
  if p_endpoint !~ '^https://' then
    raise exception 'Not a push address' using errcode = '22023';
  end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create function public.delete_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

-- Signed in: this account's phones, for a test alert.
create function public.my_push_subscriptions() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
  from public.push_subscriptions s
  where s.user_id = auth.uid()
$$;

-- Server: the phones for a player, through the account linked to them or
-- signed in with their email (as for self check-in).
create function public.push_targets(p_player uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
  from public.players p
  join auth.users u on u.id = p.user_id or (p.email is not null and lower(u.email) = lower(p.email))
  join public.push_subscriptions s on s.user_id = u.id
  where p.id = p_player
$$;

-- Server: after sending. Phones the push service says are gone are removed.
-- p_sent, p_gone: JSON arrays of endpoints.
create function public.push_sent(p_sent jsonb, p_gone jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  with gone as (delete from public.push_subscriptions
                where endpoint in (select jsonb_array_elements_text(p_gone)) returning 1),
       sent as (update public.push_subscriptions set last_sent_at = now()
                where endpoint in (select jsonb_array_elements_text(p_sent)) returning 1)
  select jsonb_build_object('gone', (select count(*) from gone), 'sent', (select count(*) from sent))
$$;

-- As before (registration_and_texts), plus the player and tournament, so the
-- sender can find the player's phones and link to the tournament.
create or replace function public.claim_notifications(p_limit int default 50) returns jsonb
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
           'phone', p.phone, 'sms_opt_in', p.sms_opt_in, 'email', p.email, 'report_code', m.report_code,
           'player_id', c.player_id, 'tournament_id', c.tournament_id
         ) order by c.id), '[]'::jsonb)
  into v_rows
  from claimed c
  join public.players p on p.id = c.player_id
  left join public.matches m on m.id = c.match_id;
  return v_rows;
end $$;

revoke execute on function public.push_targets(uuid) from public, anon, authenticated;
revoke execute on function public.push_sent(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.claim_notifications(int) from public, anon, authenticated;
revoke execute on function public.save_push_subscription(text, text, text) from public, anon;
revoke execute on function public.delete_push_subscription(text) from public, anon;
revoke execute on function public.my_push_subscriptions() from public, anon;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;
grant execute on function public.my_push_subscriptions() to authenticated;
grant execute on function public.push_targets(uuid), public.push_sent(jsonb, jsonb) to service_role;
