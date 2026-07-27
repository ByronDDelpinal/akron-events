-- ════════════════════════════════════════════════════════════════════════════
-- 045_slack_triggers.sql
--
-- Slack integration, Tier 1 — part 2 of 2 (see 044's header for the split
-- rationale: 044 creates the ledger table only, this migration arms it).
--
-- Three AFTER triggers enqueue a POST to the slack-notify edge function
-- whenever a feedback-orb note is published, a subscriber signs up, or a
-- subscriber confirms.
--
-- Trigger -> function authentication
-- ───────────────────────────────────
-- An earlier version of this migration hardcoded the project's anon key as
-- both the `apikey` and `Authorization: Bearer` headers on the net.http_post
-- call, following the live `send-daily-digest` pg_cron job (cron.job jobid 1
-- on this project). The code-reviewer flagged that as a BLOCKER (2026-07-26):
-- the anon key is not a secret — it ships in the Vite bundle
-- (VITE_SUPABASE_ANON_KEY) and is trivially readable by anyone who opens
-- devtools on akronpulse.com — so hardcoding it here made slack-notify
-- publicly invocable by anyone who extracted it, with no ledger row and
-- nothing in CI referencing the literal if it were ever rotated away from.
-- Combined with `escapeSlackText` gaps in render.ts (fixed in the same pass
-- as this migration), that public invocability was the enabling condition
-- for a working `<!channel>`-ping / phishing-link exploit — see render.ts's
-- header for the fix on that side.
--
-- The `send-daily-digest` pg_cron job is deliberately named above as the
-- pattern this migration is now NOT repeating, not as a precedent to follow.
-- It shares the same exposure (anon key as trigger auth) and is out of scope
-- to fix here, but should not be copied again for future net.http_post
-- callers. NOTE for reviewers: no earlier migration in this repo defines a
-- cron.job or calls net.http_post (confirmed by grep across
-- supabase/migrations) — the send-digest job was set up directly against
-- the live database (dashboard or a one-off psql session), not via a
-- committed migration, so it isn't something `git blame` or CI can catch if
-- it drifts.
--
-- The fix: each trigger function now reads a Supabase Vault secret
-- (`slack_notify_secret`) and sends it as a custom `X-Slack-Notify-Secret`
-- header instead of the anon key. slack-notify/index.ts compares that header
-- against its own `SLACK_NOTIFY_SECRET` function secret with a timing-safe
-- comparison, BEFORE parsing the request body or making any Supabase call,
-- and rejects with 401 otherwise (see index.ts's auth-gate comment). The
-- function must still be deployed with `verify_jwt = false` — pg_net
-- triggers cannot attach a user JWT — so this header is the entire
-- authentication boundary; there is no Supabase-platform-level auth left to
-- fall back on. Only a caller that already knows `slack_notify_secret` can
-- invoke the function at all now (down from "anyone who extracts the public
-- anon key").
--
-- IMPORTANT — this migration does NOT create the Vault secret. Byron runs
-- the following by hand against the live database (never captured in a
-- committed migration, so it never sits in source control or CI logs):
--
--   select vault.create_secret('<a strong random value>', 'slack_notify_secret');
--
-- and sets the matching function secret so both sides agree:
--
--   supabase secrets set SLACK_NOTIFY_SECRET='<the same random value>'
--
-- If the Vault secret is missing (not yet created, or renamed), `v_secret`
-- below is NULL and every trigger function logs a distinguishable warning
-- and returns without enqueueing anything — fail closed, not "post
-- unauthenticated" or "post with a NULL header value" (pg_net would likely
-- error trying to serialize a NULL header, but this makes the failure
-- explicit and diagnosable instead of depending on that).
--
-- Blast radius notes that still apply post-fix (kept from the earlier
-- version of this header, still true even behind the shared secret):
--   • The request body is a discriminated {event, id} pair only. Even a
--     holder of the shared secret can choose which real feedback/subscriber
--     row gets announced, but cannot inject arbitrary text — slack-notify
--     re-reads the row itself from a hardcoded column allowlist (see
--     slack-notify/index.ts) and renders from that, never from the request
--     body's own fields.
--   • slack_notifications.dedupe_key plus the claim-first protocol in
--     slack-notify make replays no-ops: hammering the same id posts once.
--
-- Failure isolation — the load-bearing part of this migration
-- ─────────────────────────────────────────────────────────────
-- net.http_post only ENQUEUES the request; pg_net performs the actual HTTP
-- call asynchronously outside the transaction. So the only way one of these
-- triggers could break the user-facing INSERT/UPDATE is if the trigger
-- FUNCTION BODY itself raised (bad literal, missing `net` schema, whatever)
-- — a Slack outage or a slack-notify bug can never reach back into this
-- transaction. The `exception when others then raise warning ...; return
-- null;` handler in every function below is what makes THAT failure mode
-- impossible. Do not remove it: without it, a broken trigger function body
-- could turn a Slack hiccup into a failed feedback submission or a failed
-- signup.
--
-- CAVEAT (code-reviewer m9, 2026-07-26): "impossible" above is scoped to the
-- function body only. Each trigger's `WHEN (...)` clause is evaluated by the
-- trigger manager BEFORE the function is invoked — it is not inside the
-- plpgsql function, so it is not covered by that function's exception
-- handler. Two of the three WHEN clauses below (`new.category = 'orb' and
-- new.status = 'published'`, `old.confirmed is distinct from new.confirmed
-- and new.confirmed = true`) are plain literal/column comparisons that
-- cannot raise. The subscriber_signup trigger's WHEN clause is the one
-- exception: it calls moderation_request_role(), which does a `::jsonb`
-- cast on `current_setting('request.jwt.claims', true)` — if that setting
-- were ever set to a malformed JSON string, the cast raises during WHEN
-- evaluation, outside any exception handler here, and WOULD propagate back
-- into the INSERT on subscribers. In practice that setting is written by
-- PostgREST itself from a verified JWT, so malformed content isn't reachable
-- through normal request handling, and moderation_request_role() is already
-- reused (not duplicated) from migration 030, where this same exposure
-- already exists for the moderation triggers. Left as documentation rather
-- than moving the role check inside each function body: doing so would mean
-- every insert on subscribers pays for a full net.http_post-capable
-- function invocation just to evaluate a role check that WHEN already does
-- for free, for a raise condition that isn't reachable through this
-- project's own request path.
--
-- FOLLOW-UP NOTE (code-reviewer re-review, "for the next review pass",
-- 2026-07-27) — `select decrypted_secret into v_secret from
-- vault.decrypted_secrets where name = 'slack_notify_secret'` appears three
-- times below, once per trigger function. Plain `select ... into` in
-- plpgsql is NOT an error if the query returns more than one row — it
-- silently takes the FIRST row (in whatever order the planner happens to
-- produce, which is not guaranteed stable) and discards the rest. If
-- `slack_notify_secret` were ever accidentally duplicated in Vault (e.g. a
-- rerun of `vault.create_secret(...)` that doesn't overwrite, or a second
-- secret created by hand with the same name during a rotation), these
-- functions would not fail loudly — they would silently pick ONE of the
-- duplicate secrets, possibly the stale one, and every X-Slack-Notify-Secret
-- header would then silently stop matching slack-notify's
-- SLACK_NOTIFY_SECRET the moment the two diverged. Nothing here validates
-- uniqueness at query time (a `select ... into strict` would raise
-- `TOO_MANY_ROWS` instead of silently picking one, but is deliberately not
-- used here — see this migration's `exception when others` failure-isolation
-- comment above: any change that makes this select capable of raising
-- inside the function body must stay compatible with that guarantee).
--
-- Byron's runbook for creating/rotating this secret must therefore verify
-- uniqueness by hand before and after every create/rotate, since the schema
-- itself doesn't enforce it:
--
--   select count(*) from vault.secrets where name = 'slack_notify_secret';
--
-- This must return exactly 1. If it ever returns more than 1, delete the
-- stale duplicate (`select vault.delete_secret(id) from vault.secrets where
-- name = 'slack_notify_secret' and id <> '<the id to keep>'`) before trusting
-- which value these trigger functions are actually reading.
-- ════════════════════════════════════════════════════════════════════════════

begin;

create or replace function slack_notify_feedback()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'slack_notify_secret';

  if v_secret is null then
    raise warning '[slack_notify_feedback] slack_notify_secret is not set in Vault — skipping notify for feedback_posts.id=% (see 045_slack_triggers.sql header for the vault.create_secret command)', NEW.id;
    return null;
  end if;

  perform net.http_post(
    url     := 'https://hadipeqtzikxxsvtqdma.supabase.co/functions/v1/slack-notify',
    headers := jsonb_build_object(
      'Content-Type',           'application/json',
      'X-Slack-Notify-Secret',  v_secret
    ),
    body    := jsonb_build_object('event', 'feedback', 'id', NEW.id),
    timeout_milliseconds := 5000
  );
  return null;
exception when others then
  raise warning '[slack_notify_feedback] failed to enqueue for feedback_posts.id=%: %', NEW.id, SQLERRM;
  return null;
end;
$$;

-- Gated on category = 'orb' ONLY — NOT on is_private. is_private is an RLS
-- contract, not a privacy signal here: FeedbackDialog.tsx:216 hardcodes
-- is_private = true on every single orb submission, so gating on is_private
-- would mean this trigger never fires at all. If the legacy Town Square
-- board categories (bug/love/wish/confusing/idea/datasource/general) ever
-- return, extending this to those rows too is a one-line WHEN change:
-- `when (new.status = 'published' and (new.category = 'orb' or new.category != 'orb'))`
-- i.e. drop the category filter, or add an explicit `or` branch for the
-- specific categories that should also notify.
--
-- NOTE (code-reviewer m8, 2026-07-26): this is `after insert` only — there
-- is no matching `after update` trigger. A moderated-down orb note (status
-- flips away from 'published' by the moderation pipeline, then a moderator
-- later flips it back to 'published') never fires a second notification,
-- because the row already existed and this trigger only sees INSERTs. That
-- is deliberate for Tier 1 — a republish is a rarer, lower-value case than
-- the extra complexity of a second trigger + a second dedupe_key shape
-- (`feedback:{id}` already means "the initial publish", not "any published
-- state") — but it means a moderator-approved republish is currently
-- silent. Worth a follow-up if that path becomes common enough to matter.
drop trigger if exists trg_slack_feedback on feedback_posts;
create trigger trg_slack_feedback
  after insert on feedback_posts
  for each row
  when (new.category = 'orb' and new.status = 'published')
  execute function slack_notify_feedback();


create or replace function slack_notify_subscriber_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'slack_notify_secret';

  if v_secret is null then
    raise warning '[slack_notify_subscriber_signup] slack_notify_secret is not set in Vault — skipping notify for subscribers.id=% (see 045_slack_triggers.sql header for the vault.create_secret command)', NEW.id;
    return null;
  end if;

  perform net.http_post(
    url     := 'https://hadipeqtzikxxsvtqdma.supabase.co/functions/v1/slack-notify',
    headers := jsonb_build_object(
      'Content-Type',           'application/json',
      'X-Slack-Notify-Secret',  v_secret
    ),
    body    := jsonb_build_object('event', 'subscriber_signup', 'id', NEW.id),
    timeout_milliseconds := 5000
  );
  return null;
exception when others then
  raise warning '[slack_notify_subscriber_signup] failed to enqueue for subscribers.id=%: %', NEW.id, SQLERRM;
  return null;
end;
$$;

-- Gated on moderation_request_role() being anything other than 'anon'.
-- subscribers still carries an open anon INSERT policy ("Anon can
-- subscribe", migration 009) — without this gate, anyone holding the public
-- anon key could spray arbitrary emails straight into PostgREST (bypassing
-- the subscribe edge function entirely) and have every one of them
-- broadcast to the channel. moderation_request_role() is the existing
-- helper defined in supabase/migrations/030_content_moderation.sql:127,
-- reused here rather than duplicated.
--
-- CAVEAT (code-reviewer m10, 2026-07-26): moderation_request_role() reads
-- current_setting('request.jwt.claims', true) and returns NULL for any
-- non-PostgREST connection — a direct psql session, a migration, a manual
-- backfill UPDATE run by Byron. `NULL IS DISTINCT FROM 'anon'` evaluates to
-- TRUE (IS DISTINCT FROM treats NULL as a comparable, non-UNKNOWN value), so
-- this WHEN clause is satisfied for a NULL role too, not just
-- authenticated/service_role API traffic. A hand-run bulk INSERT or backfill
-- against `subscribers` from psql — e.g. importing a CSV of legacy
-- subscribers — would fire this trigger once per row and post one Slack
-- message per row. There is no bug to fix here (the intent is "skip only
-- when the API-facing anon role did the insert," and a psql session isn't
-- that), but it IS a footgun: if you are about to run a bulk INSERT/UPDATE
-- against subscribers directly against the database, either temporarily
-- drop this trigger first or be ready for a wall of Slack messages.
drop trigger if exists trg_slack_subscriber_signup on subscribers;
create trigger trg_slack_subscriber_signup
  after insert on subscribers
  for each row
  when (moderation_request_role() is distinct from 'anon')
  execute function slack_notify_subscriber_signup();


create or replace function slack_notify_subscriber_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'slack_notify_secret';

  if v_secret is null then
    raise warning '[slack_notify_subscriber_confirmed] slack_notify_secret is not set in Vault — skipping notify for subscribers.id=% (see 045_slack_triggers.sql header for the vault.create_secret command)', NEW.id;
    return null;
  end if;

  perform net.http_post(
    url     := 'https://hadipeqtzikxxsvtqdma.supabase.co/functions/v1/slack-notify',
    headers := jsonb_build_object(
      'Content-Type',           'application/json',
      'X-Slack-Notify-Secret',  v_secret
    ),
    body    := jsonb_build_object('event', 'subscriber_confirmed', 'id', NEW.id),
    timeout_milliseconds := 5000
  );
  return null;
exception when others then
  raise warning '[slack_notify_subscriber_confirmed] failed to enqueue for subscribers.id=%: %', NEW.id, SQLERRM;
  return null;
end;
$$;

-- Fires exactly on the false -> true edge: never on an insert (confirmed
-- starts false), never on a re-save that leaves confirmed unchanged, never
-- on a true -> false transition if one is ever added later.
drop trigger if exists trg_slack_subscriber_confirmed on subscribers;
create trigger trg_slack_subscriber_confirmed
  after update of confirmed on subscribers
  for each row
  when (old.confirmed is distinct from new.confirmed and new.confirmed = true)
  execute function slack_notify_subscriber_confirmed();

commit;
