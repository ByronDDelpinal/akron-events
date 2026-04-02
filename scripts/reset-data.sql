-- ============================================================
-- FULL DATA RESET
-- ============================================================
--
-- Deletes ALL data from every table, respecting foreign key
-- constraints by deleting junction tables first, then leaf
-- tables, then parent tables.
--
-- Run this before a full re-scrape:
--   psql "$DATABASE_URL" -f scripts/reset-data.sql
--
-- Or via Supabase SQL Editor: paste this entire file.
--
-- WARNING: This is irreversible. All events, venues,
-- organizations, areas, and scraper run history will be deleted.
-- ============================================================

BEGIN;

-- ── 1. Junction tables (no FK dependencies) ──────────────────
TRUNCATE TABLE event_venues        CASCADE;
TRUNCATE TABLE event_organizations CASCADE;
TRUNCATE TABLE event_areas         CASCADE;

-- ── 2. Leaf tables ───────────────────────────────────────────
TRUNCATE TABLE areas               CASCADE;
TRUNCATE TABLE scraper_runs        CASCADE;

-- ── 3. Main entity tables ────────────────────────────────────
TRUNCATE TABLE events              CASCADE;
TRUNCATE TABLE venues              CASCADE;
TRUNCATE TABLE organizations       CASCADE;

COMMIT;

-- Verify everything is empty
SELECT 'events'              AS tbl, count(*) FROM events
UNION ALL SELECT 'venues',            count(*) FROM venues
UNION ALL SELECT 'organizations',     count(*) FROM organizations
UNION ALL SELECT 'areas',             count(*) FROM areas
UNION ALL SELECT 'event_venues',      count(*) FROM event_venues
UNION ALL SELECT 'event_organizations', count(*) FROM event_organizations
UNION ALL SELECT 'event_areas',       count(*) FROM event_areas
UNION ALL SELECT 'scraper_runs',      count(*) FROM scraper_runs
ORDER BY tbl;
