-- Tournament listings: tournaments that take sign-ups somewhere else
-- (PickleballTournaments.com, a club's own site), posted so players can find
-- them here. A listing is a name, dates, a place, an image and the sign-up
-- link players go to. Anyone signed in can post one; only they can change it.

create table public.tournament_listings (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  starts_on date not null,
  -- Null for a one-day tournament.
  ends_on date check (ends_on >= starts_on),
  -- The listing shows until this day is over.
  last_day date generated always as (coalesce(ends_on, starts_on)) stored,
  venue text check (length(venue) <= 120),
  city text not null check (length(trim(city)) between 1 and 80),
  -- Two-letter code, e.g. 'TX'.
  state text not null check (state ~ '^[A-Z]{2}$'),
  signup_url text not null check (signup_url ~* '^https?://[^\s/]+\.[^\s]+$' and length(signup_url) <= 2000),
  -- A logo or flyer as a data URL, kept small by the browser.
  image_data text check (length(image_data) < 1500000),
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index on public.tournament_listings (state, last_day);
create index on public.tournament_listings (created_by);

alter table public.tournament_listings enable row level security;

grant select on public.tournament_listings to anon, authenticated;
-- created_by always comes from its default: the poster.
grant insert (name, starts_on, ends_on, venue, city, state, signup_url, image_data),
  update (name, starts_on, ends_on, venue, city, state, signup_url, image_data)
  on public.tournament_listings to authenticated;
grant delete on public.tournament_listings to authenticated;

create policy "Listings are public" on public.tournament_listings for select to anon, authenticated
  using (true);
create policy "Signed-in users post listings" on public.tournament_listings for insert to authenticated
  with check (created_by = auth.uid());
create policy "Posters edit their listings" on public.tournament_listings for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy "Posters delete their listings" on public.tournament_listings for delete to authenticated
  using (created_by = auth.uid());
