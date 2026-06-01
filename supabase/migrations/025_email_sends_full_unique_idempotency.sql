-- ─────────────────────────────────────────────────────────────────
-- email_sends.idempotency_key: convert partial unique index → full
-- unique index so PostgREST's `ON CONFLICT (idempotency_key)` works.
-- ─────────────────────────────────────────────────────────────────
--
-- Background
--   Migration 009 created:
--     CREATE UNIQUE INDEX idx_email_sends_idempotency
--       ON email_sends (idempotency_key)
--       WHERE idempotency_key IS NOT NULL;
--
--   That's a PARTIAL index. Postgres requires `ON CONFLICT (col)` to
--   match an index whose predicate is *identical* (including NULL),
--   and PostgREST's `.upsert(rows, { onConflict: 'idempotency_key' })`
--   emits a bare `ON CONFLICT (idempotency_key)` — no predicate.
--   Result: 42P10 "there is no unique or exclusion constraint matching
--   the ON CONFLICT specification" on every send-digest run.
--
-- Why this is safe
--   Every row that send-digest inserts has a non-null
--   idempotency_key. Postgres treats NULLs as distinct in unique
--   indexes by default, so even hypothetical NULL rows can coexist;
--   the constraint only enforces uniqueness across the non-null
--   keys, same as before.
--
-- Behavior delta
--   Functional behavior is unchanged for callers. PostgREST's
--   onConflict resolution now matches the index, so the upsert in
--   send-digest stops failing.

drop index if exists idx_email_sends_idempotency;

create unique index idx_email_sends_idempotency
  on email_sends (idempotency_key);
