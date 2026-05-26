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
- To publish a submitted event: open the Supabase table editor → `events` table → change `status` from `pending_review` to `published`.
- The `anon` key is safe to expose in the browser — RLS ensures read-only public access.

## Stack
- **Frontend**: React 18 + Vite
- **Database / Auth / API**: Supabase (PostgreSQL)
- **Routing**: React Router v6
- **Dates**: date-fns
- **Fonts**: Space Grotesk + DM Sans (Google Fonts)
- **Hosting** (production): Vercel + Supabase cloud
