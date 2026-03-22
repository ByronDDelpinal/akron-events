-- =============================================================================
-- 003_scraper_health.sql
--
-- Scraper health monitoring infrastructure.
--
-- Tables:
--   scraper_runs  — one row per scraper execution; written by ingestion scripts
--
-- Views:
--   scraper_health  — latest run per scraper + staleness/zero-event alerts
--
-- The scraper_health view powers an admin dashboard and can be polled by a
-- monitoring job to send alerts when scrapers go stale or consistently return
-- zero events.
-- =============================================================================

-- ── scraper_runs ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scraper_runs (
  id              bigserial PRIMARY KEY,
  scraper_name    text        NOT NULL,   -- e.g. 'summit_artspace', 'akron_library'
  ran_at          timestamptz NOT NULL DEFAULT now(),
  status          text        NOT NULL    -- 'success' | 'error'
                  CHECK (status IN ('success', 'error')),
  events_found    integer     NOT NULL DEFAULT 0,  -- total events seen from source
  events_inserted integer     NOT NULL DEFAULT 0,  -- new rows created
  events_updated  integer     NOT NULL DEFAULT 0,  -- existing rows updated
  events_skipped  integer     NOT NULL DEFAULT 0,  -- parse/upsert failures
  error_message   text,                            -- populated when status='error'
  duration_ms     integer                          -- wall-clock time of the run
);

-- Efficient lookups by scraper and time
CREATE INDEX IF NOT EXISTS scraper_runs_scraper_name_idx ON scraper_runs (scraper_name);
CREATE INDEX IF NOT EXISTS scraper_runs_ran_at_idx       ON scraper_runs (ran_at DESC);

-- Allow the service role to insert (called from ingestion scripts)
ALTER TABLE scraper_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON scraper_runs FOR ALL
  USING     (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Allow authenticated users (admin dashboard) to read
CREATE POLICY "Authenticated users can read scraper_runs"
  ON scraper_runs FOR SELECT
  USING (auth.role() = 'authenticated');

-- ── scraper_health view ───────────────────────────────────────────────────────
--
-- For each registered scraper, shows:
--   last_ran_at         — when it last ran successfully
--   hours_since_run     — staleness in hours
--   last_events_found   — events returned in last run
--   consecutive_zeros   — how many recent runs in a row returned 0 events
--   is_stale            — true if last run > 26 hours ago
--   is_zero_streak      — true if last 2+ consecutive runs returned 0 events
--   alert               — human-readable alert string, or NULL if healthy
--
-- "Registered scrapers" are those that have ever logged a run. A scraper
-- that has never run will not appear here (add a zero row after first run).

CREATE OR REPLACE VIEW scraper_health AS
WITH
-- Latest run per scraper
latest AS (
  SELECT DISTINCT ON (scraper_name)
    scraper_name,
    ran_at       AS last_ran_at,
    status       AS last_status,
    events_found AS last_events_found,
    error_message AS last_error
  FROM scraper_runs
  ORDER BY scraper_name, ran_at DESC
),
-- Count consecutive zero-event runs (from most recent, stop at first non-zero)
zero_streak AS (
  SELECT
    scraper_name,
    COUNT(*) FILTER (
      WHERE events_found = 0
        AND ran_at > (
          SELECT COALESCE(MAX(ran_at), '-infinity'::timestamptz)
          FROM scraper_runs sr2
          WHERE sr2.scraper_name = sr.scraper_name
            AND sr2.events_found > 0
        )
    ) AS consecutive_zeros
  FROM scraper_runs sr
  GROUP BY scraper_name
),
-- Last 5 run averages per scraper
recent_avg AS (
  SELECT
    scraper_name,
    ROUND(AVG(events_found))  AS avg_events_last5,
    COUNT(*)                  AS total_runs
  FROM (
    SELECT scraper_name, events_found,
           ROW_NUMBER() OVER (PARTITION BY scraper_name ORDER BY ran_at DESC) AS rn
    FROM scraper_runs
  ) ranked
  WHERE rn <= 5
  GROUP BY scraper_name
)
SELECT
  l.scraper_name,
  l.last_ran_at,
  ROUND(EXTRACT(EPOCH FROM (now() - l.last_ran_at)) / 3600.0, 1) AS hours_since_run,
  l.last_status,
  l.last_events_found,
  l.last_error,
  z.consecutive_zeros,
  r.avg_events_last5,
  r.total_runs,
  -- Alert flags
  (l.last_ran_at < now() - INTERVAL '26 hours')                     AS is_stale,
  (z.consecutive_zeros >= 2)                                         AS is_zero_streak,
  (l.last_status = 'error')                                         AS is_error,
  -- Human-readable alert (NULL = healthy)
  CASE
    WHEN l.last_status = 'error'
      THEN 'ERROR: ' || COALESCE(l.last_error, 'unknown error')
    WHEN l.last_ran_at < now() - INTERVAL '26 hours'
      THEN 'STALE: last run ' || ROUND(EXTRACT(EPOCH FROM (now() - l.last_ran_at)) / 3600.0, 0)::text || 'h ago'
    WHEN z.consecutive_zeros >= 2
      THEN 'ZERO EVENTS: ' || z.consecutive_zeros::text || ' consecutive runs returned 0 events'
    ELSE NULL
  END AS alert
FROM latest l
JOIN zero_streak z USING (scraper_name)
JOIN recent_avg  r USING (scraper_name)
ORDER BY
  -- Surface unhealthy scrapers first
  CASE WHEN l.last_status = 'error'               THEN 0
       WHEN l.last_ran_at < now() - INTERVAL '26 hours' THEN 1
       WHEN z.consecutive_zeros >= 2              THEN 2
       ELSE 3
  END,
  l.scraper_name;

COMMENT ON TABLE scraper_runs IS
  'One row per scraper execution. Written by ingestion scripts via the service role.';

COMMENT ON VIEW scraper_health IS
  'Aggregated health status per scraper. Flags stale runs, error states, and consecutive zero-event runs.';
