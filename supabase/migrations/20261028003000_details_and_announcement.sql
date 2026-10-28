-- A tournament's details (everything players should know: parking, food,
-- format notes) and a short announcement for last-minute changes, shown at
-- the top of the tournament's pages. announcement_at: when it last changed.
alter table public.tournaments
  add column details text check (length(details) <= 10000),
  add column announcement text check (length(announcement) <= 500),
  add column announcement_at timestamptz;

grant update (details, announcement) on public.tournaments to authenticated;

create function private.stamp_announcement() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.announcement := nullif(btrim(new.announcement), '');
  if new.announcement is distinct from old.announcement then
    new.announcement_at := case when new.announcement is null then null else now() end;
  end if;
  return new;
end $$;

create trigger tournaments_stamp_announcement
before update of announcement on public.tournaments
for each row execute function private.stamp_announcement();
