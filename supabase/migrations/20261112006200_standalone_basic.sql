-- Basic tournaments can stand alone, with no organization: whoever makes one
-- runs it (as a tournament admin) and can share it like any other. Every
-- other tournament still belongs to an organization, which is where payments
-- (its Stripe account) live.

alter table public.tournaments alter column organization_id drop not null;
alter table public.tournaments
  add constraint tournaments_organization_or_basic check (organization_id is not null or simple);

-- As before (simple_tournaments), and without an organization (outside the
-- demo site) it stands alone instead of getting one.
create or replace function public.new_simple_tournament(p_organization uuid default null) returns public.tournaments
language plpgsql security definer set search_path = '' as $$
declare
  t public.tournaments;
begin
  if auth.uid() is null then
    raise exception 'Sign in to start a tournament' using errcode = '42501';
  end if;
  if p_organization is null and not coalesce((select demo from private.site), false) then
    insert into public.tournaments (organization_id, name, starts_on, created_by, simple)
    values (null, 'New tournament', current_date + 28, auth.uid(), true)
    returning * into t;
    insert into public.tournament_staff (tournament_id, user_id, role) values (t.id, auth.uid(), 'admin');
    insert into public.courts (tournament_id, name, sort_order)
    select t.id, 'Court ' || n, n from generate_series(1, 4) n;
    insert into public.events (tournament_id, name, kind, gender, skill_rule, skill_level,
                               format, pool_count, advance_per_pool)
    values (t.id, 'Mixed Doubles 3.5', 'doubles', 'mixed', 'only', 3.5, 'pools_to_bracket', 1, 4);
  else
    t := public.new_tournament(p_organization);
    update public.tournaments set simple = true where id = t.id;
  end if;
  update public.tournaments
  set texts_enabled = false, checkin_grace_minutes = null,
      entry_fee_cents = 0, extra_event_fee_cents = 0, price_schedule = '[]'::jsonb
  where id = t.id
  returning * into t;
  update public.events
  set name = 'Doubles', gender = 'open', skill_rule = 'open', skill_level = null, skill_level_to = null,
      dupr_rated = false, require_dupr_id = false
  where tournament_id = t.id;
  return t;
end $$;

-- A standalone Basic tournament's admins can delete it (organization
-- tournaments: the organization's owners and admins, as before).
create policy "Standalone tournament admins delete it" on public.tournaments for delete to authenticated
  using (organization_id is null and public.is_tournament_staff(id));

-- As before (delete_account), also counting standalone Basic tournaments they
-- run alone.
create or replace function public.delete_my_account() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_players uuid[];
  v_names text;
begin
  if v_uid is null then
    raise exception 'Log in first' using errcode = '42501';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_email is null then
    raise exception 'A guest account can''t be deleted' using errcode = '42501';
  end if;
  select coalesce(array_agg(p.id), '{}') into v_players
  from public.players p
  where p.user_id = v_uid or lower(p.email) = v_email;

  -- Not while they're still playing somewhere.
  select string_agg(distinct t.name, ', ') into v_names
  from public.tournaments t
  where t.status <> 'complete' and not t.is_demo and (
    exists (select 1 from public.registrations r
            join public.registration_entries re on re.registration_id = r.id
            where r.tournament_id = t.id and r.player_id = any (v_players) and r.status in ('paid', 'waitlisted'))
    or exists (select 1 from public.teams tm
               join public.team_players tp on tp.team_id = tm.id
               where tm.tournament_id = t.id and tp.player_id = any (v_players) and tm.withdrawn_at is null));
  if v_names is not null then
    raise exception 'You’re entered in %. Withdraw first (or ask the director), then delete your account.', v_names
      using errcode = '55000';
  end if;

  -- Or while money is owed either way.
  select string_agg(distinct t.name, ', ') into v_names
  from public.player_balances b
  join public.tournaments t on t.id = b.tournament_id
  where b.player_id = any (v_players) and b.balance_cents <> 0 and not t.is_demo;
  if v_names is not null then
    raise exception 'You have an open balance at %. Settle it with the director first.', v_names using errcode = '55000';
  end if;

  -- Or while they're the only one who can run a tournament that isn't over.
  -- Their organizations' tournaments, and Basic tournaments they run on their own.
  select string_agg(distinct t.name, ', ') into v_names
  from public.tournaments t
  where t.status <> 'complete' and not t.is_demo
    and (exists (select 1 from public.organization_members om where om.organization_id = t.organization_id and om.user_id = v_uid)
         or (t.organization_id is null
             and exists (select 1 from public.tournament_staff s
                         where s.tournament_id = t.id and s.user_id = v_uid and s.role = 'admin')))
    and not exists (select 1 from public.organization_members o
                    where o.organization_id = t.organization_id and o.user_id <> v_uid)
    and not exists (select 1 from public.tournament_staff s
                    where s.tournament_id = t.id and s.user_id <> v_uid and s.role = 'admin');
  if v_names is not null then
    raise exception 'You’re the only one running %. Add another manager first.', v_names using errcode = '55000';
  end if;

  -- Checkouts they never finished.
  update public.registrations set status = 'cancelled' where player_id = any (v_players) and status = 'pending';
  delete from public.registration_answers a
  using public.registrations r
  where a.registration_id = r.id and r.player_id = any (v_players);
  delete from public.notifications where player_id = any (v_players);
  delete from public.push_subscriptions where user_id = v_uid;
  delete from public.tournament_invites where lower(email) = v_email;
  -- Where someone else named them as a partner.
  update public.registration_entries set partner_email = null, partner_name = null where lower(partner_email) = v_email;
  update public.players
  set user_id = null, first_name = 'Deleted', last_name = 'player', email = null, phone = null, sms_opt_in = false,
      gender = null, birth_date = null, dupr_id = null, dupr_doubles = null, dupr_singles = null, self_rating = null,
      rating_checked_at = null
  where id = any (v_players);
  delete from public.organization_members where user_id = v_uid;
  delete from public.tournament_staff where user_id = v_uid;
  return jsonb_build_object('players', cardinality(v_players));
end $$;

