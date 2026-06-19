-- 040_venues_listed.sql
--
-- Adds venues.listed — whether a venue appears in the public venues index
-- (/venues) and the sitemap. Defaults true so every existing venue stays
-- listed. Unlisted venues remain directly navigable (/venues/:id) and still
-- attach to their events; they're just kept out of the directory.
--
-- Use case: race start locations enriched from RunSignup that have only a bare
-- street address (no formal venue name). We mint them so the event shows a
-- location/map, but hide them from the directory to avoid address-named clutter.

alter table public.venues
  add column if not exists listed boolean not null default true;

-- Partial index to keep the common "listed venues" directory query fast.
create index if not exists venues_listed_idx on public.venues (listed) where listed = true;
