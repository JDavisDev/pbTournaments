-- Standings for one tournament or division, not the whole database; an index
-- for brackets' "Loser of" names; and a pending registration's hold renewed
-- (or refused) when the player goes to pay.

-- As before (standings_tiebreaks), with the same columns and ranking. Its
-- parts were each used more than once, so Postgres worked them out for every
-- tournament before filtering. Now each part is inlined, and the tournament
-- and division travel through the joins, so a filter on tournament_id or
-- event_id reaches the teams and matches scans.
create or replace view public.standings with (security_invoker = true) as
with played as not materialized (
  select m.tournament_id, m.event_id, m.pool, m.team1_id, m.team2_id, m.winner_team_id,
         coalesce((select sum((g ->> 0)::int) from jsonb_array_elements(m.games) g), 0) as points1,
         coalesce((select sum((g ->> 1)::int) from jsonb_array_elements(m.games) g), 0) as points2
  from public.matches m
  where m.stage = 'pool' and m.status = 'completed'
),
per_team as not materialized (
  select tournament_id, event_id, team1_id as team_id, team2_id as opponent_id, winner_team_id = team1_id as won,
         points1 as points_for, points2 as points_against
  from played
  union all
  select tournament_id, event_id, team2_id, team1_id, winner_team_id = team2_id, points2, points1
  from played
),
totals as not materialized (
  select t.id as team_id, t.tournament_id, t.event_id, t.pool, t.name as team_name, t.seed,
         count(pt.team_id)::int as played,
         (count(*) filter (where pt.won))::int as wins,
         (count(*) filter (where not pt.won))::int as losses,
         coalesce(sum(pt.points_for), 0)::int as points_for,
         coalesce(sum(pt.points_against), 0)::int as points_against
  from public.teams t
  left join per_team pt on pt.tournament_id = t.tournament_id and pt.event_id = t.event_id and pt.team_id = t.id
  where t.pool is not null and t.withdrawn_at is null
  group by t.id
),
rated as not materialized (
  select *, case when played > 0 then round(wins::numeric / played, 3) else 0 end as win_pct
  from totals
),
head_to_head as not materialized (
  select a.tournament_id, a.event_id, a.team_id, count(*)::int as wins_vs_tied
  from rated a
  join per_team pt on pt.tournament_id = a.tournament_id and pt.event_id = a.event_id and pt.team_id = a.team_id and pt.won
  join rated b on b.tournament_id = a.tournament_id and b.event_id = a.event_id
              and b.team_id = pt.opponent_id and b.win_pct = a.win_pct
  group by a.tournament_id, a.event_id, a.team_id
)
select tt.tournament_id, tt.event_id, tt.pool, chr(64 + tt.pool) as pool_letter,
       tt.team_id, tt.team_name, tt.seed, tt.played, tt.wins, tt.losses, tt.win_pct,
       tt.points_for, tt.points_against, tt.points_for - tt.points_against as point_diff,
       coalesce(h.wins_vs_tied, 0) as wins_vs_tied,
       row_number() over (
         partition by tt.tournament_id, tt.event_id, tt.pool
         order by tt.win_pct desc, coalesce(h.wins_vs_tied, 0) desc,
                  tt.points_for - tt.points_against desc, tt.points_for desc,
                  tt.seed nulls last, tt.team_name
       )::int as pool_rank
from rated tt
left join head_to_head h on h.tournament_id = tt.tournament_id and h.event_id = tt.event_id and h.team_id = tt.team_id;

-- match_details names a bracket slot "Loser of …" by looking for the match
-- that feeds it; without this each one scanned every match.
create index if not exists matches_loser_to_match_id_idx on public.matches (loser_to_match_id);

-- Before the player pays a pending registration. Its spots are held for 30
-- minutes from when it was made; after that they aren't counted, and someone
-- else may have taken them. Paying later (the Pay button on the registration
-- page, or a waitlist text's link) mustn't overfill a division, so a lapsed
-- hold is renewed only when there's still room. Returns {ok, status, full}:
-- full names what filled up.
create function public.renew_registration_hold(p_registration uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
  t public.tournaments;
  v_full text;
begin
  select * into r from public.registrations where id = p_registration for update;
  if not found then
    raise exception 'Registration not found' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    return jsonb_build_object('ok', false, 'status', r.status);
  end if;

  -- Renewed first, so the counts below include this registration's spots.
  update public.registrations set created_at = private.clock() where id = p_registration;
  if r.created_at > private.clock() - interval '30 minutes' then
    -- Still held: its spots were counted all along.
    return jsonb_build_object('ok', true, 'status', 'pending');
  end if;

  select * into t from public.tournaments where id = r.tournament_id;
  if t.max_players is not null and private.tournament_players_taken(t.id) > t.max_players then
    v_full := t.name;
  end if;
  if v_full is null then
    -- An entry a partner paid for keeps its spot, as at sign-up.
    select ev.name into v_full
    from public.registration_entries re
    join public.events ev on ev.id = re.event_id
    where re.registration_id = p_registration and not re.waitlisted and re.paid_by_registration_id is null
      and ev.max_teams is not null
      and private.event_spots_taken(ev.id) > ev.max_teams * (case when ev.kind = 'doubles' then 2 else 1 end)
    order by ev.sort_order
    limit 1;
  end if;
  if v_full is not null then
    -- No room: the hold stays lapsed.
    update public.registrations set created_at = r.created_at where id = p_registration;
    return jsonb_build_object('ok', false, 'status', 'pending', 'full', v_full);
  end if;
  return jsonb_build_object('ok', true, 'status', 'pending');
end $$;

revoke execute on function public.renew_registration_hold(uuid) from public, anon, authenticated;
grant execute on function public.renew_registration_hold(uuid) to service_role;
