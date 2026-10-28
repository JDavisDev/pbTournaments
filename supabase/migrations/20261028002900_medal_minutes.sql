-- The Planner's expected length for a division's gold and bronze matches,
-- often longer than other bracket matches (best of 3, games to 15). Null =
-- the bracket match length.
alter table public.events
  add column gold_match_minutes int check (gold_match_minutes between 5 and 180),
  add column bronze_match_minutes int check (bronze_match_minutes between 5 and 180);

grant update (gold_match_minutes, bronze_match_minutes) on public.events to authenticated;
