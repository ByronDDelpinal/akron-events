-- ════════════════════════════════════════════════════════════════════════════
-- 042_restore_anon_event_submission.sql
--
-- BUG FIX: the public Submit form has been broken since migration 038.
--
-- 038 closed the wide-open anon RLS surface and its header promised that
-- "anon INSERT of pending_review submissions (event submit, venue/org signup)"
-- would keep working. That held for organizations and venues, which have had
-- scoped anon INSERT policies since 006 — but `events` NEVER had an anon
-- INSERT policy in any migration (the submit form worked against the
-- dashboard-era grants that 038's audit cleaned up). Result: every public
-- event submission fails with a 401 RLS violation on POST /rest/v1/events.
-- First user report: 2026-07-20 (EarthQuaker Day organizer).
--
-- This policy mirrors "Anon can insert pending organizations" (006/038) with
-- two deliberate differences:
--
--   • status may also be 'cancelled': the content-moderation BEFORE trigger
--     (030) flips extreme-severity submissions to status='cancelled' BEFORE
--     the WITH CHECK runs. Allowing it preserves 030's design of silently
--     quarantining that content instead of returning an RLS error to the
--     submitter. Anon can't read cancelled rows either way.
--
--   • source must be 'manual': the API can't forge scraper-attributed rows.
--     Scrapers use service_role (bypasses RLS) and are unaffected.
--
--   • featured must stay false: featured placement is a human-only decision
--     made in the admin UI, never derivable from a submission.
--
-- Note for clients (SubmitPage.tsx): anon SELECT on events remains published-
-- only, so INSERT ... RETURNING (`.select()` in supabase-js) fails on a
-- pending_review row — Postgres applies SELECT policies to RETURNING. Clients
-- must generate the id client-side and insert without RETURNING.
-- ════════════════════════════════════════════════════════════════════════════

create policy "Anon can insert pending events"
  on events for insert to anon
  with check (
    status in ('pending_review', 'cancelled')
    and source = 'manual'
    and coalesce(featured, false) = false
  );
