-- ════════════════════════════════════════════════════════════════════════════
-- 051_embed_requests.sql
--
-- Backs the "request an embed" form at the bottom of /embed-builder.
--
-- Two independent changes, deliberately in ONE migration because neither one
-- arms anything on its own (unlike the 044/045 split, where 045 armed live
-- triggers and Byron wanted a smoke-test point in between):
--   1. the embed_requests table + RLS + a velocity-cap trigger;
--   2. widening slack_notifications.kind to allow the new 'embed_request'.
--
-- (2) is MANDATORY, for exactly the reason 046_slack_tier2.sql spells out:
-- slack-notify claims its dedupe key with kind='embed_request', and if the
-- CHECK constraint rejects that value the claim INSERT raises 23514, the
-- handler returns HTTP 500 'claim failed', and NOTHING lands anywhere —
-- no Slack message and no ledger row to find it by. The failure is invisible
-- outside the edge function's logs.
--
-- No DB trigger calls the edge function here. Unlike 045's Slack triggers,
-- the notification is kicked off by the browser (fire-and-forget invoke)
-- after the insert, and the edge function re-reads this row with the service
-- role. Rationale in docs/embed-request-capture.md §4.2: a pg_net trigger
-- would need a second Vault secret and would fire on every row including
-- hand-inserted test rows, for no gain — the browser already knows the id
-- because it generated it.
--
-- DEVIATION FROM THE ORIGINAL DESIGN DOC (maintainer ruling, D3, 2026-08-07):
-- `website` is OPTIONAL, not required. The design doc's DDL had `website text
-- not null check (...)`; this migration makes it nullable, matching the
-- relaxed client-side validation and email/Slack rendering ("not provided"
-- instead of an empty row) — see EmbedRequestForm.tsx and
-- _shared/embedSnippet.ts's describeConfig-adjacent website handling.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. The table ────────────────────────────────────────────────────────────
--
-- id is CLIENT-GENERATED (crypto.randomUUID()), not a server default. This is
-- what makes the fire-and-forget insert workable: anon has no SELECT policy on
-- this table, so `insert ... returning id` would come back as ZERO ROWS (the
-- 042 lesson — RETURNING needs SELECT visibility), and the client would never
-- learn the id it needs to hand to the notifier. Generating it client-side
-- sidesteps RETURNING entirely. A `default gen_random_uuid()` is kept so
-- server-side/admin inserts don't have to supply one.
--
-- A forged or replayed id is not a hole: the notifier claims `notified_at`
-- with a conditional UPDATE and slack-notify claims `embed_request:{id}` in
-- the ledger, so a replay is at-most-once on both channels, and an id with no
-- matching row is a logged no-op.
create table embed_requests (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  -- Contact. Lengths live in CHECK constraints (not only in the RLS policy)
  -- so a service-role or admin write is bounded too. NOTE for whoever writes
  -- the RLS test: this differs from 043, which put its length bound in the
  -- POLICY — so an over-length insert here raises check_violation, NOT
  -- insufficient_privilege. See supabase/tests/embed_request_rls.test.sql.
  name          text not null check (char_length(name) between 1 and 120),
  email         text not null check (char_length(email) between 3 and 254
                                     and position('@' in email) > 1),
  organization  text not null check (char_length(organization) between 1 and 160),

  -- OPTIONAL (D3, maintainer ruling 2026-08-07 — the original design made
  -- this `not null`). Null means "not provided"; a provided value is still
  -- length-bounded the same way every other free-text field is.
  website       text          check (website is null or char_length(website) between 1 and 300),

  note          text          check (note is null or char_length(note) <= 1000),

  -- The submitted BuilderState. UNTRUSTED AT REST — same threat model as
  -- subscribers.preferences (see slack-notify/render.ts's stringArray comment).
  -- Every consumer must coerce, never trust. jsonb_typeof pins it to an object
  -- ('null'::jsonb and a JSON array both satisfy NOT NULL otherwise), and
  -- pg_column_size bounds volume at the door so a 50,000-element categories
  -- array never reaches a renderer.
  config        jsonb not null check (jsonb_typeof(config) = 'object'
                                      and pg_column_size(config) <= 4096),

  -- Derived SERVER-SIDE by notify-embed-request at send time; never written by
  -- anon (pinned null in the RLS policy below). Path only, no origin.
  embed_path    text          check (embed_path is null or char_length(embed_path) <= 2000),

  -- Triage. 'new' is the only value anon may write.
  status        text not null default 'new'
                  check (status in ('new','approved','sent','declined','spam')),

  -- Email + Slack idempotency claim. Set by notify-embed-request BEFORE it
  -- sends; released back to null if the send fails. Never written by anon.
  notified_at   timestamptz
);

comment on table embed_requests is
  'Partner requests from /embed-builder. config is the submitted BuilderState (untrusted jsonb); embed_path is derived server-side at notify time. website is optional (D3).';

-- ── 2. Indexes ──────────────────────────────────────────────────────────────
-- Two, both for the same workflow: "what came in, and what have I not handled."
create index embed_requests_created_at_idx on embed_requests (created_at desc);
create index embed_requests_new_idx on embed_requests (created_at desc) where status = 'new';

-- ── 3. RLS ──────────────────────────────────────────────────────────────────
alter table embed_requests enable row level security;

-- Anon INSERT, column-constrained in the 043 style. The lengths are already
-- enforced by the CHECK constraints above, so this policy's job is narrower
-- and clearer: pin the three columns anon must never set. Keeping the two
-- concerns in two places (constraint vs policy) also makes the failure modes
-- distinguishable in the tests.
create policy "Anon can request an embed"
  on embed_requests for insert to anon
  with check (
    status = 'new'
    and notified_at is null
    and embed_path is null
  );

-- Admin read only. Same boundary as "Authenticated can read
-- slack_notifications" (044) and "Authenticated can read email_sends" (038).
-- NO anon SELECT policy, deliberately: the client's insert is fire-and-forget
-- and never reads back (§5.4).
create policy "Authenticated can read embed_requests"
  on embed_requests for select to authenticated
  using (true);

-- No UPDATE and no DELETE policy for anyone (D5, maintainer ruling
-- 2026-08-07: SQL-only triage for v1, no authenticated UPDATE policy, no
-- admin UI). Triage from the Supabase table editor / SQL until a real role
-- system exists — migration 038 makes ANY authenticated user an admin, and
-- this table holds partner contact details.

-- ── 4. Velocity cap (server-side flood backstop) ────────────────────────────
-- Postgres has no per-IP identity for anon PostgREST traffic, so this caps
-- flood VOLUME regardless of source, exactly like 043's feedback_rate_limit.
-- Two windows, because the two abuse shapes differ:
--   • global: 10/hour. Real volume here is a handful per MONTH, so this is
--     three orders of magnitude of headroom, not a tight fit.
--   • per email: 3/hour. Catches the "same person mashes submit" case without
--     punishing a genuine second request from a different org.
-- Both are advisory backstops; neither is a substitute for the honeypot and
-- client cooldown (§5.5), which stop the cheap cases before they reach here.
create or replace function embed_request_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  recent_all   int;
  recent_email int;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;

  select count(*) into recent_all
    from embed_requests
    where created_at > now() - interval '1 hour';
  if recent_all >= 10 then
    raise exception 'embed request rate limit exceeded' using errcode = 'check_violation';
  end if;

  select count(*) into recent_email
    from embed_requests
    where email = NEW.email and created_at > now() - interval '1 hour';
  if recent_email >= 3 then
    raise exception 'embed request rate limit exceeded for this address' using errcode = 'check_violation';
  end if;

  return NEW;
end; $$;

drop trigger if exists trg_embed_request_rate_limit on embed_requests;
create trigger trg_embed_request_rate_limit
  before insert on embed_requests
  for each row execute function embed_request_rate_limit();

-- ── 5. Widen the Slack ledger's kind CHECK ──────────────────────────────────
-- See this migration's header for why this is mandatory, not optional.
alter table slack_notifications drop constraint if exists slack_notifications_kind_check;
alter table slack_notifications add constraint slack_notifications_kind_check
  check (kind in ('feedback','subscriber_signup','subscriber_confirmed',
                  'daily_report','night_crew','embed_request'));

commit;
