-- ════════════════════════════════════════════════════════════════════════════
-- 065_submission_publish_log.sql
--
-- Append-only audit trail for the `nightly-submission-publish` scheduled task
-- (.agents/nightly-submission-publish.md).
--
-- ✅  APPLIED to prod 2026-08-27, ledger row ('065','submission_publish_log')
--     inserted in the same transaction so version matches this filename.
--     Verified after: rls_on = true, 0 policies, anon/authenticated SELECT
--     false, service_role INSERT true.
--
--     (Authored 2026-08-26 when the highest version was 064.) 047 is
--     still missing from the sequence and stays missing (057's header records
--     it as reserved by an unlanded branch); nothing here fills it. The ledger
--     `version` MUST match this file's `065` prefix or the ledger drifts.
--
--     The nightly task is written to run WITHOUT this table: it probes
--     `to_regclass('public.submission_publish_log')` and, on NULL, logs to
--     scrape-reports/agent-log-YYYY-MM-DD.md only and says so in its report.
--     Applying this migration upgrades the audit trail from prose to rows; it
--     is not a prerequisite for the job to be safe.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
--
-- THE PENDING_REVIEW AMBIGUITY. `organizations.status` and `venues.status` are
-- constrained to ('published','pending_review','cancelled'), and
-- 'pending_review' is doing two completely different jobs at once:
--
--   (a) "a human has not looked at this yet"  — the public submit forms
--       (OrganizationSubmitPage.tsx, VenueSubmitPage.tsx) hardcode
--       status 'pending_review' on every insert; and
--   (b) "a machine looked at this and decided NOT to publish it" — which is
--       what the nightly task produces when a gate holds a row.
--
-- Those two states are byte-identical in the table. Nothing currently consumes
-- (a) at all, which is how submissions sat invisible for up to 58 days until a
-- submitter complained. Once a nightly job starts sweeping the queue, the two
-- become indistinguishable in a worse way: a row still sitting in
-- pending_review tomorrow could be brand new, or it could have been examined
-- and held every night for a month for a reason nobody recorded.
--
-- `organizations` has no reviewed_at, no needs_review and no severity column
-- to carry that reason (060_reviewed_at.sql landed on `events` only), and
-- `organizations.manual_overrides` is inert while `venues.manual_overrides` is
-- HONORED and pins columns — so stamping the decision onto the row itself is
-- either impossible or actively harmful. It goes in a side table instead.
--
-- WHY NOT `scraper_runs`. Deliberately not reused. scripts/check-scraper-health.js
-- and src/lib/admin/useShellCounts.ts both read that table by scraper_name, so
-- a synthetic run row becomes a phantom scraper in the admin dashboard and in
-- the health check. Different grain, different consumer, different table.
--
-- ── APPEND-ONLY ─────────────────────────────────────────────────────────────
-- This table is APPEND-ONLY BY CONVENTION AND BY GRANT, not by trigger. Every
-- row is one gate decision about one candidate row at one point in time. It is
-- a ledger: an entry is never corrected in place, never deleted, and never
-- back-dated. A wrong decision is recorded and then a NEW row records the
-- correction. There is deliberately no updated_at, no `resolved` flag and no
-- unique key on (table_name, row_id) — the same row_id legitimately appears
-- once per nightly run for as long as it stays held, and that repetition IS
-- the signal ("held 31 nights running for the same reason").
--
-- No UPDATE or DELETE trigger enforces this, for the same reason 059 does not
-- FORCE row level security on admin_users: the only principals that can reach
-- this table at all are service_role and postgres, both of which bypass RLS,
-- and a trigger they can also bypass buys nothing but a false sense of it.
-- The enforcement that matters is that nothing in src/, api/ or
-- supabase/functions/ ever writes here.
--
-- ── ACCESS ──────────────────────────────────────────────────────────────────
-- RLS enabled with NO policies, plus the grants revoked outright. Same shape
-- as 030:40-44 (moderation_terms / moderation_allowlist) and 059:1 §1
-- (admin_users): anon and authenticated get zero rows AND cannot reach the
-- table through PostgREST at all. service_role (the nightly task) and postgres
-- (the Supabase SQL editor) bypass RLS and are the only readers/writers.
--
-- Rows here name held submissions and the reason they were held, including
-- moderation verdicts. That is triage data about real submitters. It is not
-- public, it is not for `authenticated`, and it must never be surfaced through
-- the browser client.
--
-- DO NOT APPLY THIS MIGRATION. The maintainer applies migrations himself.
-- ════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

create table if not exists submission_publish_log (
  id          bigserial primary key,

  -- Which queue the candidate came from. Constrained rather than free text so
  -- a typo'd table_name cannot quietly create a third, unreadable partition of
  -- the ledger.
  table_name  text        not null check (table_name in ('organizations','venues')),

  -- The candidate's id. Intentionally NOT a foreign key: this is an audit
  -- ledger and it must survive the row it describes being hard-deleted by an
  -- admin. `on delete cascade` would erase exactly the history someone would
  -- come here to read.
  row_id      uuid        not null,

  -- Snapshot of the name AT DECISION TIME. Denormalized on purpose, for the
  -- same reason: the ledger has to stay readable after the row is renamed or
  -- removed.
  row_name    text,

  -- What the job did to this candidate. FOUR outcomes, not two -- and the
  -- distinction between them is load-bearing, not cosmetic:
  --
  --   'published'     the row moved pending_review -> published. The job's ONLY
  --                   write to organizations/venues. It never writes 'cancelled'.
  --   'held'          a gate said no. Still pending_review. NOT a rejection --
  --                   it is looked at again tomorrow.
  --   'deferred'      every gate passed, but the run had already published its
  --                   10-per-table cap. Still pending_review, through no fault
  --                   of the row. First in line next run.
  --   'skipped_raced' the compare-and-set UPDATE matched zero rows, i.e. a human
  --                   or another process moved the row between the snapshot and
  --                   the write. Not an error and not a verdict.
  --
  -- 'deferred' and 'skipped_raced' MUST NOT be recorded as 'held'. The
  -- "held N nights running" query that escalates a stuck submission to Byron
  -- filters on decision = 'held', and folding a capped-out or raced row into
  -- that bucket manufactures a stuck row that was never stuck.
  decision    text        not null check (decision in ('published','held','deferred','skipped_raced')),

  -- Short machine-ish slug for the FIRST gate that stopped the row. NULL when
  -- decision is 'published'. Prose belongs in the agent-log section, not here.
  -- The complete vocabulary, which the task file repeats verbatim -- keep the
  -- two in step, because a slug invented at 4am is a slug no query will find:
  --
  --   with decision 'held':
  --     moderation_contextual, moderation_high, moderation_extreme,
  --     moderation_contact_fields,
  --     summit_out, summit_unknown, summit_unknown_akron_default,
  --     summit_state_missing, summit_coords_unresolved,
  --     duplicate_exact, duplicate_prefix, duplicate_trigram, blank_name,
  --     llm_flag, org_incoherent, gate_error
  --   with decision 'deferred':      deferred_cap
  --   with decision 'skipped_raced': skipped_raced
  --   with decision 'published':     NULL
  --
  -- NEVER put a matched term, or any moderated text, in here. Store the
  -- severity, not the slur.
  hold_reason text,

  -- Per-gate verdicts, e.g.
  --   {"A":"pass","B":"pass","C":"in","D":"clear"}
  --   {"A":"pass","B":"skipped","C":"unknown","D":"not_run"}
  -- Free-form on purpose: the gate set will change and a rigid column per gate
  -- would need a migration every time it does.
  gates       jsonb       not null default '{}'::jsonb,

  ran_at      timestamptz not null default now()
);

-- "What happened last night" / "show me the last N runs" — the dominant read.
create index if not exists submission_publish_log_ran_at_idx
  on submission_publish_log (ran_at desc);

-- "What is the full history of THIS submission" — the question the
-- pending_review ambiguity actually raises, and the reason repetition is
-- allowed above.
create index if not exists submission_publish_log_row_idx
  on submission_publish_log (table_name, row_id);

alter table submission_publish_log enable row level security;

-- No policies of any kind => anon and authenticated get zero rows. Deliberately
-- NOT forced: nothing here is SECURITY DEFINER, and forcing it would only
-- surprise a future definer function without adding a boundary that
-- service_role and postgres do not already bypass.

-- Belt and braces, matching 030:43-44 and 059 §1: revoke the default schema
-- grants so the table is not reachable through PostgREST even if a policy is
-- ever added by accident.
revoke all on submission_publish_log from anon, authenticated;
revoke all on sequence submission_publish_log_id_seq from anon, authenticated;

commit;
