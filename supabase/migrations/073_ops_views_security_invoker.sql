-- ============================================================
-- Ops views: stop bypassing RLS, and make scraper_health answer in time
--
-- Problem 1 (security advisor ERROR x2, open since 2026-08-02):
-- scraper_health and v_dupe_candidates were plain views, which in Postgres
-- run with the OWNER's rights. Both carried the default Supabase grants to
-- anon and authenticated, so anyone with the publishable key read them
-- straight through the underlying tables' row level security.
--
-- Problem 2 (found 2026-11-10): scraper_health had become too slow to serve.
-- Its zero-streak CTE ran a correlated "latest non-zero run" lookup once per
-- zero-yield row, each one walking scraper_runs by ran_at. At 19,958 runs
-- that was 3,065 lookups discarding about 8,900 rows apiece: 9.1 seconds.
-- anon's statement_timeout is 3s, so the public /technical page's health
-- table had been returning HTTP 500, and every attempt held a small database
-- at full CPU long enough to time out unrelated event-list queries beside it.
--
-- Fix:
--   * scraper_health is public ON PURPOSE (the /technical page reads it
--     signed out, and scraper_runs has an "Anon users can read scraper_runs"
--     policy, USING true). It is rebuilt as a single window pass over
--     scraper_runs and switched to invoker rights. Same columns, same types,
--     same rows: verified against the old definition with EXCEPT in both
--     directions (164 scrapers, 0 differences) before this was applied.
--   * v_dupe_candidates is internal. No page reads it, and the dedupe scripts
--     use the service role, which keeps access through its own grant. It is
--     revoked from both API roles and made invoker-rights too, so a future
--     re-grant cannot quietly reopen the bypass.
--
-- total_runs keeps its historical meaning (runs counted in the last-5 window,
-- so at most 5) because the /technical page and check-scraper-health.js read
-- the column as-is; renaming it is a separate change.
--
-- Idempotent: safe to re-run.
-- ============================================================

CREATE OR REPLACE VIEW public.scraper_health
WITH (security_invoker = on) AS
WITH ranked AS (
  SELECT sr.scraper_name,
         sr.ran_at,
         sr.status,
         sr.events_found,
         sr.error_message,
         row_number() OVER (PARTITION BY sr.scraper_name ORDER BY sr.ran_at DESC) AS rn,
         max(sr.ran_at) FILTER (WHERE sr.events_found > 0)
           OVER (PARTITION BY sr.scraper_name) AS last_nonzero_at
    FROM scraper_runs sr
), per_scraper AS (
  SELECT r.scraper_name,
         max(r.ran_at)        FILTER (WHERE r.rn = 1) AS last_ran_at,
         max(r.status)        FILTER (WHERE r.rn = 1) AS last_status,
         max(r.events_found)  FILTER (WHERE r.rn = 1) AS last_events_found,
         max(r.error_message) FILTER (WHERE r.rn = 1) AS last_error,
         count(*) FILTER (
           WHERE r.events_found = 0
             AND r.ran_at > COALESCE(r.last_nonzero_at, '-infinity'::timestamptz)
         ) AS consecutive_zeros,
         round(avg(r.events_found) FILTER (WHERE r.rn <= 5)) AS avg_events_last5,
         count(*) FILTER (WHERE r.rn <= 5) AS total_runs
    FROM ranked r
   GROUP BY r.scraper_name
)
SELECT p.scraper_name,
       p.last_ran_at,
       round(EXTRACT(epoch FROM now() - p.last_ran_at) / 3600.0, 1) AS hours_since_run,
       p.last_status,
       p.last_events_found,
       p.last_error,
       p.consecutive_zeros,
       p.avg_events_last5,
       p.total_runs,
       p.last_ran_at < (now() - '26:00:00'::interval) AS is_stale,
       p.consecutive_zeros >= 2 AS is_zero_streak,
       p.last_status = 'error'::text AS is_error,
       CASE
         WHEN p.last_status = 'error'::text
           THEN 'ERROR: '::text || COALESCE(p.last_error, 'unknown error'::text)
         WHEN p.last_ran_at < (now() - '26:00:00'::interval)
           THEN ('STALE: last run '::text
                 || round(EXTRACT(epoch FROM now() - p.last_ran_at) / 3600.0, 0)::text)
                 || 'h ago'::text
         WHEN p.consecutive_zeros >= 2
           THEN ('ZERO EVENTS: '::text || p.consecutive_zeros::text)
                 || ' consecutive runs returned 0 events'::text
         ELSE NULL::text
       END AS alert
  FROM per_scraper p
 ORDER BY (CASE
             WHEN p.last_status = 'error'::text THEN 0
             WHEN p.last_ran_at < (now() - '26:00:00'::interval) THEN 1
             WHEN p.consecutive_zeros >= 2 THEN 2
             ELSE 3
           END),
          p.scraper_name;

ALTER VIEW public.v_dupe_candidates SET (security_invoker = on);

-- Neither view is updatable; drop the write grants the defaults handed out.
REVOKE ALL ON public.scraper_health FROM anon, authenticated;
GRANT SELECT ON public.scraper_health TO anon, authenticated;

REVOKE ALL ON public.v_dupe_candidates FROM anon, authenticated;
