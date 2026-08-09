/**
 * festivals.ts
 *
 * Tiny static registry of festival hub pages (/festival/:slug). A festival
 * hub is a per-tag schedule view over ordinary event rows — discovery is by
 * the `tag` below (GIN-indexed events.tags), so adding next year's festival
 * is one entry here plus a new data file for the importer; no schema work.
 * Unknown slugs render not-found (see src/pages/FestivalPage.tsx).
 *
 * mapBounds uses the same [west, south, east, north] BBox shape as
 * planMapPoints.ts / neighborhoodGeo.ts. landmarks feed the (optional) SVG
 * festival map; an empty list simply renders no landmark layer — never
 * invent coordinates to fill it.
 *
 * Node-testable (scripts/tests/test-festivals.js imports this file directly
 * into `node --test`), so imports stay relative-with-extension and DOM-free,
 * following the planMapPoints.ts precedent. The discovery helpers below
 * (resolveFestivalSlug, upcomingFestival, festivalDayLabel) are pure registry
 * math: they take the registry as a parameter (FESTIVALS by default) so tests
 * can inject fixtures, and "today" always flows through dayPlanDate.ts's
 * Eastern helpers — never a UTC-derived today, never a Date-vs-string compare.
 */

import { easternTodayIso, easternDateKeyDiffDays } from './dayPlanDate.ts'
import { NEIGHBORHOODS } from './neighborhoods.ts'
import { CITIES, REGIONS } from './cities.js'

export type FestivalBBox = [number, number, number, number]

export interface FestivalLandmark {
  name: string
  lat: number
  lng: number
}

export interface Festival {
  slug: string
  name: string
  /** Eastern calendar date of the festival day, 'yyyy-MM-dd'. Compare via
   *  dayPlanDate.ts's easternDateKey/easternTodayIso — never a UTC-derived
   *  "today", never a Date-vs-string compare. */
  dateKey: string
  /** events.tags value that marks every row belonging to this festival
   *  (per-set events AND the umbrella, which additionally carries
   *  'festival-umbrella'). */
  tag: string
  mapBounds: FestivalBBox
  landmarks: FestivalLandmark[]
  website?: string
  /** Importer prefix stamped onto every minted venue name (e.g.
   *  'PorchRokr '), stripped for display by festivalSchedule.ts's
   *  stripVenuePrefix. Omit when the festival's venues carry clean names. */
  venueNamePrefix?: string
}

export const FESTIVALS: Festival[] = [
  {
    slug: 'porchrokr-2026',
    name: 'PorchRokr Music & Arts Festival',
    dateKey: '2026-08-15',
    tag: 'porchrokr-2026',
    // Highland Square box from the PorchRokr ADR (lat 41.08..41.11,
    // lng -81.56..-81.51) — mirrors HS_BBOX in scripts/import-porchrokr.js.
    mapBounds: [-81.56, 41.08, -81.51, 41.11],
    // Populated once porch coordinates are geocoded and eyeballed; empty on
    // purpose until then (no invented coordinates).
    landmarks: [],
    website: 'https://www.highlandsquareakron.org/',
    venueNamePrefix: 'PorchRokr ',
  },
]

export function festivalBySlug(slug: string | undefined): Festival | null {
  if (!slug) return null
  return FESTIVALS.find((f) => f.slug === slug) ?? null
}

// ── Search-shortcut candidate derivation ─────────────────────────────────
//
// The homepage search box jumps straight to /festival/:slug when the typed
// query names a festival (mirroring resolveHubSlug for neighborhood/city
// hubs). Candidates are derived from registry data alone — no festival name
// is ever hardcoded here or at any call site.

/** Same normalization as HomePage's hub resolver: strip whitespace, hyphens,
 *  and underscores, then lowercase. Exact-match keys only — no fuzziness. */
export function normalizeQueryLabel(s: string): string {
  return s.replace(/[\s\-_]+/g, '').toLowerCase()
}

/** Generic trailing tokens dropped (right to left) from a festival name to
 *  form progressive prefix candidates, e.g. "<Name> Music & Arts Festival"
 *  → "<name> music & arts" → … → "<name>". Derivation stops at the first
 *  non-generic token, so the distinctive part always survives. */
const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set([
  'festival', 'fest', 'music', 'arts', 'art', 'food', 'film', 'street',
  'community', 'and', 'of', '&',
])

/** Normalized labels + slugs of every neighborhood/city/region hub. A
 *  festival candidate that collides with one of these is dropped so the
 *  festival shortcut can never shadow an existing hub jump ("highland
 *  square" must keep going to /events/highland-square). */
const HUB_COLLISION_KEYS: ReadonlySet<string> = new Set(
  [...NEIGHBORHOODS, ...CITIES, ...REGIONS].flatMap((h) => [
    normalizeQueryLabel(h.label),
    normalizeQueryLabel(h.slug),
  ]),
)

/**
 * All normalized query strings that resolve to this festival: the slug, the
 * slug minus a trailing -yyyy year, the full name, and progressive name
 * prefixes formed by dropping trailing generic tokens. Guards: candidates
 * under 4 normalized chars and candidates colliding with hub labels/slugs
 * are dropped.
 */
export function festivalSearchCandidates(f: Festival): string[] {
  const raw = new Set<string>()
  raw.add(normalizeQueryLabel(f.slug))
  raw.add(normalizeQueryLabel(f.slug.replace(/-\d{4}$/, '')))
  raw.add(normalizeQueryLabel(f.name))
  const tokens = f.name.split(/[\s\-_]+/).filter(Boolean)
  let end = tokens.length
  while (end > 1 && GENERIC_NAME_TOKENS.has(tokens[end - 1].toLowerCase())) {
    end -= 1
    raw.add(normalizeQueryLabel(tokens.slice(0, end).join(' ')))
  }
  return [...raw].filter((c) => c.length >= 4 && !HUB_COLLISION_KEYS.has(c))
}

function buildCandidateIndex(registry: Festival[]): Map<string, Festival[]> {
  const index = new Map<string, Festival[]>()
  for (const f of registry) {
    for (const c of festivalSearchCandidates(f)) {
      const hits = index.get(c)
      if (hits) hits.push(f)
      else index.set(c, [f])
    }
  }
  return index
}

/** Derived once at module scope for the real registry; injected registries
 *  (tests) rebuild on the fly. */
const FESTIVAL_CANDIDATE_INDEX = buildCandidateIndex(FESTIVALS)

/**
 * Resolve a search-box query to a festival slug, or null when the query
 * doesn't exactly match any candidate. No relevance window — last year's
 * festival still resolves. When two entries share a candidate (successive
 * years of the same festival both derive the year-stripped slug), the
 * nearest upcoming dateKey wins (dateKey >= todayIso, smallest day diff),
 * else the most recent past one.
 */
export function resolveFestivalSlug(
  query: string,
  todayIso: string = easternTodayIso(),
  registry: Festival[] = FESTIVALS,
): string | null {
  const needle = normalizeQueryLabel(query)
  if (!needle) return null
  const index = registry === FESTIVALS ? FESTIVAL_CANDIDATE_INDEX : buildCandidateIndex(registry)
  const matches = index.get(needle)
  if (!matches || matches.length === 0) return null
  if (matches.length === 1) return matches[0].slug
  const upcoming = matches.filter((f) => f.dateKey >= todayIso)
  const pool = upcoming.length > 0 ? upcoming : matches
  // Smallest absolute day diff picks the nearest upcoming date when the pool
  // is upcoming, and the most recent past date when everything is past.
  const best = [...pool].sort(
    (a, b) =>
      Math.abs(easternDateKeyDiffDays(todayIso, a.dateKey)) -
      Math.abs(easternDateKeyDiffDays(todayIso, b.dateKey)),
  )[0]
  return best.slug
}

// ── Homepage banner window math ──────────────────────────────────────────

/**
 * The festival to promote on the homepage banner: dateKey within [0, 7]
 * days of the Eastern today (inclusive on both ends — festival day itself
 * through a week out). Multiple in-window festivals: earliest dateKey wins.
 */
export function upcomingFestival(
  todayIso: string = easternTodayIso(),
  registry: Festival[] = FESTIVALS,
): Festival | null {
  const inWindow = registry.filter((f) => {
    const diff = easternDateKeyDiffDays(todayIso, f.dateKey)
    return diff >= 0 && diff <= 7
  })
  if (inWindow.length === 0) return null
  return [...inWindow].sort((a, b) => a.dateKey.localeCompare(b.dateKey))[0]
}

/**
 * "today" / "tomorrow" / weekday name for the banner headline. The Date
 * construction at fixed local noon is DISPLAY ONLY (weekday name), matching
 * dayPlanDate.ts's own diff approach — the today/tomorrow decision is pure
 * date-key math.
 */
export function festivalDayLabel(dateKey: string, todayIso: string = easternTodayIso()): string {
  const diff = easternDateKeyDiffDays(todayIso, dateKey)
  if (diff === 0) return 'today'
  if (diff === 1) return 'tomorrow'
  return new Date(`${dateKey}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })
}
