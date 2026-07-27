-- ════════════════════════════════════════════════════════════════════════════
-- 046_slack_tier2.sql
--
-- Slack integration, Tier 2 — hard prerequisite for the agent-authored
-- `daily_report` / `night_crew` notification kinds.
--
-- WHY THIS MIGRATION IS MANDATORY, NOT OPTIONAL:
-- 044_slack_notifications.sql:30 defines slack_notifications.kind with a CHECK
-- constraint limited to ('feedback','subscriber_signup','subscriber_confirmed').
-- Tier 2 (slack-notify's new `agent_post` request arm — see
-- supabase/functions/slack-notify/index.ts) claims a dedupe_key with
-- `kind='daily_report'` or `kind='night_crew'`, neither of which that CHECK
-- allows. Without this migration, EVERY Tier 2 claim insert raises
-- SQLSTATE 23514 (check_violation), the claim query in slack-notify returns
-- an error (not zero rows — a genuine failure), the handler logs
-- `[slack-notify] claim insert failed` and returns HTTP 500 `{error:'claim
-- failed'}`, and nothing posts to Slack and nothing lands in the ledger. That
-- failure is invisible outside the edge function's own logs: there is no
-- ledger row to query (the claim itself is what failed), so a support/data
-- agent trying to post a report would see a bare 500 with no trace in the
-- database at all. This migration must ship and be applied before either new
-- kind is ever POSTed.
--
-- What this migration does, and does not, do:
--   • Widens the kind CHECK to also allow 'daily_report' and 'night_crew'.
--   • Adds `thread_ts text` (nullable) — audit-only. Tier 2 callers may pass
--     a `thread_ts` (the root message's Slack `ts`) to post as a threaded
--     reply rather than a new top-level message (e.g. a follow-up correction
--     on the same day's report); slack-notify persists whatever `ts` it
--     threads under, or receives, into this column on settle, purely so a
--     human reading the ledger can see the threading relationship. Nothing
--     in the database reads this column back; it's forensic, not functional.
--   • Does NOT touch RLS. The existing "Authenticated can read
--     slack_notifications" policy (044) already covers Tier 2 rows — it is
--     defined with `using (true)` over the whole table, not scoped by kind,
--     so no new policy is needed for the two new kinds to be readable the
--     same way Tier 1 rows already are. No anon policy existed before this
--     migration and none is added now.
--   • Does NOT add a new index. dedupe_key already carries a `unique`
--     constraint from 044 — the exact conflict target slack-notify's
--     `ON CONFLICT (dedupe_key) DO NOTHING` needs already exists and needs no
--     new index for Tier 2's dedupe keys (`daily_report:{run_key}`,
--     `night_crew:{run_key}`), which are just more values in the same
--     already-unique column.
--
-- Channel/capability split (enforced in code, not in this migration):
-- slack-notify's `planFor` is what maps `run_key` to a fully-derived
-- `daily_report:{run_key}` / `night_crew:{run_key}` dedupe key and a fixed
-- channel (`daily-reports` / `the-night-crew`), and its auth gate is what
-- restricts the new `agent_post` request shape to callers holding
-- SLACK_AGENT_SECRET (never SLACK_NOTIFY_SECRET). This migration only makes
-- the resulting rows legal to insert; see that file's header for the full
-- namespace-collision threat model (why the caller supplies `run_key` only,
-- never a raw `dedupe_key`).
-- ════════════════════════════════════════════════════════════════════════════

begin;

alter table slack_notifications drop constraint if exists slack_notifications_kind_check;
alter table slack_notifications add constraint slack_notifications_kind_check
  check (kind in ('feedback','subscriber_signup','subscriber_confirmed',
                  'daily_report','night_crew'));

alter table slack_notifications add column if not exists thread_ts text;

commit;
