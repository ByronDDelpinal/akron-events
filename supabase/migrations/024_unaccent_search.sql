-- ============================================================
-- Accent-insensitive event search
--
-- Problem: scraped event titles often contain accented characters
-- (e.g. "Pokémon Club") that users search for without accents
-- ("Pokemon"). PostgreSQL's ILIKE is case-insensitive but NOT
-- accent-insensitive, so these queries return zero results.
--
-- Solution:
--   1. Enable unaccent (strips diacritics) and pg_trgm (trigram
--      indexes for fast ILIKE on arbitrary substrings).
--   2. Add title_normalized / description_normalized columns that
--      store unaccent(lower(...)) of their source columns.
--   3. A BEFORE trigger keeps the normalized columns in sync on
--      every insert/update. (Generated columns cannot be used here
--      because unaccent() is STABLE, not IMMUTABLE.)
--   4. GIN trigram indexes on the normalized columns make wildcard
--      ILIKE queries fast even as the event table grows.
--
-- Client-side counterpart: the search term is also NFD-normalized
-- and lowercased in JS before hitting the API, so both directions
-- ("Pokemon" → db "pokemon", "Pokémon" → db "pokemon") resolve to
-- the same normalized form and match correctly.
-- ============================================================

-- Extensions ---------------------------------------------------
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Normalized columns -------------------------------------------
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS title_normalized       text,
  ADD COLUMN IF NOT EXISTS description_normalized text;

-- Backfill existing rows ---------------------------------------
UPDATE events
SET
  title_normalized       = unaccent(lower(title)),
  description_normalized = unaccent(lower(coalesce(description, '')));

-- Trigger function ---------------------------------------------
CREATE OR REPLACE FUNCTION sync_event_search_normalized()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.title_normalized       := unaccent(lower(NEW.title));
  NEW.description_normalized := unaccent(lower(coalesce(NEW.description, '')));
  RETURN NEW;
END;
$$;

-- Fire on INSERT and on any UPDATE that touches the source cols.
-- Scoping to title/description avoids redundant work on unrelated
-- column updates (e.g. status changes, image updates).
DROP TRIGGER IF EXISTS events_search_normalized_sync ON events;
CREATE TRIGGER events_search_normalized_sync
  BEFORE INSERT OR UPDATE OF title, description ON events
  FOR EACH ROW EXECUTE FUNCTION sync_event_search_normalized();

-- Trigram indexes ----------------------------------------------
-- GIN + gin_trgm_ops lets PostgreSQL use the index for
-- ILIKE '%term%' patterns (not just prefix matches).
CREATE INDEX IF NOT EXISTS events_title_normalized_trgm_idx
  ON events USING gin (title_normalized gin_trgm_ops);

CREATE INDEX IF NOT EXISTS events_description_normalized_trgm_idx
  ON events USING gin (description_normalized gin_trgm_ops);
