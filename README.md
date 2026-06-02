# The 330 — Akron & Summit County Events

## Local development setup

### 1. Clone and install
```bash
git clone <your-repo-url>
cd akron-events
npm install
```

### 2. Set up Supabase
1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run the contents of `supabase/migrations/001_initial_schema.sql`
3. Go to **Settings → API** and copy your Project URL and `anon` key

### 3. Configure environment
```bash
cp .env.example .env
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
```

### 4. Run
```bash
npm run dev
# → http://localhost:5173
```

## Scrapers

Most scrapers in `scripts/scrape-*.js` are plain HTTP fetches. A few sites use Cloudflare bot challenges or pure SPAs, and those scrapers depend on Puppeteer.

**Puppeteer-dependent scrapers**:
- `scrape:akron-symphony` — site is behind Cloudflare's `__cf_bm` JS challenge
- `scrape:akron-life` — events render via the Evvnt widget, client-side
- `scrape:nightlight` — Vue 3 + Quasar SPA hydrated by Apollo

**One-time Chrome install** (already automatic via `postinstall`, but if you ever see `Could not find Chrome (ver. NNN.x.x.x)`):
```bash
npx puppeteer browsers install chrome
```
This downloads ~280 MB of Chromium to `~/.cache/puppeteer/`. The `postinstall` hook in `package.json` runs this automatically after `npm install` on fresh clones, but the download can be skipped or fail silently in CI environments — re-run the command above if a Puppeteer scraper can't find Chrome.

**Using system Chrome instead**: if you'd rather not download a second Chromium and you already have Google Chrome installed, point Puppeteer at it via env var:
```bash
# macOS
export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```
The scrapers in `scripts/lib/puppeteer.js` honor this automatically.

**Running scrapers**:
```bash
npm run scrape:nightlight       # any individual scraper
npm run scrape:all              # the full cron sweep
```

The `scrape:all` script runs every scraper sequentially. Each one logs its result to the `scraper_runs` table; failures don't block the rest.

## Supabase notes
- Row Level Security (RLS) is enabled. Public visitors can only read `published` events.
- To publish a submitted event: open the Supabase table editor → `events` table → change `status` from `pending_review` to `published`, **or** use the one-click "Publish now" button in the operator notification email (see *Pending-event notifications* below).
- The `anon` key is safe to expose in the browser — RLS ensures read-only public access.

## Pending-event notifications
User submissions from `/submit` insert an event with `status='pending_review'` and `source='manual'`, then call the `notify-pending-event` edge function. The function emails the operator (`ADMIN_NOTIFY_EMAIL`) the full submission and a one-click HMAC-signed "Publish now" link, plus a secondary deep link to `/admin/events/<id>/edit` for cases where you want to inspect or edit first.

Deploy the function:
```bash
supabase functions deploy notify-pending-event
```

Required function secrets (set via `supabase secrets set` or the Supabase dashboard):
- `RESEND_API_KEY` — Resend API key (shared with the digest function)
- `ADMIN_NOTIFY_EMAIL` — comma-separated operator recipients (also used by `preferences`)
- `PUBLISH_TOKEN_SECRET` — strong random string (≥ 32 bytes) used to HMAC-sign the one-click publish URL. Rotate to invalidate any in-flight links.
- `PUBLIC_SITE_URL` — base URL of the site, used for the admin deep link (defaults to `https://akronpulse.com`)
- `RESEND_FROM`, `RESEND_REPLY_TO` — optional sender / reply-to overrides
- `PUBLISH_TOKEN_TTL_HOURS` — optional link lifetime, defaults to `168` (7 days)

Security notes:
- The publish URL is bound to a single `event_id` and signed with HMAC-SHA256. A leaked link can only publish that one event, and only until its expiry.
- The GET handler is idempotent: replaying a valid link on an already-published row renders an "already published" page instead of re-running the update.
- Rotating `PUBLISH_TOKEN_SECRET` immediately invalidates every outstanding link.

## Stack
- **Frontend**: React 18 + Vite
- **Database / Auth / API**: Supabase (PostgreSQL)
- **Routing**: React Router v6
- **Dates**: date-fns
- **Fonts**: Space Grotesk + DM Sans (Google Fonts)
- **Hosting** (production): Vercel + Supabase cloud
