-- ============================================================
-- Include event tags in the normalized search text
--
-- Problem: search matched only title_normalized / description_normalized
-- (migration 024). Many events carry their searchable subject only in tags,
-- not the title — e.g. RubberDucks games are titled "RubberDucks vs. Altoona
-- Curve" with a 'baseball' tag, so searching "baseball" missed all of them.
--
-- Fix: fold the event's tags into description_normalized so the existing
-- title/description ILIKE search picks them up. No frontend change required —
-- the deployed query already searches description_normalized.
--
-- (description_normalized is a search-only column; it is never displayed.)
-- ============================================================

CREATE OR REPLACE FUNCTION sync_event_search_normalized()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.title_normalized := unaccent(lower(NEW.title));
  NEW.description_normalized := unaccent(lower(
    coalesce(NEW.description, '') || ' ' || coalesce(array_to_string(NEW.tags, ' '), '')
  ));
  RETURN NEW;
END;
$$;

-- Also re-sync when tags change (the old trigger only watched title/description).
DROP TRIGGER IF EXISTS events_search_normalized_sync ON events;
CREATE TRIGGER events_search_normalized_sync
  BEFORE INSERT OR UPDATE OF title, description, tags ON events
  FOR EACH ROW EXECUTE FUNCTION sync_event_search_normalized();

-- Backfill every existing row.
UPDATE events
SET description_normalized = unaccent(lower(
  coalesce(description, '') || ' ' || coalesce(array_to_string(tags, ' '), '')
));
