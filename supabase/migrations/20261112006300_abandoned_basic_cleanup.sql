-- Free (Basic) tournaments stay unless they were abandoned: started (a
-- division started) more than 14 days ago and never finished. Finished means
-- marked complete, or every match played: at least one completed and none
-- still waiting, queued or on court. Drafts, published ones that never
-- started, and finished ones are kept.

-- As before (demo_and_planner) for practice tournaments, plus abandoned Basic
-- tournaments. Runs daily (pg_cron 'clean-up-demo-tournaments').
create or replace function private.clean_up_demo_tournaments() returns int
language plpgsql set search_path = '' as $$
declare
  v_deleted int;
  v_abandoned int;
begin
  delete from public.tournaments where is_demo and created_at < now() - interval '14 days';
  get diagnostics v_deleted = row_count;

  delete from public.tournaments t
  where t.simple and not t.is_demo and t.status <> 'complete'
    and (select min(e.started_at) from public.events e where e.tournament_id = t.id) < now() - interval '14 days'
    and not (
      exists (select 1 from public.matches m where m.tournament_id = t.id and m.status = 'completed')
      and not exists (select 1 from public.matches m where m.tournament_id = t.id
                      and m.status in ('waiting', 'queued', 'assigned', 'in_progress'))
    );
  get diagnostics v_abandoned = row_count;

  delete from public.players p
  where p.user_id is null and p.email like '%@players.test'
    and not exists (select 1 from public.team_players tp where tp.player_id = p.id)
    and not exists (select 1 from public.registrations r where r.player_id = p.id);
  return v_deleted + v_abandoned;
end $$;
