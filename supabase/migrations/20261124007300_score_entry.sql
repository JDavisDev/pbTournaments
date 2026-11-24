-- Who may enter the score of a match on court, for every tournament. It was a
-- switch for Basic tournaments alone (anyone_scores).
--   'staff'    directors and court monitors only
--   'players'  staff, and the match's own players: signed in, or with the
--              link in their text
--   'anyone'   anyone with the tournament link
-- Staff can always enter and fix scores. Existing tournaments keep their rule:
-- full tournaments 'players', Basic ones directors only or anyone.

alter table public.tournaments
  add column score_entry text not null default 'players'
    constraint tournaments_score_entry_check check (score_entry in ('staff', 'players', 'anyone'));
grant update (score_entry) on public.tournaments to authenticated;

update public.tournaments set score_entry = case when anyone_scores then 'anyone' else 'staff' end where simple;
alter table public.tournaments drop column anyone_scores;

-- A Basic tournament starts at directors only, as before: pasted players have no accounts.
create function private.basic_score_entry() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.simple and (tg_op = 'INSERT' or not old.simple) then
    new.score_entry := 'staff';
  end if;
  return new;
end $$;
create trigger tournaments_basic_score_entry before insert or update of simple on public.tournaments
  for each row execute function private.basic_score_entry();

-- As before (player_accounts), by the tournament's score_entry.
create or replace function public.report_score(p_match uuid, p_games jsonb) returns public.matches
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
  t public.tournaments;
  v_staff boolean;
begin
  m := private.lock_match(p_match);
  select * into t from public.tournaments where id = m.tournament_id;
  v_staff := public.is_court_monitor(m.tournament_id);
  if not (v_staff or t.score_entry = 'anyone'
          or (t.score_entry = 'players' and private.plays_in_match(p_match))) then
    if t.score_entry = 'staff' then
      raise exception 'The tournament desk enters scores here. Tell them your score.' using errcode = '42501';
    end if;
    raise exception 'Only players in this match or tournament staff can report its score' using errcode = '42501';
  end if;
  if not (m.status in ('assigned', 'in_progress') or (v_staff and m.status = 'queued')) then
    raise exception 'This match is not on a court, so it can''t be scored' using errcode = '55000';
  end if;
  perform private.finish_match(p_match, private.score_winner(m, p_games), p_games, false);
  perform private.auto_assign(m.tournament_id);
  select * into m from public.matches where id = p_match;
  return m;
end $$;

-- As before (registration_and_texts): the link in a player's text is their
-- permission, unless the tournament keeps scores to its staff.
create or replace function public.report_score_by_code(p_code text, p_games jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  m := private.match_by_code(p_code);
  if (select score_entry from public.tournaments where id = m.tournament_id) = 'staff' then
    raise exception 'The tournament desk enters scores here. Tell them your score.' using errcode = '42501';
  end if;
  if m.status = 'completed' then
    raise exception 'A score was already reported for this match. Ask the desk to fix it if it''s wrong.'
      using errcode = '55000';
  end if;
  if m.status not in ('assigned', 'in_progress') then
    raise exception 'This match isn''t on a court right now' using errcode = '55000';
  end if;
  perform private.finish_match(m.id, private.score_winner(m, p_games), p_games, false);
  perform private.auto_assign(m.tournament_id);
  return jsonb_build_object('ok', true);
end $$;

-- As before (brackets), with who enters scores, so the link's page can say.
create or replace function public.get_match_by_code(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(md) || jsonb_build_object('tournament_name', t.name, 'score_entry', t.score_entry)
  from public.matches m
  join public.match_details md on md.id = m.id
  join public.tournaments t on t.id = m.tournament_id
  where m.report_code = p_code
$$;
