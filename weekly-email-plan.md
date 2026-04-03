# Turnout — Weekly Email Digest Plan (Final)

*All decisions finalized 2026-04-02. Ready for implementation review.*

---

## 1. Signup Experience — `/subscribe`

A single, clean page. One field to fill, three settings with smart defaults, one button.

**Messaging at top:** *"Get Akron's best events in your inbox. No password, no account — just the events you care about."*

**Email address** — single input, prominent.

**What are you into?** — Intent cards: **All** (selected by default) · Date Night · Free Fun · Give Back · Family Fun · Get Active. Tapping "All" deselects specifics; tapping a specific intent deselects "All." If nothing specific is chosen, "All" remains active.

**How often?** — Three pills: Daily · **Weekly** (default) · Monthly.

**How far ahead?** — Three pills: Next Day · **Next Week** (default) · Next Month. Auto-updates when frequency changes (daily→next day, weekly→next week, monthly→next month), but the user can override. A daily subscriber who wants a rolling 7-day preview can set that. Max is always "next month."

**CTA:** "Subscribe — it's that easy"

**Subtext below CTA:** *"After confirming your email, you'll unlock your preference center where you can fine-tune everything — categories, specific venues, price range, and more. No password needed, ever. Not now, not later."*

**Already subscribed?** — Small text link at bottom of page: *"Already subscribed? Enter your email and we'll send a link to your preference center."* Submitting triggers a magic link email. No password recovery, no account lookup — just a fresh token link.

---

## 2. Confirmation Flow

**Double opt-in email** — short, branded, single CTA:

> Subject: "Confirm your Turnout subscription"
>
> "You're one tap away from getting Akron's best events delivered to your inbox. Confirm below to activate your subscription and unlock your full preference center."
>
> [Confirm my subscription]

Clicking the button:
1. Sets `confirmed = true`
2. Redirects to `/subscribe/preferences?token=<token>`
3. Token is a UUID, not guessable, rotated on each magic link request

---

## 3. Full Preference Center — `/subscribe/preferences?token=<token>`

Accessible via magic link token from the confirmation email and from every future digest email. **No password, no login, ever.**

**Messaging at top:** *"This is your preference center. Tweak anything below and hit save. Every email we send has a link right back here, so you can change your mind whenever you want."*

### Sections (single page, clearly divided):

**Intents** — Same cards as signup with "All" toggle. Selecting specific intents auto-checks their underlying categories in the next section.

**Categories** — Checkboxes: Music · Art · Community · Nonprofit · Food · Sports · Education · Other. Pre-filled from intent selection. User can add/remove beyond what intents set — categories are the real filter, intents are shortcuts.

**Venues** — Searchable multi-select from all published venues. **No selection = all venues** (inclusive default). Only filters if the user explicitly picks specific venues. Shows venue name + neighborhood/address for disambiguation.

**Price & Age** — Price: Free only · Under $10 · Under $25 · Any price (default). Age: All ages · 18+ · 21+ · No preference (default).

**Delivery** — Frequency (daily/weekly/monthly) · Lookahead (next day/week/month) · Day of week for weekly subscribers (Mon–Sun, default Thursday). For daily: no day selection needed. For monthly: always sends on the 1st.

**Save button** — Saves via token-authenticated API call. No page reload needed.

---

## 4. Database Schema

### Migration: `009_subscribers.sql`

```sql
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
  -- location shape when set: { "mode": "area"|"zipcode", "lat": num, "lng": num, "radius_miles": num, "label": "Downtown Akron"|"44304" }
  -- keywords: up to 5 freeform terms; matched as whole words against event title (+ description unless keywords_title_only).
  --           keyword matches BYPASS other content filters (intents, categories, venues, orgs, price, age, days, location).

  unsubscribed_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint subscribers_email_unique unique (email)
);

-- Active subscriber lookup (used by daily cron)
create index idx_subscribers_active_send_day
  on subscribers (frequency, send_day)
  where confirmed = true and unsubscribed_at is null;

-- Token lookups (preference center access, unsubscribe)
create index idx_subscribers_token on subscribers (token);

-- Email uniqueness lookup (signup dedup)
create index idx_subscribers_email on subscribers (email);


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
  error_message   text,  -- only populated on failure
  created_at      timestamptz not null default now()
);

-- Lookup sends by subscriber (admin/debug: "when was this person last emailed?")
create index idx_email_sends_subscriber on email_sends (subscriber_id, sent_at desc);

-- Cleanup: only keep 90 days of send logs (optional pg_cron job)
create index idx_email_sends_sent_at on email_sends (sent_at);


-- ─────────────────────────────────────────
-- RLS POLICIES
-- ─────────────────────────────────────────
alter table subscribers enable row level security;
alter table email_sends enable row level security;

-- Public can insert (signup). No read/update/delete without service role.
create policy "Anon can subscribe"
  on subscribers for insert to anon
  with check (true);

-- Service role (Edge Functions) has full access via default.
-- No anon read/update/delete policies — all preference updates
-- go through an Edge Function that validates the token.

-- Email sends: service role only (Edge Functions write, admin reads).
create policy "Service role manages email_sends"
  on email_sends for all to service_role
  using (true) with check (true);
```

### Why JSONB for preferences (not junction tables)

At email generation time, we need each subscriber's full preference set. With junction tables, that's N×5 queries (categories, venues, intents, price, age per subscriber). With JSONB, it's N×1 — fetch the row, parse in memory. The JSONB column is never queried *into* during sends; it's read whole and filtered in the Edge Function. For analytics ("how many subscribers follow venue X?"), a periodic aggregate query is cheaper than per-send joins.

### Why `auth_user_id` is included now

When Supabase Auth is added for org/venue host accounts later, you add a foreign key constraint and populate this column for authenticated users. Public email subscribers continue using token-based access untouched. No migration needed to restructure the table — just a one-line `ALTER TABLE` to add the FK constraint when `auth.users` exists.

---

## 5. Email Generation — Cost-Optimized Architecture

**Design principle:** Do the expensive work once, reuse for every subscriber.

### Flow (runs daily at 8:30 AM ET):

```
pg_cron or GitHub Actions → triggers Supabase Edge Function "send-digests"

Step 1: WHO is due today?
  → Query subscribers WHERE:
      (frequency = 'daily')
      OR (frequency = 'weekly' AND send_day = today's day-of-week)
      OR (frequency = 'monthly' AND today is the 1st of the month)
    AND confirmed = true
    AND unsubscribed_at IS NULL

Step 2: WHAT events exist?
  → Query ALL published events with start_at in the next 30 days.
  → ONE query. Cached in memory for the entire run.
  → Include: title, description, start_at, end_at, category, tags,
     price_min, price_max, age_restriction, image_url, ticket_url,
     featured, venue name/address (joined).

Step 3: FILTER per subscriber (in-memory, no DB calls)
  → For each subscriber, apply their JSONB preferences to the cached event list:
     - Date window: today → today + lookahead_days
       (monthly on 1st: today → last day of current month)
     - Intents/categories: filter by category match
     - Venues: filter by venue_id if any selected
     - Price: filter by price_max
     - Age: filter by age_restriction
  → Sort by: featured first (max 1), then start_at ascending
  → Cap at 10 events + 1 featured hero

Step 4: RENDER email HTML
  → React Email render() — static HTML, no JS
  → Brand values pulled from single emailTheme config
  → "See all [N] events" link → website URL with full preference filters as query params

Step 5: BATCH SEND via Resend
  → Resend batch API: up to 100 emails per call
  → 1,000 subscribers = 10 API calls

Step 6: LOG results
  → Insert one row per subscriber into email_sends (subscriber_id, event_count, status)
  → On failure: log error_message, continue to next subscriber (don't abort batch)
```

### Cost controls:

- **1 event query per run** — not per subscriber. Whether 100 or 10,000 subscribers, Supabase sees 2 queries total (subscribers + events).
- **Batch API** — 100 emails per Resend call. 5,000 subscribers = 50 API calls.
- **Staggered by send_day** — weekly subscribers spread across 7 days. Each run processes ~1/7th of weekly subs.
- **Monthly = calendar month** — sends on the 1st, includes events through the last day of the month. Uses proper date math (not rolling 30 days).
- **Send window: 8:30 AM – 12 PM ET** — cron fires at 8:30 AM. Batch sending completes in minutes at any reasonable scale.
- **90-day log cleanup** — optional pg_cron job deletes old `email_sends` rows to keep the table lean.

### Cost projection:

| Subscribers | Mix (est.) | Emails/month | Resend tier | Monthly cost |
|-------------|-----------|-------------|------------|-------------|
| < 500 | 80% weekly, 15% daily, 5% monthly | ~2,800 | Free (3k/mo) | $0 |
| 1,000 | same mix | ~5,600 | Pro (50k/mo) | $20 |
| 5,000 | same mix | ~28,000 | Pro (50k/mo) | $20 |
| 10,000+ | same mix | ~56,000 | Pro (100k/mo) | $45 |

---

## 6. Email Template Design

### Subject lines:

- **Daily:** "Tomorrow in Akron: [count] events for you"
- **Weekly:** "Your week in Akron: [count] events for you"
- **Monthly:** "[Month] in Akron: [count] events for you"

### Structure (hard caps to prevent overwhelm):

1. **Hero event** (0 or 1) — A featured event from the subscriber's window, if one exists. Full-width, image, title, date, venue, price. If no featured event exists, this section is omitted — no forced hero.

2. **Your picks** (max 8–10) — Events matching their preferences, sorted by date. Compact cards: image thumbnail (if quality passes), title, date/time, venue, price badge. Enough to be valuable, short enough to scan in 30 seconds.

3. **See all events** — A single prominent link: "See all [47] events matching your preferences →" linking to the website with their full filters pre-applied as URL query params (categories, price, age, date range, intents).

4. **Footer** — "Manage your preferences" (magic link, prominent, not buried) · "Unsubscribe" (one-click) · Turnout wordmark

**Not included:** No "don't miss" section pushing events outside preferences. Respects the user's choices — they told us what they want.

### Branding:

All brand values (name, logo URL, colors, fonts, tagline) live in a single `emailTheme.js` config file. Templates reference `theme.brandName`, `theme.primaryColor`, etc. Changing the brand = updating one file.

---

## 7. Unsubscribe Flow

**In every email footer:** "Unsubscribe" link with the subscriber's token baked in.

**One click.** Hitting the link immediately sets `unsubscribed_at = now()` and shows a simple page:

> *"You've been unsubscribed. If you ever want to come back, you can re-subscribe anytime at [events.supportlocalakron.com/subscribe]. We hope to see you again."*

That's it. No survey. No guilt. No "are you sure?" No frequency downsell. No "before you go" interstitial. Respect the decision, leave the door open.

---

## 8. Admin Dashboard Addition

**Subscriber count widget** on the existing admin dashboard. Shows:
- Total confirmed subscribers
- Total unsubscribed (all time)

No email list, no individual subscriber details, no preference breakdowns. If/when Resend Pro is added ($20/mo), its dashboard covers open rates, click rates, and delivery analytics — no need to build that ourselves.

---

## 9. Tech Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Email service | **Resend** | Free tier 3k/mo, React Email native, batch API |
| Templates | **React Email** | JSX, same language as app, renders to static HTML |
| Sending logic | **Supabase Edge Function** | Already in stack, Deno runtime, 500k free invocations/mo |
| Scheduling | **pg_cron** (primary) or GitHub Actions (fallback) | pg_cron is zero-cost if available on your Supabase plan |
| Storage | **Supabase (same project)** | 2 new tables, no new infrastructure |
| UI | **React pages in existing app** | `/subscribe` and `/subscribe/preferences` routes |
| Brand config | **`emailTheme.js`** | Single source of truth for brand values, easy to swap |

---

## 10. Implementation Phases

**Phase 1 — Foundation (Week 1)**
- Migration `009_subscribers.sql` (subscribers + email_sends + RLS)
- `/subscribe` page (email, intents, frequency, lookahead)
- Signup API: insert subscriber, send confirmation email via Resend
- Confirmation flow: token validation, set confirmed, redirect to preferences
- "Already subscribed?" magic link re-send flow

**Phase 2 — Preferences & Sending (Week 2)**
- `/subscribe/preferences` page (full preference center with token auth)
- Preference update API (token-validated Edge Function)
- `emailTheme.js` brand config
- React Email template (hero + picks + see-all link + footer)
- Edge Function `send-digests`: event query, subscriber filter, batch send, logging
- pg_cron setup (daily 8:30 AM ET)

**Phase 3 — Polish & Admin (Week 3)**
- Unsubscribe flow (one-click, kind confirmation page)
- Admin dashboard subscriber count widget
- Error handling and retry logic in send-digests
- 90-day email_sends cleanup job
- End-to-end testing with test subscriber
