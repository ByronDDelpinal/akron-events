-- ============================================================
-- Denormalized events.category_slugs for category EXCLUSION
--
-- The content-category filter is a junction table (event_categories) and the
-- include path is an any-match inner join. EXCLUDING a category ("show
-- everything except Sports") is an anti-join — "events that have NONE of these
-- categories" — which PostgREST can't express over a to-many embed, and the
-- complement-include trick leaks (an event tagged sports+music would still
-- match "any of the other 13").
--
-- Fix: maintain a denormalized text[] of the event's category slugs on the
-- events row, kept in sync by a trigger on event_categories, with a GIN index.
-- Exclude then becomes a single fast `category_slugs not.ov '{sports}'` filter.
--
-- Idempotent: safe to re-run (and safe to apply live + via CLI push).
-- ============================================================

-- 1. The denormalized column.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS category_slugs text[] NOT NULL DEFAULT '{}';

-- 2. Recompute one event's slugs from the junction table.
CREATE OR REPLACE FUNCTION sync_event_category_slugs(p_event_id uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE events e
  SET category_slugs = COALESCE(
    (SELECT array_agg(ec.category ORDER BY ec.category)
       FROM event_categories ec
      WHERE ec.event_id = p_event_id),
    '{}'
  )
  WHERE e.id = p_event_id;
$$;

-- 3. Trigger wrapper: re-sync the affected event(s) on any junction change.
CREATE OR REPLACE FUNCTION trg_sync_event_category_slugs()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    PERFORM sync_event_category_slugs(OLD.event_id);
    RETURN OLD;
  END IF;
  PERFORM sync_event_category_slugs(NEW.event_id);
  -- An UPDATE that moves a row to a different event must fix the old one too.
  IF (TG_OP = 'UPDATE' AND NEW.event_id IS DISTINCT FROM OLD.event_id) THEN
    PERFORM sync_event_category_slugs(OLD.event_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS event_categories_sync_slugs ON event_categories;
CREATE TRIGGER event_categories_sync_slugs
  AFTER INSERT OR UPDATE OR DELETE ON event_categories
  FOR EACH ROW EXECUTE FUNCTION trg_sync_event_category_slugs();

-- 4. GIN index for the not-overlaps / overlaps array operators.
CREATE INDEX IF NOT EXISTS events_category_slugs_gin
  ON events USING gin (category_slugs);

-- 5. Backfill every existing row from the junction table.
UPDATE events e
SET category_slugs = COALESCE(
  (SELECT array_agg(ec.category ORDER BY ec.category)
     FROM event_categories ec
    WHERE ec.event_id = e.id),
  '{}'
);
