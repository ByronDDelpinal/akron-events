-- ============================================================
-- Time-of-day filter support: events.start_hour_et
--
-- Problem: the "When" section's time-of-day filter (Morning / Afternoon /
-- Evening) needs "the Eastern local hour of start_at". PostgREST cannot
-- express `extract(hour from (start_at AT TIME ZONE 'America/New_York'))`
-- as a filter against a raw column today, so the value has to be materialized.
--
-- Solution: a trigger-maintained column, NOT a generated column and NOT an
-- expression index. `timestamptz AT TIME ZONE text` is STABLE, not
-- IMMUTABLE (it depends on the session's tzdata, which can change with a
-- Postgres/OS update) — Postgres generated columns and expression indexes
-- both require an IMMUTABLE expression. This is the exact situation
-- migration 024 (unaccent search) documents in its own header for
-- unaccent(): "Generated columns cannot be used here because unaccent() is
-- STABLE, not IMMUTABLE." The same reasoning applies here, and the same fix
-- applies: a BEFORE trigger that writes the derived value on every
-- insert/update, same shape as 024's sync_event_search_normalized trigger.
--
-- Do NOT "fix" this with an IMMUTABLE wrapper function around AT TIME ZONE
-- to unlock a generated column or expression index — that lies to the
-- planner about the function's actual volatility, and a tzdata update would
-- silently desynchronize the stored/indexed value from a fresh evaluation
-- without any error. A trigger is honest, and the table is small enough
-- (< 10k rows) that the backfill and the per-row trigger cost are trivial.
--
-- Correctness note: the Eastern LOCAL HOUR of a fixed instant (a
-- timestamptz) never changes after it's computed -- DST affects the mapping
-- from a WALL-CLOCK time to an instant (why src/lib/easternDate.ts's
-- easternIsoAt exists), not the reverse read of an instant's local hour. So
-- a stored start_hour_et never goes stale on its own; it only needs to be
-- recomputed when start_at itself changes, which the trigger's `OF start_at`
-- clause already scopes to.
--
-- No RLS/grant change: events RLS is row-level (031/038/042/054), and a new
-- column inherits the table's existing grants. Acceptance for this migration
-- is a real ANONYMOUS curl against PostgREST (per the "test via the API, not
-- the DB" rule) — a service-role SQL check does not exercise the schema
-- cache or the anon policy path:
--
--   curl "$SUPABASE_URL/rest/v1/events?select=id,start_at,start_hour_et&start_hour_et=gte.17&start_hour_et=lte.23&limit=5" \
--     -H "apikey: $ANON_KEY"
--
-- should return rows whose start_at renders 5pm-11pm Eastern.
-- ============================================================

ALTER TABLE events ADD COLUMN IF NOT EXISTS start_hour_et smallint;

-- Backfill existing rows.
UPDATE events
SET start_hour_et = extract(hour from (start_at AT TIME ZONE 'America/New_York'))::smallint;

-- Trigger function ---------------------------------------------
CREATE OR REPLACE FUNCTION sync_event_start_hour_et()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.start_hour_et := extract(hour from (NEW.start_at AT TIME ZONE 'America/New_York'))::smallint;
  RETURN NEW;
END;
$$;

-- Fire on INSERT and on any UPDATE that touches start_at, mirroring 024's
-- scoping rationale: no need to recompute on unrelated column updates
-- (status changes, image updates, etc).
DROP TRIGGER IF EXISTS events_start_hour_et_sync ON events;
CREATE TRIGGER events_start_hour_et_sync
  BEFORE INSERT OR UPDATE OF start_at ON events
  FOR EACH ROW EXECUTE FUNCTION sync_event_start_hour_et();

-- Index — nearly free at this table size and not load-bearing today, but the
-- time-of-day filter's WHERE clause is a range on this column, so it's cheap
-- insurance as the table grows.
CREATE INDEX IF NOT EXISTS events_start_hour_et_idx ON events (start_hour_et);
