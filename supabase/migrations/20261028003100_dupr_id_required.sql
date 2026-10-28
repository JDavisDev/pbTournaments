-- A DUPR ID is required of every player who registers, in every division
-- (entry_problem: 'needs your DUPR ID'). Players a director adds by hand are
-- flagged on the Players page until they have one.
alter table public.events alter column require_dupr_id set default true;
update public.events set require_dupr_id = true where not require_dupr_id;
alter table public.events add constraint events_dupr_id_required check (require_dupr_id);
