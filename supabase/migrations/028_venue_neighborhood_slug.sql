-- Adds a neighborhood classification slug to venues.
--
-- Why this exists:
--   The neighborhood hub pages (Downtown Akron, Highland Square, North
--   Hill, …) currently filter events by client-side venue-name
--   substring matching (see CategoryPage.jsx → eventMatchesNeighborhood
--   and src/lib/seo/categories.js → NEIGHBORHOOD_HUBS.venueIncludes).
--   That matcher was authored from memory without verified data, so
--   every hub is shipped behind `disabled: true` — see
--   docs/neighborhoods.md for the full GIS scout writeup.
--
--   This column is the structured replacement. Each venue is tagged
--   with exactly one neighborhood slug from the City of Akron's
--   official 24-neighborhood list (also enumerated in
--   src/lib/neighborhoods.js so the frontend and DB share one source
--   of truth). The CategoryPage matcher reads this column directly
--   instead of guessing from the venue name.
--
-- Path:
--   Manual classification now (admin venue editor exposes a dropdown).
--   When the City of Akron polygons land, a backfill script will run
--   PostGIS ST_Contains(polygon, ST_Point(venues.lng, venues.lat)) and
--   populate the column automatically — same schema, no churn.
--
-- Nullable on purpose: an unclassified venue is a known, common state
-- (new venues, venues outside Akron city limits, venues with missing
-- coordinates) and the hub matcher already excludes them naturally.

alter table venues
  add column if not exists neighborhood_slug text;

-- Constrain the column to the canonical 24 City-of-Akron neighborhood
-- slugs. Keep this list in lockstep with src/lib/neighborhoods.js —
-- any addition/rename must ship as both a migration AND a code change
-- so the admin dropdown and the DB constraint never disagree.
--
-- DO blocks let us keep the migration idempotent (`if not exists`
-- semantics for constraints aren't standardized).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'venues_neighborhood_slug_check'
  ) then
    alter table venues
      add constraint venues_neighborhood_slug_check
      check (neighborhood_slug is null or neighborhood_slug in (
        'high-hampton',
        'merriman-valley',
        'northwest-akron',
        'merriman-hills',
        'fairlawn-heights',
        'wallhaven',
        'west-akron',
        'highland-square',
        'west-hill',
        'cascade-valley',
        'sherbondy-hill',
        'downtown-akron',
        'university-park',
        'middlebury',
        'north-hill',
        'chapel-hill',
        'goodyear-heights',
        'east-akron',
        'ellet',
        'summit-lake',
        'south-akron',
        'firestone-park',
        'kenmore',
        'coventry-crossing'
      ));
  end if;
end$$;

-- The hub matcher's hot path is "all venues with neighborhood_slug = X"
-- when listing a hub page. A partial index keeps the index small
-- (unclassified venues are excluded) and the lookup cheap.
create index if not exists venues_neighborhood_slug_idx
  on venues (neighborhood_slug)
  where neighborhood_slug is not null;
