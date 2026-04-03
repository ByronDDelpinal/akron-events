-- Allow price_min to be NULL, meaning "price unknown."
-- Previously, unknown prices defaulted to 0, making paid events appear free.

alter table events alter column price_min drop not null;
alter table events alter column price_min set default null;

-- Backfill: set existing 0-price events with a ticket_url to NULL
-- (if it has a ticket link, it's probably not free — the scraper just didn't know the price)
update events
  set price_min = null
where price_min = 0
  and price_max is null
  and ticket_url is not null;
