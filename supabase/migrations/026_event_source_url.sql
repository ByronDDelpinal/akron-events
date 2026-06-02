-- Adds a per-event canonical detail URL.
--
-- Why this exists:
--   Akron Pulse is an aggregator, not a ticketing platform. Every event
--   page needs at least one outbound link so users can register, RSVP,
--   buy a ticket, or read the original listing on the source's site.
--   `ticket_url` already covers the registration / purchase case, but
--   not every source advertises a direct ticketing link — many publish
--   only a free-text description with the registration details inline.
--   For those events the page previously rendered no outbound CTA at
--   all, which makes the site look broken.
--
-- `source_url` captures the original event detail page URL on the
-- source's site (e.g. the Visit Akron CVB event 263 page, an Akron
-- Civic Theatre show page, the Akron-Summit Library event listing).
-- The frontend uses it as a "View event details" fallback whenever
-- `ticket_url` is null, so every event surface always has at least one
-- way for the user to act on it.
--
-- The column is nullable to keep migrations cheap: scrapers populate
-- it on the next ingest pass; older rows that never had a source URL
-- captured remain valid until their next rescrape.

alter table events add column if not exists source_url text;

-- Backfill existing rows. For events that already have a ticket_url
-- the ticket URL is almost always the source's event detail page
-- anyway (most scrapers mirror them), so seeding source_url with the
-- ticket_url value gives the frontend a sane fallback immediately
-- after this migration runs. Rescrapes will refine values where the
-- two URLs legitimately differ.
update events
   set source_url = ticket_url
 where source_url is null
   and ticket_url is not null;
