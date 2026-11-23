-- A tournament its managers called off (cancel_tournament, next migration).
-- Its own migration: a new enum value can't be used in the transaction that adds it.
alter type public.tournament_status add value if not exists 'cancelled';
