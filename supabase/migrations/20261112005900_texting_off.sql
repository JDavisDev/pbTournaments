-- Texting is off site-wide until the sending number is fully set up.
-- New tournaments start with texting off, existing ones are switched off (so
-- no texts are queued and no texting fee is charged), and directors can't
-- turn it back on. To bring texting back: grant the column again, put the
-- default back if wanted, and set textingAvailable in web/src/lib/config.ts.
alter table public.tournaments alter column texts_enabled set default false;

update public.tournaments set texts_enabled = false where texts_enabled;

revoke update (texts_enabled) on public.tournaments from authenticated;
