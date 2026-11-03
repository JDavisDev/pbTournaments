-- Bot sign-ups. Gmail ignores dots, so bots sign up as "a.r.d.a.dkf@gmail.com"
-- (someone's real inbox) to test the form or flood that person with
-- confirmation emails. People rarely write their address with three dots or
-- more, so those are refused before an account is made.
--
-- public.before_user_created is a Supabase Auth hook: turn it on in the
-- dashboard (Authentication → Hooks → Before User Created → Postgres function
-- public.before_user_created). Local mode's sign-up calls it too.

-- Gmail (or googlemail) with three or more dots before the @ (or before a +tag).
create function private.suspicious_signup_email(p_email text) returns boolean
language sql immutable set search_path = '' as $$
  with parts as (
    select split_part(split_part(lower(coalesce(p_email, '')), '@', 1), '+', 1) as name,
           split_part(lower(coalesce(p_email, '')), '@', 2) as domain
  )
  select domain in ('gmail.com', 'googlemail.com') and length(name) - length(replace(name, '.', '')) >= 3
  from parts
$$;

-- Supabase Auth, before it creates an account: {} lets it through, an error refuses it.
create function public.before_user_created(event jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when private.suspicious_signup_email(event -> 'user' ->> 'email') then
      jsonb_build_object('error', jsonb_build_object(
        'http_code', 400,
        'message', 'That email has extra dots in it. Gmail ignores dots, so sign up with your address the way you usually write it.'))
    else '{}'::jsonb
  end
$$;

revoke execute on function public.before_user_created(jsonb) from public, anon, authenticated;
do $$
begin
  -- Only on Supabase: the role Auth runs its hooks as.
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.before_user_created(jsonb) to supabase_auth_admin;
  end if;
end $$;
