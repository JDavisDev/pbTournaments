-- A DUPR ID is optional for now, while the DUPR side isn't fully set up. To
-- require it again, set events.require_dupr_id: registration asks for it and
-- enforces it (entry_problem) in any division that has it on.
alter table public.events drop constraint events_dupr_id_required;
alter table public.events alter column require_dupr_id set default false;
update public.events set require_dupr_id = false where require_dupr_id;
