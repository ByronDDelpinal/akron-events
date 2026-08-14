-- ════════════════════════════════════════════════════════════════════════════
-- 057_digest_sweep_cron.sql
--
-- Crash-recovery sweep for the send-digest chain (design memo, 2026-08-13:
-- "send-digest CPU exhaustion at 100+ subscribers").
--
-- MIGRATION NUMBER: 057. 047 is reserved by the unlanded
-- agents/digest-delivery-truth branch — do not reuse it (same rule 052
-- followed).
--
-- What this is
-- ────────────
-- send-digest now processes subscribers in self-chaining slices of 25
-- (see supabase/functions/send-digest/chain.ts). If any link of the chain
-- dies mid-run (isolate eviction, deploy, crash), the day's cohort is left
-- partially sent. This job re-fires the SAME URL the 12:30 UTC digest cron
-- (pg_cron jobid 1, `send-daily-digest`) hits, 30 minutes later. The
-- function's own idempotency does all the real work:
--   - subscribers already logged in email_sends for today's scheduled
--     session are pre-filtered out (a completed chain → the sweep walks its
--     links processing 0 and makes ZERO Resend calls);
--   - a slice that reached Resend but crashed before logging re-forms
--     deterministically, reproduces the same membership-derived idempotency
--     key, and Resend dedupes (409 → recorded as sent);
--   - so a double-fire, an overlap with a still-running chain, or a sweep
--     of a fully-healthy day are all harmless by construction.
-- Deploy ORDER (per the memo): the updated send-digest function first, this
-- migration second. The sweep is useless-not-harmful before the function
-- understands re-fires — strictly safe either order, but that order is
-- cleaner.
--
-- Authentication — same headers as jobid 1, on purpose
-- ────────────────────────────────────────────────────
-- jobid 1 sends the project's publishable anon key as both `apikey` and
-- `Authorization: Bearer` (documented in 045_slack_triggers.sql, which
-- names that pattern as one NOT to copy for NEW surfaces). It is repeated
-- here deliberately and narrowly, per the approved design memo: this job
-- must authenticate exactly like jobid 1 so it succeeds and fails in
-- lockstep with the digest cron it backs up (e.g. if CRON_SECRET is ever
-- set on the function, both jobs break together, not one silently). It
-- also adds NO new exposure: the anon key already ships in the Vite bundle
-- and can already invoke this exact function; the function's idempotency
-- (above) means an attacker re-firing it can only cause the sends the daily
-- cron would cause anyway, and never duplicates. Fixing jobid 1's auth
-- story is a separate, deliberate piece of work — when it happens, migrate
-- this job in the same change.
--
-- pg_cron schedule lives HERE, in the migration, not only in the live
-- cron.job table — explicitly better than jobid 1 (the digest), whose
-- schedule exists nowhere in the repo. Wrapped so re-running this migration
-- (branch reset, local `supabase db reset`) is safe — cron.schedule is
-- idempotent on the job name in recent pg_cron, but do not rely on it.
-- ════════════════════════════════════════════════════════════════════════════

select cron.unschedule('send-daily-digest-sweep')
 where exists (select 1 from cron.job where jobname = 'send-daily-digest-sweep');

select cron.schedule(
  'send-daily-digest-sweep',
  '0 13 * * *',                       -- 13:00 UTC = 30 min after jobid 1's 12:30
  $$
  select net.http_post(
    url     := 'https://hadipeqtzikxxsvtqdma.supabase.co/functions/v1/send-digest',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhhZGlwZXF0emlreHhzdnRxZG1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMTQ2OTUsImV4cCI6MjA4OTY5MDY5NX0.NgmFLWVofXhCYon5aubSd8ZAp_o9naw7MjraVREQUKc',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhhZGlwZXF0emlreHhzdnRxZG1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMTQ2OTUsImV4cCI6MjA4OTY5MDY5NX0.NgmFLWVofXhCYon5aubSd8ZAp_o9naw7MjraVREQUKc'
    ),
    body    := '{}'::jsonb,           -- empty body = scheduled mode, link 0
    timeout_milliseconds := 10000     -- covers link 0's response; later links
                                      -- self-chain in the background and do
                                      -- not depend on this request staying open
  );
  $$
);

-- DST CAVEAT, stated because the digest (pg_cron jobid 1) already has this
-- open bug: '15 8 * * *' is UTC, so this runs 4:15am EDT / 3:15am EST. For a
-- purge job that is irrelevant -- the same unsolved winter drift that matters
-- for an 8:30am email does not matter for a 4am delete. Do not "fix" it here
-- and do not let it be cited as a precedent for the digest's own bug.
-- [Carried unchanged from 052 per the design memo. For THIS job the schedule
-- is '0 13 * * *': it drifts with jobid 1 by construction — the sweep must
-- always fire ~30 minutes after the digest, in every season, and it does,
-- because both are pinned UTC. If jobid 1's drift is ever fixed, move this
-- job by the same amount in the same change.]
--
-- VERIFICATION QUERIES for the maintainer, after this migration lands:
--   select jobid, jobname, schedule, active, command from cron.job order by jobid;
--   select jobid, status, return_message, start_time
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'send-daily-digest-sweep')
--    order by start_time desc limit 7;
-- And in the function logs on the first scheduled morning after deploy:
--   12:30 run: "chain start" → N × "link=" → "chain complete";
--   13:00 sweep: "chain start ... remaining=0" and NO new Resend sends.
