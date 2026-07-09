# Akron Pulse — a city events calendar you can run for your town

Akron Pulse is an open-source events calendar. It aggregates events for **Akron, OH & Summit County** from ~50 sources (public APIs, venue sites, and municipal calendars), de-duplicates them, classifies them by category and neighborhood, and serves them from a fast React frontend backed by Supabase.

The codebase is built to be **forked and retargeted to a different city**. The default deployment is Akron, but the geography, branding, and data sources are all isolated so you can point them at your own town.

- **Want to run the existing Akron site locally?** Follow [Local development setup](#local-development-setup) below.
- **Want to launch this for *your* city?** Do the setup below first, then work through **[docs/ADAPTING.md](docs/ADAPTING.md)** — a file-by-file checklist for retargeting geography, branding, scrapers, and maps.

---

## Local development setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd akron-events
npm install
```

`npm install` runs a `postinstall` hook that downloads Chromium for the Puppeteer-based scrapers (~280 MB to `~/.cache/puppeteer/`). See [Scrapers](#scrapers) if it fails or you want to use system Chrome.

### 2. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run the migrations in `supabase/migrations/` **in order** (`001_*.sql` first, then `002_*.sql`, and so on). `001` creates the schema; `002` seeds example Akron venues/events (replace this when adapting — see ADAPTING.md).
3. Go to **Settings → API** and copy your Project URL, `anon` key, and `service_role` key.

### 3. Configure environment

```bash
cp .env.example .env
# Fill in the values described below
```

| Variable | Where to get it | Used by |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase → Settings → API | frontend + scripts |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Settings → API | frontend (read-only, safe to expose) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API | scrapers only — **never commit / never ship to the browser** |
| `TICKETMASTER_API_KEY` | [developer.ticketmaster.com](https://developer.ticketmaster.com) (free, instant) | `ingest:ticketmaster` |
| `EVENTBRITE_API_KEY` | Eventbrite private token (search API is restricted for new keys) | `scrape:eventbrite` |
| `VITE_MAPBOX_TOKEN` | [account.mapbox.com](https://account.mapbox.com) (free tier) | `geocode:venues` only — the map itself needs no key |
| `VITE_GA_MEASUREMENT_ID` | [analytics.google.com](https://analytics.google.com) | frontend analytics (optional) |

### 4. Run

```bash
npm run dev
# → http://localhost:5173
```

---

## Scrapers

Each source has a script in `scripts/scrape-*.js` (plus a couple of `fetch-*.js` for pure REST APIs). Most are plain HTTP fetches; a few sites need a headless browser.

**Puppeteer-dependent scrapers** (sites behind bot challenges or pure SPAs):

- `scrape:akron-symphony` — Cloudflare `__cf_bm` JS challenge
- `scrape:akron-life` — events render via the Evvnt widget, client-side
- `scrape:nightlight` — Vue 3 + Quasar SPA hydrated by Apollo

If a Puppeteer scraper reports `Could not find Chrome (ver. NNN.x.x.x)`, re-run the install the `postinstall` hook is supposed to handle:

```bash
npx puppeteer browsers install chrome
```

To reuse an existing Chrome instead of a second Chromium, point Puppeteer at it (the helpers in `scripts/lib/puppeteer.js` honor this):

```bash
# macOS
export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

**Running scrapers:**

```bash
npm run scrape:nightlight       # any individual scraper
npm run scrape:all              # the full sweep, then cross-source dedupe
```

`scrape:all` runs every scraper sequentially and finishes with `dedupe-cross-source.js --apply`. Each scraper logs its result to the `scraper_runs` table; one failure doesn't block the rest. Check overall status with `npm run health`.

Shared scraper machinery lives in `scripts/lib/` — notably `normalize.js` (the common event shape + upsert helpers), `civicplus.js` / `squarespace.js` (platform helpers that power most municipal and venue scrapers), `category-inference.js`, and `neighborhood-resolver.js`.

---

## Supabase notes

- **Row Level Security is enabled.** Public visitors can only read `published` events; the `anon` key is therefore safe to expose in the browser.
- **To publish a submitted event:** open the Supabase table editor → `events` table → change `status` from `pending_review` to `published`, **or** use the one-click "Publish now" button in the operator notification email (below).
- **Edge functions** live in `supabase/functions/`: `notify-pending-event`, `send-digest`, `subscribe`, `unsubscribe`, and `preferences`. Deploy with `supabase functions deploy <name>`.

### Pending-event notifications

Submissions from `/submit` insert an event with `status='pending_review'` and `source='manual'`, then call the `notify-pending-event` edge function. It emails the operator (`ADMIN_NOTIFY_EMAIL`) the full submission, a one-click HMAC-signed "Publish now" link, and a deep link to `/admin/events/<id>/edit` for inspect-first cases.

```bash
supabase functions deploy notify-pending-event
```

Required function secrets (set via `supabase secrets set` or the dashboard):

- `RESEND_API_KEY` — Resend API key (shared with the digest function)
- `ADMIN_NOTIFY_EMAIL` — comma-separated operator recipients (also used by `preferences`)
- `PUBLISH_TOKEN_SECRET` — strong random string (≥ 32 bytes) that HMAC-signs the publish URL. Rotate to invalidate in-flight links.
- `PUBLIC_SITE_URL` — base URL of the site, used for the admin deep link (defaults to `https://akronpulse.com`)
- `RESEND_FROM`, `RESEND_REPLY_TO` — optional sender / reply-to overrides
- `PUBLISH_TOKEN_TTL_HOURS` — optional link lifetime, defaults to `168` (7 days)

Security properties:

- The publish URL is bound to a single `event_id` and signed with HMAC-SHA256, so a leaked link can only publish that one event, and only until expiry.
- The GET handler is idempotent — replaying a valid link on an already-published row renders an "already published" page instead of re-running the update.
- Rotating `PUBLISH_TOKEN_SECRET` immediately invalidates every outstanding link.

---

## Adapting to your city

The Akron build is the worked example. To run this for a different town you'll change four things: **geography** (search coordinates, timezone, map boundaries), **branding** (name, copy, theme, OG/SEO), **data sources** (replace the ~50 Akron scrapers with your local venues and municipal calendars), and **deployment** config.

The full file-by-file checklist — with the exact files, variables, and Akron values to replace — is in **[docs/ADAPTING.md](docs/ADAPTING.md)**.

---

## Stack

- **Frontend:** React 18 + Vite, React Router v6
- **Language:** TypeScript (see below) — the React frontend is fully TypeScript
- **Database / Auth / API:** Supabase (PostgreSQL with RLS)
- **Maps:** MapLibre GL + react-map-gl with OpenFreeMap vector tiles (free, no API key); Mapbox Geocoding API for venue coordinate backfill; boundaries from US Census TIGER/Line and city GIS shapefiles
- **Dates:** date-fns (event times are normalized in US Eastern — see ADAPTING.md if your city is in another timezone)
- **Email:** Resend (via Supabase edge functions)
- **Hosting (production):** Vercel (frontend + `/api` edge functions) + Supabase cloud

### TypeScript

The React frontend (`src/`) is entirely TypeScript, type-checked under `strict`.
Four modules in `src/lib/` stay `.js` on purpose — `categories.js`, `cities.js`,
`slug.js`, and `seo/categories.js` are imported directly by the Node scrapers
and the `/api` edge routes (with explicit `.js` extensions), so they remain
plain JS (typed via JSDoc) to keep both runtimes working. `tsconfig.json` keeps
`allowJs` on so those four coexist with the typed frontend. Type-check with:

```bash
npm run typecheck   # tsc --noEmit
```

Database types are generated from the live schema into
`src/lib/database.types.ts` and wired into the Supabase client, so every query
is typed against the real tables. **Regenerate them after any migration:**

```bash
npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
```

App-facing aliases (`Event`, `Venue`, `Organization`, …) live in `src/types/`.
