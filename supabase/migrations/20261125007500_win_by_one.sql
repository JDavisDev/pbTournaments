-- Win by 1: a cap equal to the game score ("to 11, cap 11") ends the game at
-- 11 even when won by 1. Describe it that way: "one game to 11, win by 1",
-- not "win by 2, cap 11". Otherwise as before (20261024000300_views).
create or replace function public.describe_format(p_games_to int, p_best_of int, p_point_cap int) returns text
language sql immutable set search_path = '' as $$
  select case when p_best_of = 1 then 'one game' else 'best of ' || p_best_of || ' games' end
         || ' to ' || p_games_to
         || case when p_point_cap = p_games_to then ', win by 1'
                 else ', win by 2' || case when p_point_cap is not null then ', cap ' || p_point_cap else '' end end
$$;
