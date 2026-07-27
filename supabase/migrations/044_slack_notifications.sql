-- ════════════════════════════════════════════════════════════════════════════
-- 044_slack_notifications.sql
--
-- Slack integration, Tier 1 — part 1 of 2 (deliberately split from 045).
--
-- This migration ONLY creates the slack_notifications ledger table + RLS. It
-- arms nothing: no triggers exist yet, so nothing can call the slack-notify
-- edge function automatically until 045 is also applied. That split gives
-- Byron a point to deploy slack-notify and smoke-test it by hand (POST it
-- directly, confirm a ledger row lands and a message posts) before any DB
-- write can invoke it on its own.
--
-- slack_notifications is a dedupe/audit ledger, not a job queue: the edge
-- function claims a dedupe_key with `insert ... on conflict (dedupe_key) do
-- nothing returning id`, posts to Slack, then settles the row to 'sent' or
-- 'failed'. A retried trigger or a replayed call against the (publicly
-- invocable — see 045's header) endpoint is a no-op once a key is claimed.
--
-- No PII: dedupe_key carries only a feedback_posts.id (bigint) or a
-- subscribers.id (uuid) — never an email address, never subscribers.token
-- (the unsubscribe secret). RLS mirrors the email_sends precedent in
-- migration 038: authenticated (admin) read only, no anon policy at all.
-- ════════════════════════════════════════════════════════════════════════════

begin;

create table slack_notifications (
  id bigserial primary key,
  dedupe_key text not null unique,
  kind text not null check (kind in ('feedback','subscriber_signup','subscriber_confirmed')),
  channel_key text not null,
  status text not null default 'claimed' check (status in ('claimed','sent','failed','skipped')),
  slack_ts text,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table slack_notifications enable row level security;

-- Admin dashboard only — same boundary as "Authenticated can read email_sends"
-- in migration 038. No anon policy: this table is never read by the public site.
create policy "Authenticated can read slack_notifications"
  on slack_notifications for select to authenticated
  using (true);

commit;
