-- ════════════════════════════════════════════════════════════════════════════
-- 060_reviewed_at.sql
--
-- BUG FIX: admin approvals do not survive the nightly re-scrape.
--
-- ROOT CAUSE. `events.needs_review` carries two different facts under one name:
--
--   (a) the scraper's per-run confidence assessment - "only 'other' matched",
--       "geo is unknown", "I synthesized this start time". This is a DERIVED
--       value and it is CORRECT for the scraper to recompute it every night.
--   (b) the human's triage state - "I looked at this and it is fine". This is
--       a fact about a person and is not derivable from the row.
--
-- `scripts/lib/normalize.js:1803-1806` recomputes (a) on every run whenever
-- needs_review is undefined, which is the default scraper path, and writes it
-- into the column that also stores (b). `_stripOverriddenFields` (:2052-2079)
-- cannot protect it because it only removes payload keys that appear in
-- `manual_overrides`, and `needs_review` is not one of them.
--
-- The comment at `023_needs_review.sql:4-5` claims the opposite:
--   "Protected by manual_overrides: once category is manually locked, the
--    scraper won't touch category OR needs_review for that event."
-- That protection was NEVER BUILT. The scraper touches needs_review every run.
--
-- MEASURED on production 2026-08-21: the queue holds 508 rows (200 upcoming).
-- 159 of the 200 are unprotected, and 148 of those demonstrably received a
-- write from the previous night's run. Approving or dismissing any of them
-- today is reverted before morning.
--
-- FIX: split the two facts. `needs_review` keeps its exact current meaning and
-- stays freely recomputed by the pipeline. `reviewed_at` is the human decision
-- and is written ONLY by admin paths. The review queue predicate becomes
--
--     needs_review = true AND reviewed_at IS NULL
--
-- This survives the re-scrape with NO new protection machinery, because
-- PostgREST upsert compiles to `INSERT ... ON CONFLICT DO UPDATE SET <only the
-- columns present in the payload>`. `reviewed_at` will never be in a scraper
-- payload. This is the identical mechanism by which `manual_overrides` already
-- survives ~4,900 nightly row updates today.
--
-- ⚠️  REJECTED ALTERNATIVE - do NOT "just" add needs_review to manual_overrides.
--     The live BEFORE UPDATE trigger `trg_enforce_manual_overrides_events`
--     restores any pinned column whose marker value is unchanged, INCLUDING
--     against the admin UI. Production already contains 819 rows carrying a
--     `needs_review` key, 51 of them pinned at true, where the Dismiss button
--     returns success and the trigger silently reverts the write. Pinning is
--     what CREATED that stall; it cannot also be the cure. The backfill below
--     frees those 51 rows without re-stamping anything.
--
-- ⚠️  NEVER add `reviewed_at` to a scraper payload. Its omission from the
--     upsert IS the protection mechanism. Adding it reintroduces this bug.
--
-- DEPLOY NOTES
--   • Byron applies migrations himself. DO NOT APPLY THIS MIGRATION.
--   • Do NOT apply during the nightly scrape window. The run holds row locks on
--     `events`; 2026-08-21's run finished at 03:39 UTC, so avoid 01:30-04:00.
--   • Rollback lives in `supabase/rollbacks/060_reviewed_at_rollback.sql`.
--     Rollback scripts NEVER live in supabase/migrations/ - `supabase db push`
--     applies them as migrations and instantly undoes the change.
--   • This migration is DDL + one single-column backfill. It changes nothing
--     observable on its own: no reader of `reviewed_at` exists until the
--     frontend change ships. Migration first, frontend second.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- 059 takes ACCESS EXCLUSIVE on many tables; this one is narrower, but the
-- nightly pipeline can still hold `events` row locks. Fail fast rather than
-- queueing behind a scrape.
set local lock_timeout = '5s';

-- ── 1. The human decision, as its own fact ────────────────────────────────
alter table events
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id);

comment on column events.reviewed_at is
  'When an administrator adjudicated this row in the review queue. NULL means '
  'not yet triaged. Written ONLY by admin paths - never by a scraper, and never '
  'in an upsert payload (see the 060 header). `needs_review` remains the '
  'scraper''s per-run confidence signal and is freely recomputed; this column is '
  'what makes an approval survive the next run.';

comment on column events.reviewed_by is
  'Which administrator adjudicated the row (auth.users.id, from auth.uid() on '
  'the client). Nullable: rows backfilled from manual_overrides in 060 have a '
  'timestamp but no attributable actor.';

-- ── 2. Backfill from the accidental pins ──────────────────────────────────
-- 819 rows carry a `manual_overrides.needs_review` marker. That marker IS the
-- record that a human already adjudicated the row, and its `at` is when. Adopt
-- it so nobody's completed triage silently reappears in the queue.
--
-- ⚠️  THIS STATEMENT SETS EXACTLY ONE COLUMN AND MUST STAY THAT WAY.
--     Re-stamping a manual_overrides key with a different value tells
--     `enforce_manual_overrides` to stop protecting that key's column for the
--     UPDATE. Adding a second SET clause here would silently un-pin 819 rows.
update events
   set reviewed_at = nullif(manual_overrides -> 'needs_review' ->> 'at', '')::timestamptz
 where manual_overrides ? 'needs_review'
   and jsonb_typeof(manual_overrides -> 'needs_review') = 'object'
   and (manual_overrides -> 'needs_review' ->> 'at') is not null
   and reviewed_at is null;

-- ── 3. Index matching the new queue predicate ─────────────────────────────
-- 023's index keys on (needs_review, start_at) and no longer matches.
create index if not exists idx_events_untriaged
  on events (start_at)
  where needs_review and reviewed_at is null;

-- ── 4. What legitimately RE-OPENS a settled review ────────────────────────
-- A human's "this is fine" was a judgement about a specific title at a specific
-- time. If a scraper materially changes either, the judgement no longer applies
-- and the row deserves another look. Description is deliberately excluded: it
-- churns constantly on aggregator sources and would re-open the queue on
-- whitespace.
--
-- ⚠️  TRIGGER NAME IS LOAD-BEARING. Same-timing triggers fire in NAME ORDER, and
--     this one MUST fire AFTER `trg_enforce_manual_overrides_events`
--     ('trg_enf...' < 'trg_eve...'). If it fired first it would compare against
--     the scraper's incoming title on rows where a human LOCKED the title, see a
--     difference, and clear reviewed_at every single night on exactly the rows
--     that were most deliberately settled. Do not rename this trigger.
--
-- ⚠️  EXEMPTION LIST IS THE INVERSE OF 059's ON ONE ENTRY. 059's four
--     moderation_screen_* functions exempt service_role. This one MUST NOT:
--     the scraper is the caller this trigger exists for. Do not copy-paste.
create or replace function reopen_review_on_material_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Direct DB access (SQL editor, NULL claims) and administrators are editing
  -- deliberately. An admin retitling a row must not clear their own decision.
  if moderation_request_role() is null or is_admin() then
    return NEW;
  end if;

  -- IS DISTINCT FROM, not <>: a NULL on either side must count as a change.
  if NEW.title IS DISTINCT FROM OLD.title
     or NEW.start_at IS DISTINCT FROM OLD.start_at
  then
    NEW.reviewed_at := null;
    NEW.reviewed_by := null;
  end if;

  return NEW;
end; $$;

revoke all on function reopen_review_on_material_change() from public;

drop trigger if exists trg_events_reopen_review on events;
create trigger trg_events_reopen_review
  before update of title, start_at on events
  for each row execute function reopen_review_on_material_change();

commit;
