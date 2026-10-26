-- A demo database: every tournament made in it is a practice tournament (fast-
-- forward, texts shown on team pages, logged instead of sent, deleted after
-- two weeks), including ones a tester builds from scratch. Off by default.
-- Turn it on for the demo site in the Supabase SQL editor:
--
--   update private.site set demo = true;

create table private.site (
  id boolean primary key default true check (id),
  demo boolean not null default false
);
insert into private.site default values;

create function private.mark_demo_tournament() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.is_demo := new.is_demo or coalesce((select demo from private.site), false);
  return new;
end $$;

create trigger tournaments_mark_demo
before insert on public.tournaments
for each row execute function private.mark_demo_tournament();
