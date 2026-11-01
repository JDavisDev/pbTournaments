-- One kind of account. The same login registers for tournaments and runs them:
-- whoever creates a tournament owns it, and its managers are added by email.
-- A player's profile is their own players row (user_id).

-- As before (staff_and_registration), without practice tournaments being open
-- to everyone signed in: then every account would direct every practice
-- tournament and nobody could try one as a player. The demo's shared guest
-- account still runs its own, as a member of the organization that holds them.
create or replace function public.is_tournament_staff(p_tournament uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tournament_staff s
    where s.tournament_id = p_tournament and s.user_id = auth.uid() and s.role = 'admin'
  ) or exists (
    select 1 from public.tournaments t
    join public.organization_members om on om.organization_id = t.organization_id
    where t.id = p_tournament and om.user_id = auth.uid()
  )
$$;

-- As before (quick_setup), and any account can create a tournament: without an
-- organization it gets one of its own, which it owns.
create or replace function public.new_tournament(p_organization uuid default null) returns public.tournaments
language plpgsql security definer set search_path = '' as $$
declare
  v_demo boolean := coalesce((select demo from private.site), false);
  v_org uuid := p_organization;
  v_number int;
  t public.tournaments;
begin
  if auth.uid() is null then
    raise exception 'Sign in to start a tournament' using errcode = '42501';
  end if;
  if v_org is null then
    select organization_id into v_org from public.organization_members where user_id = auth.uid() limit 1;
    if v_org is null then
      v_org := (public.create_organization(
        case when v_demo then 'Demo Club'
             else coalesce((select first_name || ' ' || last_name from public.players where user_id = auth.uid()),
                           (select split_part(email, '@', 1) from auth.users where id = auth.uid()), 'My') || ' Tournaments' end,
        case when v_demo then 'demo-' else 'org-' end || substr(md5(random()::text), 1, 8)
      )).id;
    end if;
  end if;

  if v_demo then
    select count(*) + 1 into v_number from public.tournaments where organization_id = v_org and name like 'Demo #%';
    t := public.create_tournament(v_org, 'Demo #' || v_number, (now() at time zone 'America/New_York')::date, 4);
    update public.tournaments
    set entry_fee_cents = 4250, extra_event_fee_cents = 1550, location = 'Demo Pickleball Center'
    where id = t.id;
  else
    -- Placeholders: Setup asks for the real name and date.
    t := public.create_tournament(v_org, 'New tournament', current_date + 28, 4);
  end if;

  insert into public.events (tournament_id, name, kind, gender, skill_rule, skill_level,
                             format, pool_count, advance_per_pool)
  values (t.id, 'Mixed Doubles 3.5', 'doubles', 'mixed', 'only', 3.5, 'pools_to_bracket', 1, 4);

  select * into t from public.tournaments where id = t.id;
  return t;
end $$;

-- As before (staff_and_registration), saying who owns it.
drop function public.tournament_team(uuid);
create function public.tournament_team(p_tournament uuid)
returns table (email text, role text, source text, is_me boolean, is_owner boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff(p_tournament);
  return query
  select u.email::text, 'admin'::text, 'organization'::text, u.id = auth.uid(), u.id = t.created_by
  from public.tournaments t
  join public.organization_members om on om.organization_id = t.organization_id
  join auth.users u on u.id = om.user_id
  where t.id = p_tournament
  union all
  select u.email::text, s.role, 'tournament'::text, u.id = auth.uid(), false
  from public.tournament_staff s join auth.users u on u.id = s.user_id
  where s.tournament_id = p_tournament
  union all
  select i.email, i.role, 'invite'::text, false, false
  from public.tournament_invites i where i.tournament_id = p_tournament;
end $$;

-- Signed-in user: the tournaments they run. role: 'owner' (created it), 'admin'
-- (a manager, or in its organization) or 'monitor'.
create function public.my_tournaments()
returns table (id uuid, name text, starts_on date, status public.tournament_status, role text)
language sql stable security definer set search_path = '' as $$
  select t.id, t.name, t.starts_on, t.status,
         case when t.created_by = auth.uid() then 'owner'
              when exists (select 1 from public.organization_members om
                           where om.organization_id = t.organization_id and om.user_id = auth.uid()) then 'admin'
              else (select s.role from public.tournament_staff s where s.tournament_id = t.id and s.user_id = auth.uid())
         end
  from public.tournaments t
  where public.is_court_monitor(t.id)
  order by t.starts_on desc, t.name
  limit 100
$$;

-- Signed-in user: their profile, or null if they haven't filled one in.
create function public.get_my_profile() returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(p) - 'id' - 'user_id' - 'added_by' - 'created_at'
  from public.players p where p.user_id = auth.uid()
$$;

-- Signed-in user: saves their profile. Their email is always their login's.
create function public.save_my_profile(p_profile jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_first text := nullif(trim(p_profile ->> 'first_name'), '');
  v_last text := nullif(trim(p_profile ->> 'last_name'), '');
  v_gender text := nullif(p_profile ->> 'gender', '');
begin
  if auth.uid() is null then
    raise exception 'Log in to save your profile' using errcode = '42501';
  end if;
  if v_first is null or v_last is null then
    raise exception 'Enter your first and last name' using errcode = '22023';
  end if;
  if v_gender not in ('male', 'female') then
    raise exception 'Unknown gender' using errcode = '22023';
  end if;
  insert into public.players (user_id, first_name, last_name, email, phone, sms_opt_in, gender, birth_date,
                              dupr_id, dupr_doubles, dupr_singles, self_rating, added_by)
  values (auth.uid(), v_first, v_last, (select lower(email) from auth.users where id = auth.uid()),
          nullif(trim(p_profile ->> 'phone'), ''), coalesce((p_profile ->> 'sms_opt_in')::boolean, false), v_gender,
          nullif(p_profile ->> 'birth_date', '')::date, upper(nullif(trim(p_profile ->> 'dupr_id'), '')),
          nullif(p_profile ->> 'dupr_doubles', '')::numeric, nullif(p_profile ->> 'dupr_singles', '')::numeric,
          nullif(p_profile ->> 'self_rating', '')::numeric, auth.uid())
  on conflict (user_id) do update
  set first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email,
      phone = excluded.phone, sms_opt_in = excluded.sms_opt_in, gender = excluded.gender,
      birth_date = excluded.birth_date, dupr_id = excluded.dupr_id, dupr_doubles = excluded.dupr_doubles,
      dupr_singles = excluded.dupr_singles, self_rating = excluded.self_rating;
  return public.get_my_profile();
end $$;
