-- Practice tournaments are open to anyone trying the demo: every signed-in
-- user, including a guest (Supabase anonymous sign-in, no email), is staff of
-- a demo tournament. Real tournaments keep their organization's staff only.
-- Every staff check (functions and row-level security) goes through
-- is_tournament_staff, so this one change covers them all.
create or replace function public.is_tournament_staff(p_tournament uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tournament_staff s
    where s.tournament_id = p_tournament and s.user_id = auth.uid()
  ) or exists (
    select 1 from public.tournaments t
    join public.organization_members om on om.organization_id = t.organization_id
    where t.id = p_tournament and om.user_id = auth.uid()
  ) or (
    auth.uid() is not null
    and exists (select 1 from public.tournaments t where t.id = p_tournament and t.is_demo)
  )
$$;
