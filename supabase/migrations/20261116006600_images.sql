-- Tournament and listing images move out of their rows. They were data URLs
-- in tournaments.image_data and tournament_listings.image_data, so every read
-- of a tournament (each live reload) and every list of them carried the
-- pictures too. Now each image is its own row, served at /api/images/<id>
-- with long-lived caching (a changed image gets a new id); the tournament or
-- listing keeps only image_id. No storage service to set up.

create table private.images (
  id uuid primary key default gen_random_uuid(),
  content_type text not null check (content_type ~ '^image/(jpeg|png|webp|gif|svg\+xml)$'),
  -- Base64.
  data text not null check (length(data) < 1500000),
  created_at timestamptz not null default now()
);

alter table public.tournaments add column image_id uuid references private.images (id) on delete set null;
alter table public.tournament_listings add column image_id uuid references private.images (id) on delete set null;

-- Saves a data URL as an image. Uploads are photos (the app sends JPEG); SVG
-- only comes from the local demo's sample flyers, written directly.
create function private.save_image(p_data text) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_type text := substring(p_data from '^data:(image/(?:jpeg|png|webp|gif));base64,');
  v_id uuid;
begin
  if v_type is null then
    raise exception 'Choose a JPEG, PNG, WebP or GIF image' using errcode = '22023';
  end if;
  if length(p_data) >= 1500000 then
    raise exception 'That image is too big' using errcode = '22023';
  end if;
  insert into private.images (content_type, data)
  values (v_type, substring(p_data from position(',' in p_data) + 1))
  returning id into v_id;
  return v_id;
end $$;

-- Existing images move over.
do $$
declare
  r record;
  v_id uuid;
begin
  for r in select id, image_data from public.tournaments where image_data is not null loop
    insert into private.images (content_type, data)
    values (coalesce(substring(r.image_data from '^data:([^;,]+)'), 'image/jpeg'),
            substring(r.image_data from position(',' in r.image_data) + 1))
    returning id into v_id;
    update public.tournaments set image_id = v_id where id = r.id;
  end loop;
  for r in select id, image_data from public.tournament_listings where image_data is not null loop
    insert into private.images (content_type, data)
    values (coalesce(substring(r.image_data from '^data:([^;,]+)'), 'image/jpeg'),
            substring(r.image_data from position(',' in r.image_data) + 1))
    returning id into v_id;
    update public.tournament_listings set image_id = v_id where id = r.id;
  end loop;
end $$;

alter table public.tournaments drop column image_data;
alter table public.tournament_listings drop column image_data;

-- A removed tournament or listing takes its image with it.
create function private.delete_owned_image() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.images where id = old.image_id;
  return null;
end $$;

create trigger tournaments_delete_image after delete on public.tournaments
  for each row when (old.image_id is not null) execute function private.delete_owned_image();
create trigger tournament_listings_delete_image after delete on public.tournament_listings
  for each row when (old.image_id is not null) execute function private.delete_owned_image();

-- Staff: set or remove (null) the tournament's image. Returns its new id.
create function public.set_tournament_image(p_tournament uuid, p_data text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_old uuid;
  v_new uuid;
begin
  perform private.require_staff(p_tournament);
  select image_id into v_old from public.tournaments where id = p_tournament for update;
  if p_data is not null then
    v_new := private.save_image(p_data);
  end if;
  update public.tournaments set image_id = v_new where id = p_tournament;
  delete from private.images where id = v_old;
  return v_new;
end $$;

-- The listing's poster: set or remove (null) its image. Returns its new id.
create function public.set_listing_image(p_listing uuid, p_data text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_old uuid;
  v_new uuid;
begin
  select image_id into v_old from public.tournament_listings
  where id = p_listing and created_by = auth.uid()
  for update;
  if not found then
    raise exception 'Only the person who posted this listing can change it' using errcode = '42501';
  end if;
  if p_data is not null then
    v_new := private.save_image(p_data);
  end if;
  update public.tournament_listings set image_id = v_new where id = p_listing;
  delete from private.images where id = v_old;
  return v_new;
end $$;

-- An image for /api/images/<id>: anyone with its id may see it, like the
-- page it's on.
create function public.image_file(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('content_type', content_type, 'data', data) from private.images where id = p_id
$$;

revoke execute on function public.set_tournament_image(uuid, text), public.set_listing_image(uuid, text) from public, anon;
grant execute on function public.set_tournament_image(uuid, text), public.set_listing_image(uuid, text) to authenticated;
grant execute on function public.image_file(uuid) to anon, authenticated, service_role;
