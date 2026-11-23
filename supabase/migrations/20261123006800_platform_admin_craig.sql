-- Another platform admin (see platform_admins).
do $$
begin
  insert into private.platform_admins (user_id)
  select id from auth.users where lower(email) = 'craig@springspickleball.com'
  on conflict do nothing;
  if not exists (select 1 from private.platform_admins a join auth.users u on u.id = a.user_id
                 where lower(u.email) = 'craig@springspickleball.com') then
    raise exception 'No account for craig@springspickleball.com';
  end if;
end $$;
