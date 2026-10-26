-- A registration whose every event is full waits on the waitlist, unpaid.
-- (Its own migration: a new enum value can't be used in the transaction that adds it.)
alter type public.registration_status add value if not exists 'waitlisted';
