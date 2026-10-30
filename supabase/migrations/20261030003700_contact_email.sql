-- The tournament's contact email: players reach the organizer from its
-- pages (Contact). A new tournament starts with its creator's email;
-- directors change or clear it in Settings → Basics.
alter table public.tournaments
  add column contact_email text check (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
grant update (contact_email) on public.tournaments to authenticated;

create function private.default_contact_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.contact_email is null and new.created_by is not null then
    select u.email into new.contact_email from auth.users u where u.id = new.created_by;
  end if;
  return new;
end $$;

create trigger tournaments_default_contact_email
  before insert on public.tournaments
  for each row execute function private.default_contact_email();

-- Tournaments so far: their creator's email.
update public.tournaments t
set contact_email = u.email
from auth.users u
where u.id = t.created_by and t.contact_email is null and not t.is_demo;
