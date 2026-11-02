-- Players deleting their own account. Every player record that's theirs
-- (linked to the account, or under its email) loses their details, and the
-- account itself goes (the server deletes the login after this). Registrations,
-- money and results stay for the tournament's books, without their name.

create function public.delete_my_account() returns jsonb
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
  select string_agg(distinct t.name, ', ') into v_names
  from public.organization_members om
  join public.tournaments t on t.organization_id = om.organization_id
  where om.user_id = v_uid and t.status <> 'complete' and not t.is_demo
    and not exists (select 1 from public.organization_members o
                    where o.organization_id = om.organization_id and o.user_id <> v_uid)
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

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
