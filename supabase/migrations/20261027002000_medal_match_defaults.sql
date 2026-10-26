-- Medal matches by default. A new division plays a bronze match (single
-- elimination: the semifinal losers), one game to 15, and its gold match
-- (the final, or the grand final in double elimination) is best of 3 games
-- to 11. Both win by 2. Directors change either per division
-- (third_place_match, round_formats); existing divisions keep theirs.
alter table public.events
  alter column third_place_match set default true,
  alter column round_formats set default '[
    {"key": "final", "games_to": 11, "best_of": 3, "point_cap": null},
    {"key": "grand_final", "games_to": 11, "best_of": 3, "point_cap": null},
    {"key": "bronze", "games_to": 15, "best_of": 1, "point_cap": null}
  ]'::jsonb;
