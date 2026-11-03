-- The per-player platform fee goes from $2 to $2.50. Fees are worked out from
-- the current price, so players not yet charged for count at the new one.
alter table private.platform_pricing alter column per_player_cents set default 250;
update private.platform_pricing set per_player_cents = 250;
