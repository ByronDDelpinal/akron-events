/**
 * festivals.ts
 *
 * Types and discovery helpers over the FESTIVALS registry. Tiny static
 * registry of festival hub pages (/festival/:slug). A festival hub is a
 * per-tag schedule view over ordinary event rows — discovery is by the
 * `tag` below (GIN-indexed events.tags), so adding next year's festival
 * is one entry in festivalsData.js plus a new data file for the importer; no
 * schema work. Unknown slugs render not-found (see src/pages/FestivalPage.tsx).
 *
 * The registry DATA lives in ./festivalsData.js (2026-08-14,
 * docs/umbrella-child-hiding.md §1.4) — a plain-JS, zero-import array so
 * Vercel functions and other plain-JS modules can read the exact same
 * array this file types, with no duplicated tag list to drift. Deliberately
 * NOT named festivals.js: Vite/Rollup resolves a bare `@/lib/festivals`
 * import to `.js` before `.ts` when both exist, which would silently steer
 * every TS import of this file (types, discovery helpers) at the data-only
 * file instead. `tsconfig.json` has `allowJs: true` and `moduleResolution:
 * bundler`, so importing the .js array here and annotating it `Festival[]`
 * still fails `npm run typecheck` on a malformed entry. Edit
 * festivalsData.js to add or change a festival; docs/festival-playbook.md
 * step 1 points there.
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
import { FESTIVALS as RAW_FESTIVALS } from './festivalsData.js'

export type FestivalBBox = [number, number, number, number]

export interface FestivalLandmark {
  name: string
  lat: number
  lng: number
}

/** Noun for the umbrella card's count line (docs/umbrella-child-hiding.md
 *  §3.3), e.g. { singular: 'set', plural: 'sets' } for PorchRokr. Omit to
 *  fall back to the default 'event' / 'events'. */
export interface FestivalChildLabel {
  singular: string
  plural: string
}

export interface Festival {
  slug: string
  name: string
  /** Eastern calendar date of the festival day, 'yyyy-MM-dd'. Compare via
   *  dayPlanDate.ts's easternDateKey/easternTodayIso — never a UTC-derived
   *  "today", never a Date-vs-string compare. For a multi-day festival this
   *  is the FIRST day; see endDateKey. */
  dateKey: string
  /** Eastern calendar date of the festival's LAST day, 'yyyy-MM-dd'. Omit
   *  for a single-day festival (festivalEndDateKey then returns dateKey).
   *  Must be >= dateKey. Route every range question through
   *  festivalEndDateKey / isFestivalDateKey / festivalDateKeys /
   *  festivalDayCount below rather than doing the range math at the call
   *  site. */
  endDateKey?: string
  /** How the hub lays out the schedule. Omit for 'slot'.
   *
   *  'slot' (default): one heading per distinct start time, each holding the
   *  cards that share that instant. Right when many sets share few start
   *  times, which is what makes the time the useful grouping (PorchRokr:
   *  161 sets across 6 slots).
   *
   *  'day': one heading per Eastern day, holding that day's cards as a
   *  single grid in start order. Right when starts are mostly unique, where
   *  per-slot headings would degenerate into one heading per card and a very
   *  long scroll (Rubber City Jazz: 18 sets across 17 distinct starts). The
   *  card already shows its own date, time and venue, so nothing is lost.
   *
   *  Read it through festivalScheduleMode() rather than the raw field, so
   *  the default lives in exactly one place. */
  schedule?: 'slot' | 'day'
  /** events.tags value that marks every row belonging to this festival
   *  (per-set events AND the umbrella, which additionally carries
   *  'festival-umbrella'). Also the ONLY source for
   *  src/lib/browseVisibility.js's FESTIVAL_TAGS — never hand-duplicate
   *  this list anywhere else. */
  tag: string
  mapBounds: FestivalBBox
  landmarks: FestivalLandmark[]
  website?: string
  /** Importer prefix stamped onto every minted venue name (e.g.
   *  'PorchRokr '), stripped for display by festivalSchedule.ts's
   *  stripVenuePrefix. Omit when the festival's venues carry clean names. */
  venueNamePrefix?: string
  /** Umbrella card copy noun. Omit for the default 'event' / 'events'. */
  childLabel?: FestivalChildLabel
}

// The explicit `Festival[]` annotation is load-bearing: it's what makes a
// malformed entry in festivalsData.js (missing field, wrong shape) fail
// `npm run typecheck` even though the data itself lives in a plain-JS file.
export const FESTIVALS: Festival[] = RAW_FESTIVALS

export function festivalBySlug(slug: string | undefined): Festival | null {
  if (!slug) return null
  return FESTIVALS.find((f) => f.slug === slug) ?? null
}

// ── Multi-day range helpers ──────────────────────────────────────────────
//
// dateKey stays the FIRST day for every festival (single-day and multi-day
// alike); endDateKey is the LAST day, omitted (and so equal to dateKey) for
// a single-day entry. Every range question routes through these four pure
// helpers so no consumer ever repeats the range math itself.

/** The hub's schedule layout for this festival: 'slot' unless the entry says
 *  otherwise. The ONE place the default lives, so a missing field and an
 *  explicit `schedule: 'slot'` can never drift apart. */
export function festivalScheduleMode(f: Festival): 'slot' | 'day' {
  return f.schedule ?? 'slot'
}

/** The festival's last Eastern day; `dateKey` itself when `endDateKey` is absent. */
export function festivalEndDateKey(f: Festival): string {
  return f.endDateKey ?? f.dateKey
}

/** True when `dateKey` falls within the festival's run, inclusive both ends.
 *  Plain string comparison: ISO 'yyyy-MM-dd' keys sort lexicographically,
 *  so this needs no Date construction and reads no clock. */
export function isFestivalDateKey(f: Festival, dateKey: string): boolean {
  return dateKey >= f.dateKey && dateKey <= festivalEndDateKey(f)
}

/** Every Eastern day of the festival's run, ascending, e.g.
 *  ['2026-09-10', '2026-09-11', '2026-09-12']. One key for a single-day
 *  festival. Walks the range on a fixed-local-noon Date (never
 *  toISOString), the same technique dayPlanDate.ts's own diff uses, so a
 *  day boundary is never crossed by a UTC offset during the walk. */
export function festivalDateKeys(f: Festival): string[] {
  const end = festivalEndDateKey(f)
  const spanDays = easternDateKeyDiffDays(f.dateKey, end)
  const startNoon = new Date(`${f.dateKey}T12:00:00`)
  const keys: string[] = []
  for (let i = 0; i <= spanDays; i++) {
    const noon = new Date(startNoon.getTime() + i * 86_400_000)
    const y = noon.getFullYear()
    const m = noon.getMonth()
    const d = noon.getDate()
    keys.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
  }
  return keys
}

/** Number of Eastern days the festival spans; 1 for a single-day festival. */
export function festivalDayCount(f: Festival): number {
  return festivalDateKeys(f).length
}

/** Display-only date label built from an already-resolved registry date
 *  key, never a clock read. Single day: unchanged shape ("Saturday, August
 *  15, 2026"). Multi-day: "Thursday, September 10 to Saturday, September
 *  12, 2026": the word "to", never an em dash, between the endpoints. */
export function festivalDateRangeLabel(f: Festival): string {
  const end = festivalEndDateKey(f)
  const labelFmt = (dateKey: string, opts: Intl.DateTimeFormatOptions) =>
    new Date(`${dateKey}T12:00:00`).toLocaleDateString([], opts)
  if (end === f.dateKey) {
    return labelFmt(f.dateKey, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  }
  const start = labelFmt(f.dateKey, { weekday: 'long', month: 'long', day: 'numeric' })
  const endLabel = labelFmt(end, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  return `${start} to ${endLabel}`
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
  // A festival mid-run is still "upcoming": compare against its LAST day,
  // not its first.
  const upcoming = matches.filter((f) => festivalEndDateKey(f) >= todayIso)
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
 * The festival to promote on the homepage banner: its FIRST day is within
 * [0, 7] days of the Eastern today AND its LAST day has not yet passed,
 * inclusive on both ends, so a single-day festival collapses to the old
 * [0, 7]-of-dateKey rule exactly, and a multi-day festival stays in window
 * for its whole run instead of dropping off the homepage on day 2. Multiple
 * in-window festivals: earliest dateKey wins.
 */
export function upcomingFestival(
  todayIso: string = easternTodayIso(),
  registry: Festival[] = FESTIVALS,
): Festival | null {
  const inWindow = registry.filter((f) => {
    const startDiff = easternDateKeyDiffDays(todayIso, f.dateKey)
    const endDiff = easternDateKeyDiffDays(todayIso, festivalEndDateKey(f))
    return startDiff <= 7 && endDiff >= 0
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

/** Display-only weekday name, same construction festivalDayLabel's own
 *  fallback uses (shares that allowlist entry in test-no-utc-today.js). */
function weekdayLabel(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })
}

/**
 * The banner headline phrase HomePage interpolates after "{name} is ".
 * Single day: byte-identical to festivalDayLabel (today / tomorrow /
 * weekday). Multi-day, per the run's position relative to today:
 *   - before it starts:  "{festivalDayLabel(start)} through {weekday(end)}"
 *   - on its first day:  "today through {weekday(end)}"
 *   - mid-run:           "on now through {weekday(end)}"
 *   - on its last day:   "on its final day"
 *   - after it ended:    the plain weekday form, same as a single-day past
 *     festival. Unreachable from HomePage (which only ever passes
 *     upcomingFestival's output, and that excludes a finished run), but the
 *     helper is exported: "on now through Saturday" is the wrong thing to
 *     say about a festival that is over, so it must not be the fallthrough.
 * No em dash in any phrase.
 */
export function festivalBannerPhrase(f: Festival, todayIso: string = easternTodayIso()): string {
  const end = festivalEndDateKey(f)
  if (end === f.dateKey) return festivalDayLabel(f.dateKey, todayIso)
  if (todayIso > end) return festivalDayLabel(f.dateKey, todayIso)
  if (todayIso === end) return 'on its final day'
  if (todayIso === f.dateKey) return `today through ${weekdayLabel(end)}`
  if (todayIso > f.dateKey) return `on now through ${weekdayLabel(end)}`
  return `${festivalDayLabel(f.dateKey, todayIso)} through ${weekdayLabel(end)}`
}
