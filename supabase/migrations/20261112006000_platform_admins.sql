-- Platform admins: Courtside's own people. Tournaments in an organization a
-- platform admin owns are free with every feature: no setup fee and no
-- per-player fee (so no application fee comes out of players' payments).

create table private.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

-- Add more with: insert into private.platform_admins (user_id) select id from auth.users where email = '…';
insert into private.platform_admins (user_id)
select id from auth.users where lower(email) = 'jdavisdev@gmail.com'
on conflict do nothing;

create function private.fees_waived(t public.tournaments) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.organization_members m
                 join private.platform_admins a on a.user_id = m.user_id
                 where m.organization_id = t.organization_id and m.role = 'owner')
$$;

-- As before (simple_tournaments), plus platform admins' tournaments.
create or replace function private.setup_fee_due(t public.tournaments) returns int
language sql stable set search_path = '' as $$
  select case when t.is_demo or t.simple or t.setup_paid_at is not null or private.fees_waived(t) then 0
              else (select setup_fee_cents from private.platform_pricing) end
$$;

-- As before (simple_tournaments), plus platform admins' tournaments.
create or replace function private.player_fee_rate(t public.tournaments) returns int
language sql stable set search_path = '' as $$
  select case when t.is_demo or t.simple or private.fees_waived(t) then 0
              else pp.per_player_cents + case when t.texts_enabled then pp.texting_per_player_cents else 0 end end
  from private.platform_pricing pp
$$;

-- As before (simple_tournaments), not counting platform admins' tournaments.
create or replace function private.uncovered_players(p_tournament uuid) returns int
language sql stable set search_path = '' as $$
  select count(distinct tp.player_id)::int
  from public.teams tm
  join public.team_players tp on tp.team_id = tm.id
  join public.tournaments t on t.id = tm.tournament_id
  where tm.tournament_id = p_tournament and tm.withdrawn_at is null and not t.is_demo and not t.simple
    and not private.fees_waived(t)
    and not exists (select 1 from public.registrations r
                    where r.tournament_id = p_tournament and r.player_id = tp.player_id and r.status = 'paid'
                      and coalesce(r.platform_fee_cents, 0) > 0)
    and not exists (select 1 from public.registrations r
                    join public.registration_entries re on re.registration_id = r.id
                    join public.registrations payer on payer.id = re.paid_by_registration_id
                    where r.tournament_id = p_tournament and r.player_id = tp.player_id and payer.status = 'paid'
                      and coalesce(payer.platform_fee_cents, 0) > 0)
$$;

-- As before (refunds_fees_finance), plus fees_waived for Setup → Fees.
create or replace function public.tournament_fees(p_tournament uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tournaments;
  p private.platform_pricing;
  v_players int;
begin
  perform private.require_staff(p_tournament);
  select * into t from public.tournaments where id = p_tournament;
  select * into p from private.platform_pricing;
  select count(distinct tp.player_id) into v_players
  from public.teams tm join public.team_players tp on tp.team_id = tm.id
  where tm.tournament_id = p_tournament and tm.withdrawn_at is null;
  return jsonb_build_object(
    'is_demo', t.is_demo,
    'fees_waived', private.fees_waived(t),
    'setup_fee_cents', p.setup_fee_cents,
    'setup_due_cents', private.setup_fee_due(t),
    'setup_paid_at', t.setup_paid_at,
    'players', v_players,
    'per_player_cents', p.per_player_cents,
    'texting_per_player_cents', p.texting_per_player_cents,
    'texts_enabled', t.texts_enabled,
    'player_fees_cents', case when t.is_demo then 0 else v_players * private.player_fee_rate(t) end,
    'fees_collected_cents', (select coalesce(sum(r.platform_fee_cents), 0)::int from public.registrations r
                             where r.tournament_id = p_tournament and r.status = 'paid'),
    'uncovered_players', private.uncovered_players(p_tournament),
    'fees_owed_cents', private.player_fees_owed(t));
end $$;
