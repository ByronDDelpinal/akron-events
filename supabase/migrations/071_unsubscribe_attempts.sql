-- 071_unsubscribe_attempts.sql
--
-- WHY THIS TABLE EXISTS
--
-- On 2026-09-17 we found that one-click unsubscribe had never worked. The
-- digest advertised `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and
-- pointed it at https://akronpulse.com/unsubscribe — a client-side React
-- route. Mailbox providers POSTed there, Vercel answered 405, and nothing
-- happened. Meanwhile the /unsubscribe page always rendered "You've been
-- unsubscribed" and the edge function always returned { ok: true }, including
-- when the token matched no row and when the database errored.
--
-- So the failure was structurally invisible: no status code, no log line, no
-- row anywhere said an unsubscribe had been attempted and lost. The only
-- surviving signal was an absence — GA pageviews on /unsubscribe with no
-- corresponding `subscribers.unsubscribed_at`, which is exactly the kind of
-- signal nobody goes looking for.
--
-- This table is the fix for the blindness, not for the bug. Every attempt now
-- leaves a row with its outcome, so "did anyone try to unsubscribe and fail"
-- becomes a query instead of an inference.
--
-- WHAT IS DELIBERATELY NOT STORED
--
-- The token. It is a live credential — it grants read and write on that
-- subscriber's preferences — and an append-only audit table is the last place
-- it should sit. We keep only its uuid VERSION nibble, which is enough to tell
-- real tokens (v4, from gen_random_uuid) from the fabricated v7-shaped values
-- that link scanners fire after every send, and useless to an attacker.
--
-- No IP address either. The user agent is kept, truncated, because it is what
-- separates a mail-security scanner from a person.

create table if not exists unsubscribe_attempts (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),

  -- applied  — we just set unsubscribed_at on a live subscriber
  -- already  — valid token, already unsubscribed (idempotent replay)
  -- no_match — token absent, malformed, or not in subscribers
  -- error    — lookup or update actually failed; the caller got a 503
  outcome        text not null
                 check (outcome in ('applied', 'already', 'no_match', 'error')),

  -- one_click — RFC 8058 POST from a mailbox provider
  -- page      — our own /unsubscribe page
  -- link      — a plain GET on the List-Unsubscribe URI
  source         text not null
                 check (source in ('one_click', 'page', 'link', 'unknown')),

  subscriber_id  uuid references subscribers(id) on delete set null,
  token_version  smallint,
  user_agent     text,
  error_message  text
);

comment on table unsubscribe_attempts is
  'Append-only record of every unsubscribe attempt and its outcome. Written by the unsubscribe edge function with the service role. Never contains the token itself.';

create index if not exists idx_unsubscribe_attempts_created_at
  on unsubscribe_attempts (created_at desc);

create index if not exists idx_unsubscribe_attempts_outcome_created
  on unsubscribe_attempts (outcome, created_at desc);

-- RLS posture matches subscribers itself (038 + 059): no anon access at all,
-- admin-only read, and the edge function writes with the service role, which
-- bypasses RLS. There is intentionally no INSERT policy — nothing but the
-- service role should ever append here.
alter table unsubscribe_attempts enable row level security;

drop policy if exists "Admin can read unsubscribe_attempts" on unsubscribe_attempts;
create policy "Admin can read unsubscribe_attempts"
  on unsubscribe_attempts for select to authenticated
  using (is_admin());
