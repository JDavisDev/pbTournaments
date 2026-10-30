-- Timeouts, per division: how many each team gets per game, and how long
-- each lasts. Shown on the division's player guide.
alter table public.events
  add column timeouts_per_game smallint not null default 2 check (timeouts_per_game between 0 and 9),
  add column timeout_minutes smallint not null default 1 check (timeout_minutes between 1 and 10);
grant update (timeouts_per_game, timeout_minutes) on public.events to authenticated;
