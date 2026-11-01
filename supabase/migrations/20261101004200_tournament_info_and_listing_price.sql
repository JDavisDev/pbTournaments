-- What players look for when choosing a tournament. Tournaments gain a state
-- (so they can be found by state alongside listings) and the ball used.
-- Listings gain a price for one event, as their poster gives it: their fees
-- live on another site.

alter table public.tournaments
  add column state text check (state ~ '^[A-Z]{2}$'),
  add column ball text check (length(ball) <= 120);
grant update (state, ball) on public.tournaments to authenticated;

alter table public.tournament_listings add column price_cents int check (price_cents >= 0);
grant insert (price_cents), update (price_cents) on public.tournament_listings to authenticated;
