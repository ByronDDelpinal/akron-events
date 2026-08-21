-- ════════════════════════════════════════════════════════════════════════════
-- 060_reviewed_at_rollback.sql
--
-- ⚠️  THIS IS NOT A MIGRATION. It lives in supabase/rollbacks/ deliberately.
--     A rollback script placed in supabase/migrations/ is picked up by
--     `supabase db push` and applied immediately after the migration it undoes.
--     That happened on 2026-08-21 with 059 and silently reverted it; the only
--     visible symptom was a schema_migrations duplicate-key error AFTER the
--     damage was committed. Run this by hand, never via the CLI.
--
-- Undoes 060_reviewed_at.sql. Safe at any time: nothing outside the admin UI
-- reads `reviewed_at`, and the pipeline never writes it.
--
-- ⚠️  ORDER MATTERS. If the frontend change has already shipped, roll THAT back
--     first. The review queue selects `.is('reviewed_at', null)`; dropping the
--     column underneath a deployed frontend 400s every queue load and every
--     Approve. Migration-first on the way in means frontend-first on the way out.
--
-- ⚠️  WHAT IS LOST. Dropping `reviewed_at` discards every triage decision made
--     since 060 shipped. The 819 rows backfilled from
--     `manual_overrides.needs_review` are recoverable (the markers are still
--     there, untouched - the backfill only ever read them). Anything adjudicated
--     AFTER 060 exists nowhere else and cannot be recovered. Export it first:
--
--       select id, title, reviewed_at, reviewed_by from events
--        where reviewed_at is not null
--          and not (manual_overrides ? 'needs_review');
--
--     Rolling back also returns those rows to the queue, including the 51 that
--     are pinned at needs_review = true and cannot be dismissed from the UI.
-- ════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

drop trigger if exists trg_events_reopen_review on events;
drop function if exists reopen_review_on_material_change();

drop index if exists idx_events_untriaged;

alter table events
  drop column if exists reviewed_by,
  drop column if exists reviewed_at;

commit;
