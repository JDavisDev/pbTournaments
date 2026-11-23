-- Another platform admin (see platform_admins). Adds nothing where the account
-- doesn't exist (local and test databases).
insert into private.platform_admins (user_id)
select id from auth.users where lower(email) = 'craig@springspickleball.com'
on conflict do nothing;
