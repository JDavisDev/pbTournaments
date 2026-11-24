-- What the TV board (/tv/<id>) shows. Directors choose the screens it
-- rotates through, how long each stays up, and which divisions the standings
-- and schedule screens cover. Every TV showing the board follows it, so a
-- director can change the screens from their phone.
--
--   { "screens": ["courts", "standings", "schedule"],  -- shown in this order
--     "seconds": 20,                                    -- 5 to 300 per screen
--     "event_ids": [] }                                 -- [] = every division
--
-- '{}' (the default) is the court board alone, as before.

-- CASE keeps the array functions away from values that aren't arrays.
create function private.valid_tv_settings(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p) <> 'object' then false else
    (case when not p ? 'screens' then true
          when jsonb_typeof(p -> 'screens') <> 'array' then false
          else jsonb_array_length(p -> 'screens') between 1 and 3
               and not exists (
                 select 1 from jsonb_array_elements(p -> 'screens') s
                 where jsonb_typeof(s) <> 'string' or s #>> '{}' not in ('courts', 'standings', 'schedule'))
     end)
    and (case when not p ? 'seconds' then true
              when jsonb_typeof(p -> 'seconds') <> 'number' then false
              else (p ->> 'seconds')::numeric between 5 and 300
         end)
    and (case when not p ? 'event_ids' then true
              when jsonb_typeof(p -> 'event_ids') <> 'array' then false
              else not exists (select 1 from jsonb_array_elements(p -> 'event_ids') e where jsonb_typeof(e) <> 'string')
         end)
  end
$$;

alter table public.tournaments
  add column tv_settings jsonb not null default '{}'::jsonb
    constraint tv_settings_valid check (private.valid_tv_settings(tv_settings));
grant update (tv_settings) on public.tournaments to authenticated;
