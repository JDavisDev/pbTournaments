-- A division's notes for its players, on its player guide (the page that
-- explains how the division runs before it starts): warm-up, ball, which
-- courts, anything the director would otherwise say in the morning.
alter table public.events
  add column player_notes text check (length(player_notes) <= 5000);
grant update (player_notes) on public.events to authenticated;
