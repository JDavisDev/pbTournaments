-- Who can read and write what through the API (website and mobile apps).
--
-- Supabase grants anon/authenticated full table access by default and relies
-- on row-level security. Here we revoke that and grant back only what each
-- role needs, so engine-owned columns (match status and queue, check-in
-- times, court status) only change through the court_engine functions.
-- New tables in later migrations need their own grants.

revoke all on all tables in schema public from anon, authenticated;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.tournaments enable row level security;
alter table public.tournament_staff enable row level security;
alter table public.events enable row level security;
alter table public.players enable row level security;
alter table public.teams enable row level security;
alter table public.team_players enable row level security;
alter table public.courts enable row level security;
alter table public.matches enable row level security;
alter table public.tournament_live enable row level security;
alter table public.notifications enable row level security; -- service role only

-- Public pages: anyone can read organizations, and tournaments once they're
-- out of draft (with their events, teams, courts and matches).
grant select on public.organizations, public.tournaments, public.events, public.teams,
  public.team_players, public.courts, public.tournament_live,
  public.court_board, public.match_details, public.standings to anon, authenticated;
-- Every match column except report_code, the private link in players' texts.
grant select (id, tournament_id, event_id, stage, pool, round, position, label, team1_id, team2_id,
              team1_seed, team2_seed, winner_to_match_id, winner_to_slot, wave, queue_seq, on_hold,
              status, court_id, queued_at, assigned_at, started_at, completed_at, games,
              winner_team_id, forfeit, side, round_key, loser_to_match_id, loser_to_slot,
              team1_bye, team2_bye, is_bye)
  on public.matches to anon, authenticated;
grant select on public.organization_members, public.tournament_staff, public.players to authenticated;

-- Organizations ----------------------------------------------------------

create policy "Organizations are public" on public.organizations for select to anon, authenticated
  using (true);
create policy "Owners and admins edit their organization" on public.organizations for update to authenticated
  using (public.is_organization_member(id, array['owner', 'admin']))
  with check (public.is_organization_member(id, array['owner', 'admin']));
grant update (name) on public.organizations to authenticated;

create policy "Members see their organization's members" on public.organization_members
  for select to authenticated
  using (public.is_organization_member(organization_id));
create policy "Owners and admins remove members" on public.organization_members
  for delete to authenticated
  using (public.is_organization_member(organization_id, array['owner', 'admin']) and role <> 'owner');
grant delete on public.organization_members to authenticated;

-- Tournaments ------------------------------------------------------------

create policy "Visible tournaments" on public.tournaments for select to anon, authenticated
  using (status <> 'draft' or public.is_tournament_staff(id));
create policy "Staff edit tournament" on public.tournaments for update to authenticated
  using (public.is_tournament_staff(id)) with check (public.is_tournament_staff(id));
-- status and auto_assign go through set_tournament_status() / set_auto_assign().
grant update (name, starts_on, time_zone, min_rest_minutes, no_show_minutes, overdue_after_minutes,
              match_slot_minutes, entry_fee_cents, extra_event_fee_cents, early_entry_fee_cents,
              early_extra_event_fee_cents, early_until, refund_fee_cents, stream_url)
  on public.tournaments to authenticated;
create policy "Organization admins delete tournaments" on public.tournaments for delete to authenticated
  using (public.is_organization_member(organization_id, array['owner', 'admin']));
grant delete on public.tournaments to authenticated;

create policy "Live revision of visible tournaments" on public.tournament_live for select to anon, authenticated
  using (exists (select 1 from public.tournaments t where t.id = tournament_id));

create policy "Staff see tournament staff" on public.tournament_staff for select to authenticated
  using (user_id = auth.uid() or public.is_tournament_staff(tournament_id));

-- Events, courts, teams ---------------------------------------------------

create policy "Events of visible tournaments" on public.events for select to anon, authenticated
  using (exists (select 1 from public.tournaments t where t.id = tournament_id));
create policy "Staff manage events" on public.events for all to authenticated
  using (public.is_tournament_staff(tournament_id))
  with check (public.is_tournament_staff(tournament_id));
grant insert, delete on public.events to authenticated;
grant update (name, kind, format, pool_count, advance_per_pool, games_to, best_of, point_cap,
              playoff_games_to, playoff_best_of, playoff_point_cap, not_before, sort_order,
              gender, min_age, max_age, age_basis, skill_rule, skill_level, skill_level_to,
              rating_source, allow_play_up, max_teams, partner_required,
              max_rounds, bracket_type, third_place_match, grand_final_reset, confirm_seeds,
              round_formats)
  on public.events to authenticated;

create policy "Courts of visible tournaments" on public.courts for select to anon, authenticated
  using (exists (select 1 from public.tournaments t where t.id = tournament_id));
create policy "Staff rename courts" on public.courts for update to authenticated
  using (public.is_tournament_staff(tournament_id))
  with check (public.is_tournament_staff(tournament_id));
-- Adding/removing and pausing go through set_court_count() / set_court_out_of_service().
grant update (name, sort_order, stream_url) on public.courts to authenticated;

create policy "Teams of visible tournaments" on public.teams for select to anon, authenticated
  using (exists (select 1 from public.tournaments t where t.id = tournament_id));
create policy "Staff manage teams" on public.teams for all to authenticated
  using (public.is_tournament_staff(tournament_id))
  with check (public.is_tournament_staff(tournament_id));
-- checked_in_at goes through check_in_team(); pool is set by generate_matches().
grant insert, delete on public.teams to authenticated;
grant update (name, seed, withdrawn_at) on public.teams to authenticated;

create policy "Members of visible teams" on public.team_players for select to anon, authenticated
  using (exists (select 1 from public.teams t where t.id = team_id));
create policy "Staff manage team members" on public.team_players for all to authenticated
  using (exists (select 1 from public.teams t
                 where t.id = team_id and public.is_tournament_staff(t.tournament_id)))
  with check (exists (select 1 from public.teams t
                      where t.id = team_id and public.is_tournament_staff(t.tournament_id)));
grant insert, delete on public.team_players to authenticated;

-- Matches change only through engine functions.
create policy "Matches of visible tournaments" on public.matches for select to anon, authenticated
  using (exists (select 1 from public.tournaments t where t.id = tournament_id));

-- Players ----------------------------------------------------------------

-- Contact details: a player sees their own row; staff see players they added
-- or who are entered in their tournaments. Public pages show team names.
create policy "Own player row" on public.players for select to authenticated
  using (user_id = auth.uid() or added_by = auth.uid());
create policy "Staff see their players" on public.players for select to authenticated
  using (exists (
    select 1 from public.team_players tp
    join public.teams t on t.id = tp.team_id
    where tp.player_id = players.id and public.is_tournament_staff(t.tournament_id)
  ));
create policy "Update own player row" on public.players for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Until self-registration exists, organization members add players.
create policy "Directors add players" on public.players for insert to authenticated
  with check (exists (select 1 from public.organization_members om where om.user_id = auth.uid()));
grant insert on public.players to authenticated;
grant update (first_name, last_name, email, phone, sms_opt_in, gender, birth_date, dupr_id, dupr_doubles,
              dupr_singles, self_rating)
  on public.players to authenticated;

-- Realtime: screens subscribe to their tournament's tournament_live row.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.tournament_live;
  end if;
end $$;
