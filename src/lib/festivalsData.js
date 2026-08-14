/**
 * festivalsData.js — the FESTIVALS registry DATA, and nothing else.
 *
 * Split out of festivals.ts (2026-08-14, docs/umbrella-child-hiding.md §1.4)
 * so plain-JS modules that cannot import TypeScript — api/events-first-page.js,
 * api/events-hub.js, api/sitemap.xml.js, api/feed.xml.js, scripts/prerender.js,
 * src/lib/browseVisibility.js — can read the SAME array PostgREST filters and
 * SEO routes are derived from, instead of a hand-duplicated tag list that
 * could drift. This file has ZERO imports and is DOM-free on purpose, so
 * every one of those consumers (Vercel functions, Node scripts, the browser
 * bundle) can import it with no side effects and no runtime mismatch.
 *
 * NOT named festivals.js on purpose: Vite/Rollup's default extension
 * resolution order tries `.js` before `.ts`, so a plain-JS `festivals.js`
 * sitting next to `festivals.ts` would silently hijack every existing
 * `@/lib/festivals` import (which expects the TS file's types and discovery
 * helpers) — confirmed by `npx vite build` failing on exactly that during
 * this split. The distinct basename removes the ambiguity entirely instead
 * of relying on resolver configuration to avoid it.
 *
 * festivals.ts re-exports this array as `FESTIVALS: Festival[]` (see that
 * file for the type, the discovery helpers, and the full field-by-field
 * doc comment) — edit THIS file to add or change a festival entry;
 * docs/festival-playbook.md step 1 points here.
 */

// A plain `[w, s, e, n]` array literal infers as `number[]` (not a 4-tuple)
// when TypeScript reads this plain-JS file for `festivals.ts`'s `Festival[]`
// annotation — `bbox()`'s `@returns` JSDoc pins the tuple shape instead.
/** @returns {[number, number, number, number]} */
function bbox(west, south, east, north) {
  return [west, south, east, north]
}

export const FESTIVALS = [
  {
    slug: 'porchrokr-2026',
    name: 'PorchRokr Music & Arts Festival',
    dateKey: '2026-08-15',
    tag: 'porchrokr-2026',
    // Highland Square box from the PorchRokr ADR (lat 41.08..41.11,
    // lng -81.56..-81.51) — mirrors HS_BBOX in scripts/import-porchrokr.js.
    mapBounds: bbox(-81.56, 41.08, -81.51, 41.11),
    // Populated once porch coordinates are geocoded and eyeballed; empty on
    // purpose until then (no invented coordinates).
    landmarks: [],
    website: 'https://www.highlandsquareakron.org/',
    venueNamePrefix: 'PorchRokr ',
    // Umbrella card copy noun (docs/umbrella-child-hiding.md §3.3): "161
    // sets on the schedule", not "161 events".
    childLabel: { singular: 'set', plural: 'sets' },
  },
  {
    slug: 'akron-pride-2026',
    // Short display name on purpose: hub title and banner copy read
    // "{name} is Saturday." The umbrella event keeps the full official
    // title ("Akron Pride Festival and Equity March 2026").
    name: 'Akron Pride Festival',
    dateKey: '2026-08-22',
    tag: 'akron-pride-2026',
    // Downtown Akron / Main St corridor seed box (camera fallback only;
    // pins drive fitBounds once the lineup lands).
    mapBounds: bbox(-81.532, 41.072, -81.51, 41.09),
    // Populated once stage coordinates are confirmed; empty on purpose.
    landmarks: [],
    website: 'https://akronpridefestival.org/',
    // No childLabel entry: falls back to the default 'event' / 'events'
    // noun (browseVisibility.js / EventCard.tsx).
  },
]
