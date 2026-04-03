-- ============================================================
-- Turnout — Email Subscribers & Send Log
-- Supports weekly/daily/monthly digest emails with
-- JSONB preference-based personalization.
-- ============================================================

-- ─────────────────────────────────────────
-- SUBSCRIBERS
-- ─────────────────────────────────────────
create table subscribers (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  confirmed       boolean not null default false,
  token           uuid not null default gen_random_uuid(),

  -- Future: link to Supabase Auth when org/venue host accounts are added.
  -- Email subscribers remain token-based; hosts get linked via this column.
  -- No refactor needed — just populate this field for authenticated users.
  auth_user_id    uuid,  -- references auth.users(id) once auth is enabled

  -- Delivery
  frequency       text not null default 'weekly'
                    check (frequency in ('daily', 'weekly', 'monthly')),
  lookahead_days  integer not null default 7
                    check (lookahead_days in (1, 7, 30)),
  send_day        integer default 4
                    check (send_day is null or (send_day between 0 and 6)),
                    -- 0=Sun..6=Sat. Default 4=Thu. Null for daily subscribers.

  -- Content preferences (JSONB — single read per subscriber, no joins)
  preferences     jsonb not null default '{
    "intents": ["all"],
    "categories": [],
    "venue_ids": [],
    "org_ids": [],
    "price_max": null,
    "age_restriction": null,
    "event_days": [0,1,2,3,4,5,6],
    "location": null,
    "keywords": [],
    "keywords_title_only": false
  }'::jsonb,
  -- location shape when set:
  --   { "mode": "area"|"zipcode", "lat": num, "lng": num, "radius_miles": num, "label": "Downtown Akron"|"44304" }
  -- keywords: up to 5 freeform terms; matched as whole words against event title
  --   (+ description unless keywords_title_only). Keyword matches BYPASS other content filters.

  unsubscribed_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint subscribers_email_unique unique (email)
);

-- Active subscriber lookup (used by daily cron to find who gets emailed today)
create index idx_subscribers_active_send_day
  on subscribers (frequency, send_day)
  where confirmed = true and unsubscribed_at is null;

-- Token lookups (preference center access, unsubscribe)
create index idx_subscribers_token on subscribers (token);

-- Reuse the existing updated_at trigger
create trigger trg_subscribers_updated_at
  before update on subscribers
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────
-- EMAIL SEND LOG
-- ─────────────────────────────────────────
create table email_sends (
  id              uuid primary key default gen_random_uuid(),
  subscriber_id   uuid not null references subscribers(id) on delete cascade,
  sent_at         timestamptz not null default now(),
  event_count     integer not null default 0,
  status          text not null default 'sent'
                    check (status in ('sent', 'failed', 'skipped')),
  idempotency_key text,  -- format: digest-YYYY-MM-DD/chunk-N, prevents double-sends on retry
  error_message   text,  -- only populated on failure
  created_at      timestamptz not null default now()
);

-- Lookup sends by subscriber (admin/debug: "when was this person last emailed?")
create index idx_email_sends_subscriber on email_sends (subscriber_id, sent_at desc);

-- Idempotency check (safe retries)
create unique index idx_email_sends_idempotency
  on email_sends (idempotency_key)
  where idempotency_key is not null;

-- Cleanup: only keep 90 days of send logs (optional pg_cron job)
create index idx_email_sends_sent_at on email_sends (sent_at);


-- ─────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────
alter table subscribers enable row level security;
alter table email_sends enable row level security;

-- Public can insert (signup form). No read/update/delete via anon.
-- All preference reads/updates go through Edge Functions that validate the token.
create policy "Anon can subscribe"
  on subscribers for insert to anon
  with check (true);

-- Email sends: no anon access. Edge Functions use service_role key.
-- (Supabase service_role bypasses RLS by default, so no explicit policy needed.)
