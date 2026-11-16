-- ============================================================
-- Apostrophe-insensitive event search
--
-- Problem: migration 024 made search accent-insensitive (unaccent +
-- lower on both sides), so "Pokemon" finds "Pokémon Club". But nothing
-- strips apostrophes, so "Jillys" never matches "Jilly's Music Room":
-- the word-boundary regex \yjillys\y cannot match "jilly's". In prod,
-- 31 upcoming events matched jilly's and 0 matched jillys.
--
-- Fix: drop apostrophes (straight and typographic) from the normalized
-- search columns, and mirror the same strip in the client's
-- normalizeSearch() so "Jilly's", "Jilly’s" and "Jillys" all become
-- "jillys" on both sides. (unaccent already folds ’ to ' but keeps it.)
--
-- The helper is STABLE (not IMMUTABLE) because unaccent() is STABLE.
-- ============================================================

CREATE OR REPLACE FUNCTION search_normalize(input text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT regexp_replace(unaccent(lower(coalesce(input, ''))), '[''’‘]', '', 'g');
$$;

CREATE OR REPLACE FUNCTION sync_event_search_normalized()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.title_normalized := search_normalize(NEW.title);
  NEW.description_normalized := search_normalize(
    coalesce(NEW.description, '') || ' ' || coalesce(array_to_string(NEW.tags, ' '), '')
  );
  RETURN NEW;
END;
$$;

-- Backfill only rows that actually carry an apostrophe (~1,600 upcoming);
-- everything else is already in its final form.
UPDATE events
SET
  title_normalized       = search_normalize(title),
  description_normalized = search_normalize(
    coalesce(description, '') || ' ' || coalesce(array_to_string(tags, ' '), '')
  )
WHERE title ~ '[''’‘]' OR description ~ '[''’‘]' OR array_to_string(tags, ' ') ~ '[''’‘]';
