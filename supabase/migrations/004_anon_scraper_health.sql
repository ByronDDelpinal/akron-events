-- =============================================================================
-- 004_anon_scraper_health.sql
--
-- Allow anonymous (public) read access to scraper_runs so the frontend
-- Technical Details page can query the scraper_health view without
-- requiring authentication.
--
-- The scraper_runs data is purely operational/status info (timestamps, counts,
-- error messages) — there is nothing sensitive here, and surfacing it publicly
-- gives the community transparency into how the data pipeline works.
-- =============================================================================

CREATE POLICY "Anon users can read scraper_runs"
  ON scraper_runs FOR SELECT
  USING (true);
