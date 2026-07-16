# Adapting Akron Pulse to your city

This is the practical, file-by-file checklist for retargeting the project from Akron, OH to a different city. Every step lists the **exact file(s)**, what to change, and the **current Akron value** as a worked example so you can find-and-replace with confidence.

Do the [Local development setup](../README.md#local-development-setup) in the README first — this guide assumes you already have the app running against your own Supabase project.

Work top to bottom. The phases are ordered so you can get a working, branded, locally-correct site before you take on the biggest job (replacing data sources).

**Contents**

1. [Geography — search area & timezone](#1-geography--search-area--timezone)
2. [Maps & boundaries (GIS)](#2-maps--boundaries-gis)
3. [Branding & copy](#3-branding--copy)
4. [SEO, OG previews & deployment](#4-seo-og-previews--deployment)
5. [Database seed & email](#5-database-seed--email)
6. [Data sources — the scrapers](#6-data-sources--the-scrapers)
7. [Adding a new scraper](#7-adding-a-new-scraper)
8. [Final verification](#8-final-verification)

---

## 1. Geography — search area & timezone

These control which events get pulled in and how their times are interpreted. Get these wrong and you'll ingest the wrong city's events or display times off by hours.

### Search coordinates & radius

| File | What to change | Akron value |
|---|---|---|
| `scripts/fetch-ticketmaster.js` | `AKRON_LAT`, `AKRON_LNG`, `RADIUS_MILES`, `DAYS_AHEAD` | `41.0814`, `-81.5190`, `25`, `180` |
| `scripts/scrape-eventbrite.js` | `AKRON_LAT`, `AKRON_LNG`, `SEARCH_PAGE`, the `place_id` in the search body, and the locality logic in `isAkronEvent()` | `41.0814`, `-81.5190`, `https://www.eventbrite.com/d/oh--akron/events/`, `place_id: 'oh--akron'` |

For Eventbrite, the `oh--akron` slug is Eventbrite's own place identifier. Find your city's by browsing to `eventbrite.com/d/<state>--<city>/events/` and copying the slug from the URL. Rename the `AKRON_LAT`/`AKRON_LNG` constants to suit your city (they're just module-local constants), and review `isAkronEvent()` — it filters out online/out-of-area events that bleed into Eventbrite's place search. Rename it and adjust any city/region string checks it makes.

> Tip: search the repo for the literal coordinates `41.0814` and `-81.5190` to catch every hardcoded reference — there's also one in `scripts/lib/summit-county.js` doc comments.

### Timezone

Event times are normalized to **US Eastern** in `scripts/lib/normalize.js` (`easternToIso()`, around the "EASTERN TIMEZONE CONVERSION" section). DST offsets are resolved via `Intl.DateTimeFormat` with the `America/New_York` zone, so adapting to another region means swapping the zone name.

- **If your city is also US Eastern:** no change needed.
- **If it's another US timezone:** adjust the UTC offsets in `easternToIso()` (the DST *dates* are the same across US zones, only the offset differs).
- **If it's outside the US:** replace the hand-rolled conversion with a proper timezone library (e.g. `date-fns-tz` with an IANA zone like `America/Chicago`). This is the most error-prone change — write a quick test in `scripts/tests/` that asserts a known local time converts to the expected ISO/UTC value.

---

## 2. Maps & boundaries (GIS)

The site renders two map layers: **neighborhood polygons** within the core city, and a **county/region map** of surrounding municipalities. Both are pre-converted GeoJSON committed under `public/`, generated from source shapefiles in `data/gis/` by the `scripts/convert-*.js` scripts.

### Neighborhood polygons (core city)

| Item | Detail | Akron value |
|---|---|---|
| Source shapefile | `data/gis/akron-neighborhoods/` | City of Akron neighborhood shapefile |
| Converter | `scripts/convert-neighborhoods.js` → `npm run gis:convert` | outputs `public/akron-neighborhoods.geojson` |

Most US cities publish a neighborhoods (or planning districts / wards) shapefile on their open-data / GIS portal. Drop the `.shp/.dbf/.prj/.shx` set into a new folder under `data/gis/`, update the input path and output filename in `convert-neighborhoods.js`, and rerun. If your city has no neighborhood boundaries, you can ship without this layer — see the neighborhood code in `src/lib/neighborhoods.js` and `scripts/lib/neighborhood-resolver.js`.

### County / regional map

| Item | Detail | Akron value |
|---|---|---|
| Source shapefiles | `data/gis/ohio_places/tl_2025_39_place.*` and `data/gis/ohio_county_subs/tl_2025_39_cousub.*` | US Census TIGER/Line, Ohio (FIPS `39`) |
| Converters | `scripts/convert-summit-cities.js` (`gis:convert-cities`), `convert-summit-county.js` (`gis:convert-summit`) | emits the county GeoJSON used by the map |
| Region rollups | the city list + Northwest/Northeast/Southeast groupings inside `convert-summit-cities.js` | 14 Summit County cities + 3 regional MultiPolygons |
| Frontend component | `src/components/SummitCountyMap.jsx` | hardcoded city labels & region names |
| Point-in-county helper | `scripts/lib/summit-county.js` (`pointInSummitCounty`) | Summit County boundary |

To retarget: download the TIGER/Line **PLACE** and **COUNTY SUBDIVISION** shapefiles for your state from [census.gov/cgi-bin/geo/shapefiles](https://www.census.gov/cgi-bin/geo/shapefiles/) (replace state FIPS `39` with yours — e.g. `48` for Texas). Update the input paths and the list of target cities/regions in the convert scripts, rerun `npm run gis:convert-cities` / `gis:convert-summit`, then update the labels in `SummitCountyMap.jsx` and the boundary logic in `summit-county.js`. Rename the `SummitCountyMap` component/files to your region if you want it tidy.

### Venue auto-classification

`scripts/classify-venues-by-polygon.js` (`npm run classify:venues` / `:execute`) assigns each venue to a neighborhood/city by testing its lat/lng against the polygons above. Once your GeoJSON is correct this works automatically; rerun it after importing venues.

---

## 3. Branding & copy

Replace the "Akron Pulse" name, tagline, theme, and logos.

| File | What's there | Akron value |
|---|---|---|
| `index.html` | `<title>`, `<meta name="description">`, `theme-color`, RSS title, banner poster preload, the inline theme bootstrap | "Akron Pulse — Akron & Summit County Events", `#0E5163` |
| `src/components/SlimBar.jsx` | header logo `aria-label` & copyright | "Akron Pulse" |
| `src/components/Footer.jsx` | tagline, copyright, logo labels, the `akronpulse_card_view_mode` localStorage key | "Everything happening in Akron & Summit County…" |
| `src/components/NewsletterCTA.jsx` | newsletter copy | "Akron Pulse" |
| `src/lib/themes.js` | theme palette list, `THEME_STORAGE_KEY` (`akronpulse.theme`), and the `theme-logos/AkronPulse_*.png` logo map | civic-teal default + 8 named themes |
| `src/styles/themes.css` | CSS variables for each theme palette | Civic Teal default |
| `public/theme-logos/` | the `AkronPulse_<Theme>.png` logo images | one per theme |
| `src/lib/geocode.js` | Nominatim `User-Agent` string (be a good API citizen and use your own app name + contact) | `AkronPulse-Akron-Events/1.0` |
| `public/video/` | homepage banner video + poster (`akron-pulse-banner-*`) | Akron drone footage |
| `public/` favicons / `og-default.jpg` | site icons & default social card | Akron Pulse marks |

Quick way to find stragglers — search the whole repo (case-insensitive) for: `akron`, `summit`, `pulse`, `330`, `akronpulse`. Most hits are copy, doc comments, or CSS class names; review each rather than blind-replacing, since some (like the `summit_*` scraper source keys) are identifiers tied to data and are covered in §6.

> Themes are optional polish. If you just want one brand, you can trim `themes.js`/`themes.css` to a single palette and drop the extra logos.

---

## 4. SEO, OG previews & deployment

| File | What to change | Akron value |
|---|---|---|
| `api/preview/event/[id].js` | `SITE_NAME`, `SITE_ORIGIN`, `SITE_TAGLINE`, default `addressLocality`, the "More … events in Akron" copy | "Akron Pulse", `https://akronpulse.com`, "Everything happening in Akron & Summit County" |
| `api/sitemap.xml.js` | `SITE_ORIGIN` and the local-intent query strings | `https://akronpulse.com` |
| `api/feed.xml.js` | feed title/site URL | Akron Pulse feed |
| `vercel.json` | rewrite allow-list (update only if you add/rename top-level static files) | sitemap/feed/robots/og rewrites |
| `public/robots.txt` | sitemap URL | `akronpulse.com` |
| Production env | set `PUBLIC_SITE_URL` to your domain everywhere it appears (edge functions default to `https://akronpulse.com`) | `https://akronpulse.com` |

Deploy target is Vercel (frontend + `/api` functions) plus Supabase cloud. Set all the `.env` variables as Vercel environment variables, and set the Supabase edge-function secrets via `supabase secrets set` (see §5 and the README).

---

## 5. Database seed & email

### Seed data

`supabase/migrations/002_seed_data.sql` inserts **real Akron venues, organizers, and events** so a fresh database isn't empty. Replace its `insert` statements with a handful of venues from your city (keep the column structure; the hardcoded UUIDs are fine to reuse or regenerate). Migrations `003`+ are schema/feature changes and are city-agnostic — run them as-is.

You don't strictly need to hand-write much seed data: once your scrapers run, the `venues`/`organizations` tables fill themselves. The seed mainly gives the homepage something to show on day one.

### Email (Resend)

The edge functions send mail via [Resend](https://resend.com). Set these secrets (see README for the full `notify-pending-event` list; `send-digest`, `subscribe`, `unsubscribe`, `preferences` share most of them):

- `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_REPLY_TO` — your verified sending domain (the Akron default is `digest@akronpulse.com`)
- `ADMIN_NOTIFY_EMAIL` — where pending-event alerts go
- `PUBLISH_TOKEN_SECRET` — fresh ≥32-byte random string for *your* deployment (never reuse Akron's)
- `PUBLIC_SITE_URL` — your domain

---

## 6. Data sources — the scrapers

This is the largest part of the work. The ~50 scrapers in `scripts/scrape-*.js` are almost all **Akron-specific venues and municipalities** (Akron Civic Theatre, Stan Hywet, City of Stow, etc.). For your city you'll delete most of them and write your own. Three are reusable as-is by reconfiguration:

- **`fetch-ticketmaster.js`** — geographic (radius search). Works for any city once you set the coordinates in §1.
- **`scrape-eventbrite.js`** — geographic. Works once you set the place slug/coords in §1.
- **City municipal scrapers** built on `scripts/lib/civicplus.js` — if your local towns run **CivicPlus / CivicEngage** sites (very common for US municipalities), you can clone one config and just change the domain. See §7.

### What "a source" touches — keep these in sync

Per the project's own convention, **every scraper add/edit/remove must update four places** (this is enforced by review and keeps the public `/technical` page honest):

1. The script itself in `scripts/scrape-*.js` (and its `source` key used in `normalize.js` upserts).
2. `package.json` — the `scrape:<name>` script entry **and** the `scrape:all` chain.
3. `src/pages/TechnicalPage.jsx` — `DATA_SOURCES` (the row), `SOURCE_GROUP_BY_KEY` (which group it belongs to), `SCRAPER_LABELS` (display name), and `SOURCE_GROUPS` only if the *platform* is new.
4. Any source-key references in dedupe/health tooling (`dedupe-cross-source.js`, `check-scraper-health.js`).

### Retargeting workflow

1. **Decide your source list.** Look at how Akron is grouped in `DATA_SOURCES` / `SOURCE_GROUPS` for inspiration: public REST APIs (Ticketmaster, a sports team, a university LiveWhale calendar), municipal CivicPlus calendars, individual venue sites (theaters, museums, music venues), and aggregators (a regional "what's on" magazine, the CVB/visitors bureau).
2. **Keep & reconfigure** Ticketmaster + Eventbrite (§1).
3. **Delete** the Akron-only scrapers you won't use — remove the script file, its `package.json` entries, and its `DATA_SOURCES`/`SOURCE_GROUP_BY_KEY`/`SCRAPER_LABELS` rows.
4. **Add** your local sources (§7).
5. Rebuild the `scrape:all` chain in `package.json` to list exactly your active scrapers, ending with `node scripts/dedupe-cross-source.js --apply`.

---

## 7. Adding a new scraper

### Easiest case: a CivicPlus municipal calendar

Many US cities/townships use CivicPlus. These take ~10 lines. Copy `scripts/scrape-city-of-stow.js` and edit the config:

```js
import { runCivicPlusScraper } from './lib/civicplus.js'

runCivicPlusScraper({
  source:    'city_of_yourtown',          // unique source key (also used in normalize upsert)
  origin:    'https://www.yourtown.gov',  // the CivicPlus site root
  catIDs:    [14],                        // calendar category IDs to ingest (14 = Main Calendar on most sites)
  cityLabel: 'Yourtown',
  emoji:     '🌳',
  organization: { name: 'City of Yourtown', details: { website: '…', description: '…' } },
  defaultVenue: { name: 'Yourtown City Hall', address: '…', zip: '…', website: '…' },
  baseTags: ['city-of-yourtown', 'yourtown-state'],
})
```

Find the `catID` values by opening the city's calendar page and reading the category filter URLs. The shared helper already drops board/commission/governance meetings.

### General case: a custom venue scraper

For a one-off venue, write a script that fetches the source, maps each event into the common shape, and upserts it. The shared helpers in `scripts/lib/normalize.js` do the heavy lifting:

- `ensureVenue(name, details)` / `ensureOrganization(name, details)` — idempotent upserts that return an id; venues are auto-classified to a neighborhood by polygon at insert time when lat/lng is present.
- `upsertEventSafe(row)` — sanitizes and upserts on the `(source, source_id)` unique key.
- `linkEventVenue` / `linkEventOrganization` / `syncEventCategories` — wire up the junction tables.
- `inferCategory` / `inferCategories` — keyword-based category tagging.
- `easternToIso(localDateStr)` — convert a local date/time string to stored ISO (see the timezone note in §1).

Many venue sites expose structured data you should check for first — it's far more robust than HTML scraping:

- **JSON-LD** (`schema.org/Event`): `scripts/lib/json-ld.js`
- **The Events Calendar / Tribe** WordPress REST API: see `parseCostFromTribe` / `parseTagsFromTribe` in `normalize.js`
- **ICS** feeds: `scripts/lib/ics.js`
- **Squarespace** events: `scripts/lib/squarespace.js`
- **Puppeteer** for SPAs / Cloudflare-challenged sites: `scripts/lib/puppeteer.js`

Write a test under `scripts/tests/` (run with `npm test`) for any non-trivial parsing, then register the scraper in all four places listed in §6.

---

## 8. Final verification

After retargeting, confirm the basics before deploying:

- [ ] `npm run dev` boots and the homepage shows your seed/scraped events, not Akron's.
- [ ] Search the repo for `akron`, `summit`, `330`, `pulse` (case-insensitive) — every remaining hit is intentional (a renamed identifier or a doc comment you've reviewed).
- [ ] Run two or three scrapers and confirm rows land in `events` with correct **dates/times** (timezone sanity — pick an event and compare to the source site) and correct **venue → neighborhood** classification.
- [ ] `npm run health` shows your active scrapers; `npm run check:venues` flags no obvious duplicate venues.
- [ ] `npm run lint` and `npm test` pass.
- [ ] The `/technical` page lists exactly your active sources (DATA_SOURCES is in sync with `package.json`).
- [ ] OG preview: load `/api/preview/event/<an-id>` and confirm your site name/branding, not Akron's.
- [ ] Production env vars + Supabase secrets set, `PUBLIC_SITE_URL` points at your domain, and a fresh `PUBLISH_TOKEN_SECRET` is generated for your deployment.

When all of that is green, deploy to Vercel and point your domain at it.
