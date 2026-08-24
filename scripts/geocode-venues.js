/**
 * geocode-venues.js
 *
 * Backfills lat/lng for venues that are missing coordinates, using the
 * OpenStreetMap Nominatim geocoding API (https://nominatim.org). Runs
 * anywhere with network + the repo .env (locally or CI) — NOT inside the
 * Cowork sandbox, which has no outbound internet. No API token required;
 * Nominatim's usage policy only asks for a descriptive User-Agent, a
 * contact email, and no more than ~1 request/second, all honored here.
 *
 * Quality gates (never write a bad coordinate):
 *   - default mode: result addresstype/class is address-precision (not a
 *     road/city/boundary centroid), the venue's zip (if any) matches the
 *     result's postcode, and the result falls inside the NE-Ohio sanity box
 *   - --names mode: junk venue names (emails, street addresses, state names,
 *     prose) are refused before any API call; a Nominatim hit must then not
 *     be a junk class/type (highway, boundary, place=house, or a
 *     city/town/village/... administrative centroid), must fall inside the
 *     real Summit County polygon (not just a bbox), must agree with the
 *     venue's on-file city (when both sides report one), and must clear
 *     MIN_SIMILARITY_NAMES token-overlap similarity against the venue name
 * Anything failing a gate is listed for manual review, not written.
 *
 * Candidate selection (default mode): venues with an address but no
 * coordinates, narrowed to those with >=1 upcoming published event — a venue
 * nobody is about to visit isn't worth a 1.1s-throttled API call. Before this
 * narrowing a typical night spent 20 lookups to make 1 useful write. Pass
 * --all to opt out.
 *
 * Env:
 *   VITE_SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — service role (bypasses RLS to update venues)
 *
 * Flags:
 *   --dry-run     geocode + report, but write nothing
 *   --limit N     only geocode the first N candidate venues. In default mode
 *                 this is applied AFTER the upcoming-event narrowing below
 *                 (same semantics as --names): N is "venues actually
 *                 geocoded", not "rows fetched from the venues table".
 *   --recheck     also re-geocode venues that already have coordinates
 *   --all         DEFAULT MODE ONLY: skip the upcoming-event narrowing and
 *                 geocode every addressed venue missing coordinates,
 *                 including ones nobody is about to visit. The old
 *                 (pre-narrowing) behaviour, kept for deliberate full
 *                 backfills. Ignored in --names mode, which has always
 *                 filtered on upcoming events.
 *
 *   --names       ALTERNATE MODE: geocode by venue NAME instead of street
 *                 address, for venues that have NO lat, NO lng, AND NO
 *                 usable address at all (nothing else to geocode from), and
 *                 that have at least one upcoming published event. Refuses
 *                 junk venue names (emails, street addresses, state names,
 *                 prose) before making any API call. Queries Nominatim
 *                 free-form, bounded by a Summit County viewbox (a query
 *                 hint, not the acceptance gate), and gates on the real
 *                 Summit County polygon + a venue/result city match + name-
 *                 similarity + a junk-class filter (see above). NOTE: this
 *                 mode is DRY RUN BY DEFAULT — the opposite of the default
 *                 mode above — because a bare-name lookup is much more
 *                 likely to hit a same-named place in the wrong city. Pass
 *                 --write to actually update rows.
 *   --write       (only meaningful with --names) perform the writes.
 *                 If --dry-run is also passed, --dry-run wins (no writes) —
 *                 the explicit safety flag beats the explicit danger flag.
 *
 * Usage:  node scripts/geocode-venues.js [--dry-run] [--limit 50] [--all]
 *         node scripts/geocode-venues.js --names [--write] [--limit 50]
 */
import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { isJunkVenueName, looksLikeStreetAddress } from './lib/normalize.js'
import { classifySummitLocation, preloadSummitCountyBoundary } from './lib/summit-county.js'

// Nominatim usage-policy identification. Required by policy; also the only
// way Nominatim can reach us if a query pattern needs adjusting.
const CONTACT_EMAIL = 'byronddelpinal@gmail.com'
const USER_AGENT = 'AkronPulse-Akron-Events/1.0 (geocode-venues; byronddelpinal@gmail.com)'

// NE-Ohio / Greater Akron bounding box: [west, south, east, north].
// Mirrors SANITY_BBOX in src/lib/geocode.ts — keep the two in sync.
const SANITY_BBOX = { west: -82.3, south: 40.6, east: -80.7, north: 41.7 }

// Rate limit: Nominatim's usage policy caps at ~1 request/second. Pace every
// request (including the second half of a 429/403 retry pair) at least this
// far apart.
const RATE_LIMIT_MS = 1100
// One retry after a 429/403, per policy ("back off and try again shortly").
const RETRY_DELAY_MS = 5000

// Address-mode gate (a): result addresstype/class must indicate an actual
// address-precision place (a building, business, or named site), not a
// road, a city/town/village centroid, or an administrative boundary.
const ADDRESS_PRECISION_ALLOWLIST = new Set([
  'building', 'amenity', 'shop', 'leisure', 'tourism', 'office',
  'place_of_worship', 'university', 'school', 'hospital', 'college',
  'government', 'healthcare', 'craft', 'club',
])
const ADDRESS_PRECISION_REJECT_CLASSES = new Set(['highway', 'boundary'])
// class=place covers everything from a rooftop house-number match (type=house
// — confirmed live: Nominatim reports addresstype="place" for these, NOT
// "house", so it can't go through the addresstype allowlist above) down to
// city/town/village/county/neighbourhood centroids. Only the former is a
// defensible venue point; every other place type is an area/region, not an
// address.
const PLACE_PRECISE_TYPES = new Set(['house'])

// --names mode gates. Tighter than SANITY_BBOX above: a name-only lookup has
// no street address to anchor it, so a wrong-city false positive (a
// same-named bar/venue elsewhere) is much easier to get than with a full
// address query. Hard-constrain to Summit County itself, not just NE Ohio.
// NAMES_BBOX is a Nominatim viewbox query bound (biases/limits candidate
// results server-side) — NOT the acceptance gate; the real gate is the
// Summit County polygon via classifySummitLocation() in the loop below.
const NAMES_BBOX = { west: -81.69, south: 40.90, east: -81.36, north: 41.35 }
const MIN_SIMILARITY_NAMES = 0.8
const JUNK_CLASSES = new Set(['highway', 'boundary'])
// class=place types that are administrative centroids, not a point anyone
// can visit — rejected alongside the pre-existing place=house rule. Does NOT
// include 'park': a place=park hit (e.g. a named green space) still passes
// through to the similarity gate.
const PLACE_ADMIN_TYPES = new Set([
  'city', 'town', 'village', 'hamlet', 'borough', 'suburb', 'neighbourhood',
  'quarter', 'locality', 'municipality', 'county', 'state', 'region', 'island',
])

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const RECHECK = args.includes('--recheck')
const NAMES_MODE = args.includes('--names')
// Default mode only: opt out of the upcoming-event narrowing in main().
const GEO_ALL = args.includes('--all')
// --dry-run wins over --write in --names mode: the explicit safety flag
// beats the explicit danger flag if both are somehow passed together.
const NAMES_WRITE = args.includes('--write') && !DRY_RUN
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : null
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fullAddress(v) {
  return [v.address, v.city, v.state, v.zip].filter(Boolean).join(', ')
}

function inSanityBox(lng, lat) {
  return lng >= SANITY_BBOX.west && lng <= SANITY_BBOX.east &&
         lat >= SANITY_BBOX.south && lat <= SANITY_BBOX.north
}

/**
 * Thrown when Nominatim answers 429/403 twice in a row (initial attempt +
 * one retry) — a policy block, not a per-query miss. Callers abort the run
 * on this rather than treating it as a normal per-venue failure: continuing
 * to hammer an API that's actively refusing us is both futile and rude.
 */
class NominatimBlockedError extends Error {
  constructor(status) {
    super(`Nominatim returned HTTP ${status} twice in a row (after retry) — policy block, aborting run`)
    this.name = 'NominatimBlockedError'
    this.status = status
  }
}

/**
 * Builds a sleep-before-fire rate limiter: the returned async function
 * blocks until at least `minIntervalMs` has elapsed since the previous call
 * returned, then records the new "last call" time. `now`/`wait` are
 * injectable (default to Date.now / the real sleep()) so tests can drive it
 * with a fake clock instead of burning real wall-clock time.
 *
 * Living inside nominatimFetch (rather than a per-loop `await sleep(...)`
 * after the try) is the point: it paces every request — both modes, the
 * 429/403 retry, and any request that's about to throw on a 5xx/network
 * error — instead of only the happy path. A per-loop sleep placed after the
 * fetch inside a try block never runs when the fetch throws, so the next
 * request fired immediately; a shared pre-fetch limiter can't be skipped.
 */
export function createRateLimiter(minIntervalMs, { now = Date.now, wait = sleep } = {}) {
  let lastCallAt = -Infinity
  return async function pace() {
    const elapsed = now() - lastCallAt
    if (elapsed < minIntervalMs) await wait(minIntervalMs - elapsed)
    lastCallAt = now()
  }
}

const paceNominatimRequest = createRateLimiter(RATE_LIMIT_MS)

/**
 * Fetch one Nominatim URL. Sleeps first (shared limiter, see
 * createRateLimiter above) so every request — including retries and paths
 * that end in a thrown error — is paced. On 429/403, waits RETRY_DELAY_MS
 * and retries once; a second 429/403 throws NominatimBlockedError. Any other
 * non-2xx status throws a plain Error. Returns parsed JSON on success.
 */
export async function nominatimFetch(url, attempt = 1) {
  await paceNominatimRequest()
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (res.status === 429 || res.status === 403) {
    if (attempt >= 2) throw new NominatimBlockedError(res.status)
    await sleep(RETRY_DELAY_MS)
    return nominatimFetch(url, attempt + 1)
  }
  if (!res.ok) throw new Error(`Nominatim ${res.status}`)
  return res.json()
}

// ── default (address) mode: gate logic (exported pure functions, unit-tested) ──

/**
 * Address-mode gate (a): is this result precise enough to trust as a venue
 * location? Prefers the top-level `addresstype` Nominatim returns (the OSM
 * key used to categorize the match, e.g. "shop", "amenity", "building"),
 * falling back to `class` when addresstype is absent. Explicitly rejects
 * roads, city/town/village centroids, and administrative boundaries even if
 * they'd otherwise slip through — those are never a defensible venue point.
 */
export function hasAddressPrecision(result) {
  if (!result) return false
  const cls = result.class
  const type = result.type
  if (cls && ADDRESS_PRECISION_REJECT_CLASSES.has(cls)) return false
  if (cls === 'place') return PLACE_PRECISE_TYPES.has(type)
  const key = result.addresstype || cls
  return typeof key === 'string' && ADDRESS_PRECISION_ALLOWLIST.has(key)
}

/** Normalize a US zip to its first 5 digits for comparison. */
function normalizeZip5(zip) {
  const digits = String(zip ?? '').match(/\d{5}/)
  return digits ? digits[0] : null
}

/**
 * Address-mode gate (b): if the venue has a zip on file, the result's
 * address.postcode must match it (first 5 digits — a result with a zip+4
 * still counts as a match). A venue with no zip on file passes through
 * (nothing to check against). A venue with a zip but a result with no
 * postcode at all fails — that's a mismatch, not an absence.
 */
export function zipMatches(venueZip, result) {
  const wantZip = normalizeZip5(venueZip)
  if (!wantZip) return true
  const gotZip = normalizeZip5(result && result.address && result.address.postcode)
  return gotZip !== null && gotZip === wantZip
}

/**
 * Combined default-mode quality gate for one Nominatim structured-search
 * hit: address precision (a), zip match (b), and the NE-Ohio sanity box (c).
 * Any one failing sends the venue to manual review, never a write.
 */
export function passesAddressGate(venue, result) {
  if (!result) return false
  if (!hasAddressPrecision(result)) return false
  if (!zipMatches(venue && venue.zip, result)) return false
  const lat = parseFloat(result.lat)
  const lng = parseFloat(result.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  return inSanityBox(lng, lat)
}

/**
 * Human-readable reason a result failed passesAddressGate, for the skip
 * report. Checked in the same order as the gate itself.
 */
function addressGateFailureReason(venue, result) {
  if (!hasAddressPrecision(result)) {
    const key = result.addresstype || result.class || 'unknown'
    return `imprecise match (addresstype/class=${key})`
  }
  if (!zipMatches(venue && venue.zip, result)) {
    const got = (result.address && result.address.postcode) || 'none'
    return `zip mismatch (venue=${venue.zip}, result=${got})`
  }
  return `out of area (${result.lat}, ${result.lon})`
}

/**
 * Geocode one venue via Nominatim's structured search — street/city/state/
 * postalcode as separate params rather than one free-text string, which
 * lets Nominatim's own address parser (rather than ours) resolve ambiguity.
 * Returns the raw top result object, or null if Nominatim returned nothing.
 */
export async function geocodeAddress(v) {
  const params = new URLSearchParams({
    format: 'json',
    addressdetails: '1',
    countrycodes: 'us',
    limit: '1',
    email: CONTACT_EMAIL,
  })
  if (v.address) params.set('street', v.address)
  if (v.city) params.set('city', v.city)
  if (v.state) params.set('state', v.state)
  if (v.zip) params.set('postalcode', v.zip)

  const url = `https://nominatim.openstreetmap.org/search?${params}`
  const json = await nominatimFetch(url)
  return Array.isArray(json) && json.length ? json[0] : null
}

// ── --names mode: gate logic (exported pure functions, unit-tested) ───────

/** True if a [lng, lat] pair falls inside the Summit County bbox. */
export function inSummitBbox(lng, lat) {
  return lng >= NAMES_BBOX.west && lng <= NAMES_BBOX.east &&
         lat >= NAMES_BBOX.south && lat <= NAMES_BBOX.north
}

// Common venue-name spelling/abbreviation variants that mean the same word
// for matching purposes (British vs American spelling, and the abbreviations
// Nominatim/venue data entry commonly use for street-type and building words).
const NAME_TOKEN_SYNONYMS = {
  theatre: 'theater',
  centre: 'center',
  st: 'street',
  ave: 'avenue',
  rd: 'road',
  dr: 'drive',
  blvd: 'boulevard',
  hts: 'heights',
  ctr: 'center',
}
// Low-signal filler words dropped before comparing two names — none of these
// carry venue identity on their own ("the", "in", "at" ...).
const NAME_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'on', 'and'])

/**
 * Lowercase, strip punctuation, split into non-empty whitespace tokens, map
 * spelling/abbreviation variants to a single canonical form (NAME_TOKEN_
 * SYNONYMS), then drop stopwords (NAME_STOPWORDS). If dropping stopwords
 * would empty the list, fall back to the pre-stopword (but still mapped)
 * tokens instead — a real venue name should never normalize to [].
 */
export function normalizeNameTokens(str) {
  const rawTokens = String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const mapped = rawTokens.map((t) => NAME_TOKEN_SYNONYMS[t] || t)
  const withoutStopwords = mapped.filter((t) => !NAME_STOPWORDS.has(t))
  return withoutStopwords.length ? withoutStopwords : mapped
}

/**
 * Normalized token-overlap similarity between two names, as the Sørensen–
 * Dice coefficient over their token sets: 2*|A∩B| / (|A|+|B|). Symmetric,
 * 0..1, and forgiving of one name being a superset of the other's words
 * (e.g. "Lock 3" vs "Lock 3 Park" → 2*2/(2+3) = 0.8) while still requiring
 * real overlap, not just a shared word.
 */
export function tokenOverlapSimilarity(a, b) {
  const setA = new Set(normalizeNameTokens(a))
  const setB = new Set(normalizeNameTokens(b))
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const t of setA) if (setB.has(t)) intersection++
  return (2 * intersection) / (setA.size + setB.size)
}

// A derived (non-verbatim, non-cleaned-base) name-variant rung is only worth
// an API call if it still looks like a specific place: at least 2
// significant tokens, and at least 1 token that isn't one of these generic
// venue/room words shared by hundreds of unrelated places ("Main Stage",
// "Community Room" tell you nothing on their own). Applied to the "in"/"at"
// derived rungs only — the verbatim name and the cleaned base always survive.
const GENERIC_VENUE_WORDS = new Set([
  'main', 'stage', 'room', 'hall', 'ballroom', 'lobby', 'lounge', 'studio',
  'gallery', 'wing', 'annex', 'pavilion', 'patio', 'deck', 'floor', 'suite',
  'theater', 'auditorium', 'gym', 'cafeteria', 'plaza', 'green', 'lawn',
  'grounds', 'course', 'center', 'club', 'lodge', 'bar', 'house', 'park',
  'field', 'arena', 'stadium', 'church', 'library', 'school',
])

const MAX_NAME_VARIANTS = 4
const NAME_LEADING_ARTICLE_RE = /^(the|a|an)\s+/i
const NAME_PARENTHETICAL_RE = /\s*\([^)]*\)/g

/** Strip a leading "The "/"A "/"An ", strip any (parenthetical), collapse
 *  whitespace. Used both as its own variant rung and as the base the " in "/
 *  " at " derived rungs are split from. */
function cleanedNameBase(name) {
  let s = String(name || '').trim()
  s = s.replace(NAME_LEADING_ARTICLE_RE, '')
  s = s.replace(NAME_PARENTHETICAL_RE, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/** VARIANT FLOOR for a derived (c/d) rung: >=2 significant tokens AND >=1
 *  token outside GENERIC_VENUE_WORDS. Never applied to the verbatim name or
 *  the cleaned base, which are always kept regardless. */
function passesVariantFloor(candidate) {
  const tokens = normalizeNameTokens(candidate)
  if (tokens.length < 2) return false
  return tokens.some((t) => !GENERIC_VENUE_WORDS.has(t))
}

/**
 * Build the ladder of name variants to try against Nominatim, in order,
 * deduped (case-insensitive) and capped at MAX_NAME_VARIANTS:
 *   a) the original name, verbatim — always first, always kept.
 *   b) the cleaned base (leading article + parenthetical stripped) —
 *      always kept.
 *   c) if the cleaned base contains " in ", the HEAD only — the tail after
 *      " in " is a locality ("... in Kenmore"), which PLACE_ADMIN_TYPES
 *      already rejects, so it is never worth querying.
 *   d) if the cleaned base contains " at ", the HEAD (the more specific
 *      place) then the TAIL (the coarser but still correct containing
 *      site), in that order.
 * Rungs c and d are subject to the VARIANT FLOOR (passesVariantFloor); a and
 * b never are. Pure + exported for tests.
 */
export function buildNameVariants(name) {
  const original = String(name || '').trim()
  const variants = []
  const seen = new Set()
  const push = (candidate) => {
    const trimmed = String(candidate || '').trim()
    if (!trimmed || variants.length >= MAX_NAME_VARIANTS) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    variants.push(trimmed)
  }

  push(original) // (a)

  const base = cleanedNameBase(original)
  push(base) // (b)

  if (base.includes(' in ')) {
    const idx = base.indexOf(' in ')
    const head = base.slice(0, idx).trim()
    if (passesVariantFloor(head)) push(head) // (c) — head only, never the tail.
  }

  if (base.includes(' at ')) {
    const idx = base.indexOf(' at ')
    const head = base.slice(0, idx).trim()
    const tail = base.slice(idx + ' at '.length).trim()
    if (passesVariantFloor(head)) push(head) // (d1) — more specific place first.
    if (passesVariantFloor(tail)) push(tail) // (d2) — coarser containing site.
  }

  return variants
}

/**
 * The name to compare a --names query against: Nominatim's namedetails.name
 * when present (the actual OSM `name` tag), falling back to the first
 * display_name segment (display_name is "Name, street, city, ..." — the
 * first segment is usually the name when namedetails wasn't requested or
 * the feature has no explicit name tag).
 */
export function resultDisplayName(result) {
  if (!result) return ''
  if (result.namedetails && result.namedetails.name) return result.namedetails.name
  if (result.display_name) return String(result.display_name).split(',')[0].trim()
  return ''
}

/**
 * --names mode junk filter: roads, administrative boundaries, a bare
 * place=house result, and (extended) any place=<city/town/village/...>
 * administrative centroid are never a defensible venue match regardless of
 * how similar the name looks (a road can share a name with a business on
 * it; a city/county centroid is not a point anyone can visit).
 * PLACE_ADMIN_TYPES intentionally does NOT include 'park' — a place=park
 * hit (e.g. a named green space) still passes through to the similarity
 * gate.
 */
export function isJunkClassType(cls, type) {
  if (!cls) return false
  if (JUNK_CLASSES.has(cls)) return true
  if (cls === 'place' && (type === 'house' || PLACE_ADMIN_TYPES.has(type))) return true
  return false
}

/**
 * Combined --names quality gate for one Nominatim hit: not a junk class/type,
 * and its name clears MIN_SIMILARITY_NAMES token-overlap similarity against
 * the venue name. Does NOT check the Summit County polygon or the venue/
 * result city match — those are separate post-hoc rejects applied by the
 * caller (runNamesMode), since they depend on the hit's coordinates/address
 * fields rather than its name/class fields. Kept for tests / call sites that
 * only need the name+class half of the gate.
 */
export function passesNamesGate(venueName, result) {
  if (!result) return false
  if (isJunkClassType(result.class, result.type)) return false
  const candidateName = resultDisplayName(result)
  if (!candidateName) return false
  return tokenOverlapSimilarity(venueName, candidateName) >= MIN_SIMILARITY_NAMES
}

/**
 * --names mode pre-filter: is this venue's NAME even worth sending to
 * Nominatim? Refuses:
 *   - too short to be a real name (<3 chars after trimming)
 *   - no letters at all
 *   - an email address or URL leaking into the name field (a stray contact
 *     string from a flyer/intake form, e.g. "For venue details reach us at
 *     info@learnerring.com")
 *   - a junk venue name per isJunkVenueName() (bare state name, "TBD",
 *     "Church Street", ...)
 *   - a bare street address per looksLikeStreetAddress() (e.g.
 *     "1146 W Highland Rd")
 *   - prose in the name slot: more than 8 whitespace-separated tokens
 * Checked BEFORE the upcoming-event narrowing in runNamesMode() so a refusal
 * costs zero API calls. Pure + exported for tests.
 */
const EMAIL_OR_URL_PATTERN = /@|https?:\/\/|www\./i

/**
 * Same gate as isGeocodableVenueName, but returns WHICH rule refused the
 * name (or null when it clears all of them) instead of collapsing every
 * refusal into one flat boolean. Lets the --names report stamp each refused
 * venue with the specific check that caught it rather than a uniform "junk
 * name" label that told a reviewer nothing about which of the six checks
 * fired. Pure + exported for tests.
 */
export function venueNameRefusalReason(name) {
  const trimmed = String(name ?? '').trim()
  if (trimmed.length < 3) return 'too short'
  if (!/[a-z]/i.test(trimmed)) return 'no letters'
  if (EMAIL_OR_URL_PATTERN.test(trimmed)) return 'email/url'
  if (isJunkVenueName(trimmed)) return 'state name'
  if (looksLikeStreetAddress(trimmed)) return 'street address'
  const tokenCount = trimmed.split(/\s+/).filter(Boolean).length
  if (tokenCount > 8) return 'prose'
  return null
}

/** Boolean-compatible wrapper over venueNameRefusalReason — kept so every
 *  existing boolean call site (and its tests) is untouched. */
export function isGeocodableVenueName(name) {
  return venueNameRefusalReason(name) === null
}

/**
 * --names candidate predicate: no coordinates AND no usable address — either
 * NULL or a blank/whitespace-only string, which is exactly as unusable as no
 * address at all. There is nothing else on the row to geocode from besides
 * the venue name.
 */
export function isNameCandidate(v) {
  const hasUnusableAddress = v.address == null || String(v.address).trim() === ''
  return v.lat == null && v.lng == null && hasUnusableAddress
}

/** Strip a trailing "Township"/"Twp." so 'coventry township' ≡ 'coventry' —
 *  the same normalization scripts/lib/summit-county.js applies internally
 *  (not exported there), duplicated here as the one extra line it is. */
function normalizeCityForCompare(city) {
  return String(city ?? '').toLowerCase().trim().replace(/\s+(township|twp\.?)$/i, '')
}

/** The city a Nominatim result reports, if any: address.city, falling back
 *  through town/village/hamlet — the same fallback chain Nominatim itself
 *  uses across varying administrative levels. */
function resultCityOf(result) {
  const addr = result && result.address
  return addr ? (addr.city ?? addr.town ?? addr.village ?? addr.hamlet) : undefined
}

/**
 * --names mode gate (d): does the Nominatim result's city agree with the
 * venue's on-file city? Pass-through (true) when the venue has no city on
 * file, or when the result reports no city at all — there is nothing to
 * compare against in either case. Otherwise both sides are lowercased,
 * trimmed, and have a trailing "township"/"twp." stripped before comparing,
 * so a venue city of "Coventry Township" matches a result reporting
 * "Coventry". Pure + exported for tests.
 */
export function cityMatches(venueCity, result) {
  const wantCity = normalizeCityForCompare(venueCity)
  if (!wantCity) return true
  const gotCity = normalizeCityForCompare(resultCityOf(result))
  if (!gotCity) return true
  return gotCity === wantCity
}

/**
 * Flatten a set of event_venues rows — already narrowed to a bounded set of
 * candidate venue_ids and inner-joined to events filtered the same way the
 * rest of this file filters "upcoming published" (status='published',
 * start_at >= now) — into the set of distinct venue ids that have at least
 * one such event. Each row surviving the inner join is by construction a
 * qualifying (venue_id, event) pair, so this just dedupes venue_id.
 */
export function venueIdsWithUpcomingEvents(links) {
  const ids = new Set()
  for (const link of links || []) {
    if (link && link.venue_id) ids.add(link.venue_id)
  }
  return ids
}

/**
 * PostgREST caps `.in()` filter lists (they travel in the URL) and caps any
 * single page at 1000 rows, so the event_venues lookup has to be both chunked
 * by venue id and paginated within each chunk. 50 keeps the URL short.
 */
export const VENUE_ID_CHUNK_SIZE = 50

/** PostgREST's hard per-page cap. Fetch exactly this much, then page again. */
const EVENT_LINK_PAGE_SIZE = 1000

/** Split a list of venue ids into chunks of at most `size`. */
export function chunkIds(ids, size = VENUE_ID_CHUNK_SIZE) {
  const list = ids || []
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Apply the two candidate-narrowing steps in the ONLY correct order: filter
 * to venues with an upcoming event FIRST, then take `limit`. Slicing first
 * would make --limit N mean "look at N rows and geocode however few of them
 * qualify" — which is how the default mode used to burn 19 of 20 lookups on
 * venues it then had no reason to geocode.
 *
 * `upcomingIds === null` means "no narrowing" (--all); an empty Set still
 * means "nothing qualified" and must narrow to nothing.
 */
export function narrowAndLimit(venues, upcomingIds, limit) {
  const list = venues || []
  const narrowed = upcomingIds ? list.filter((v) => upcomingIds.has(v.id)) : list
  return limit ? narrowed.slice(0, limit) : narrowed
}

/**
 * Classify a --names run's overall outcome. Blocked-capability detection is
 * driven by the caller telling us whether it observed a policy block
 * (NominatimBlockedError — HTTP 403/429 twice in a row), NOT by scanning
 * per-venue "0 results" counts: a real, healthy run where none of tonight's
 * venues happen to be in Nominatim looks identical to "0 features every
 * time" under the old Mapbox-era heuristic, and that produced false
 * positives. Only an actual HTTP-level refusal counts as blocked now.
 *
 * 'no-candidates' — nothing qualified for --names mode at all; a quiet,
 *   unremarkable zero.
 * 'blocked'       — the run was aborted mid-loop because Nominatim answered
 *   403/429 twice in a row. Must be a loud finding, never a quiet zero.
 * 'ok'            — normal run, including one where every query came back
 *   200 with zero results (that's per-venue "no match", not blocked).
 */
export function summarizeNamesRun(candidates, blocked) {
  const n = candidates ? candidates.length : 0
  if (n === 0) return 'no-candidates'
  if (blocked) return 'blocked'
  return 'ok'
}

/**
 * Log one --names decision with every field the run report requires:
 * both the venue's own on-file name AND the variant actually queried
 * (they can differ once buildNameVariants is walking a ladder), plus which
 * rung of that ladder it was.
 */
function logNameDecision(v, result, similarity, decision, reason, variant, rungIndex) {
  const simStr = typeof similarity === 'number' ? similarity.toFixed(2) : 'n/a'
  const coords = result ? `${parseFloat(result.lat).toFixed(6)}, ${parseFloat(result.lon).toFixed(6)}` : 'n/a'
  const tag = decision === 'write' || decision === 'would-write' ? '✓' : decision === 'skip' ? '⚠' : '✖'
  const variantStr = variant != null
    ? ` variant="${variant}"${typeof rungIndex === 'number' ? ` rung=${rungIndex}` : ''}`
    : ''
  console.log(`  ${tag} id=${v.id} name="${v.name}"${variantStr} similarity=${simStr} coords=(${coords}) decision=${decision}${reason ? ` reason=${reason}` : ''}`)
}

/**
 * Build the free-form `q` query string for a --names lookup: venue name,
 * city (if on file), and state, comma-joined, in that order. Nominatim's own
 * free-text parser resolves the rest. Pure + exported for tests.
 */
export function buildNameQuery(name, city) {
  return [name, city, 'OH'].filter(Boolean).join(', ')
}

/**
 * Geocode one venue-name VARIANT (no street address), free-form and bounded
 * to Summit County via Nominatim's viewbox+bounded=1 (a query hint/limit,
 * NOT the acceptance gate — see NAMES_BBOX above). limit=3, not 1, so the
 * caller can scan past a wrong top hit without an extra request — Nominatim
 * charges the same rate-limited request either way. Returns the raw results
 * array (possibly empty), never null, so callers can iterate unconditionally.
 */
async function geocodeByName(variant, city) {
  // Nominatim viewbox corner order is x1,y1,x2,y2 — conventionally the
  // top-left then bottom-right corner, i.e. west,north,east,south.
  const viewbox = `${NAMES_BBOX.west},${NAMES_BBOX.north},${NAMES_BBOX.east},${NAMES_BBOX.south}`
  const params = new URLSearchParams({
    q: buildNameQuery(variant, city),
    format: 'json',
    namedetails: '1',
    addressdetails: '1',
    countrycodes: 'us',
    limit: '3',
    bounded: '1',
    viewbox,
    email: CONTACT_EMAIL,
  })
  const url = `https://nominatim.openstreetmap.org/search?${params}`
  const json = await nominatimFetch(url)
  return Array.isArray(json) ? json : []
}

/**
 * --names mode: geocode venues that have no lat, no lng, AND no usable
 * address at all, restricted to ones with >=1 upcoming published event (a
 * venue nobody is about to visit isn't worth the API call or the
 * false-positive risk). DRY RUN BY DEFAULT — pass --write to update rows.
 */
async function runNamesMode() {
  // The real Summit County polygon check (classifySummitLocation ->
  // pointInSummitCounty) requires the boundary GeoJSON preloaded first, or
  // it throws. Load it once, up front, rather than per-venue.
  await preloadSummitCountyBoundary()

  // Instant-in-time cutoff for "upcoming" — not a calendar-day boundary, so
  // this is not the toISOString() "today" footgun; it mirrors the .gte
  // pattern other scrapers already use to bound future events.
  const nowIso = new Date().toISOString()

  // 1. Baseline candidates: no coordinates. Paginated the same way
  // fetchVenueIdsWithUpcomingEvents pages event_venues below — PostgREST
  // silently truncates ANY plain select() at 1000 rows with no error and no
  // flag, and a venues-missing-lat/lng scan is exactly the kind of query
  // that can quietly blow past that cap. `.order('id')` is added as a
  // tiebreaker after `.order('name')` so ties can't be skipped or repeated
  // across pages. Address usability (NULL vs blank string) is checked in
  // isNameCandidate below rather than at the DB level, since a blank-string
  // address is exactly as unusable as no address at all and
  // `.is('address', null)` wouldn't catch it.
  const rawVenues = []
  for (let from = 0; ; from += EVENT_LINK_PAGE_SIZE) {
    const { data: page, error: vErr } = await supabaseAdmin
      .from('venues')
      .select('id, name, lat, lng, address, city')
      .is('lat', null)
      .is('lng', null)
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + EVENT_LINK_PAGE_SIZE - 1)
    if (vErr) throw new Error(`loading venues: ${vErr.message}`)
    const rows = page || []
    rawVenues.push(...rows)
    if (rows.length < EVENT_LINK_PAGE_SIZE) break // short page = last page
  }
  const baseline = rawVenues.filter(isNameCandidate)

  // 1b. Refuse junk venue names BEFORE the upcoming-event narrowing below —
  // a name that's really an email/URL/street-address/state-name/prose blob
  // was never going to produce a usable Nominatim hit, so refusing it here
  // costs zero API calls (versus discovering the same thing after a wasted,
  // rate-limited lookup). Each refusal is stamped with the specific rule
  // that caught it (venueNameRefusalReason), not a flat "junk name" label.
  const refused = []
  const geocodableBaseline = []
  for (const v of baseline) {
    const reason = venueNameRefusalReason(v.name)
    if (reason === null) {
      geocodableBaseline.push(v)
    } else {
      refused.push({ v, why: reason })
    }
  }

  // 2. Narrow to venues with >=1 upcoming published event. Inverted from a
  // full unpaginated events scan — PostgREST caps a plain select() at 1000
  // rows with no warning, and the events table runs ~8,000 rows, so that
  // approach silently dropped eligible candidates. Instead, query
  // event_venues bounded by the small baseline candidate list (~40-90 ids,
  // refused names included) and inner-join to events filtered the same way
  // (status='published', start_at >= now): the result size is bounded by
  // the baseline, not by the whole events table. Refused names are folded
  // into baselineIds (not just geocodableBaseline) so the refusal report
  // below can also be scoped to venues actually in play tonight, instead of
  // printing every junk-named address-less venue in the whole table.
  const baselineIds = baseline.map((v) => v.id)
  let upcomingVenueIds = new Set()
  if (baselineIds.length) {
    const { data: links, error: eErr } = await supabaseAdmin
      .from('event_venues')
      .select('venue_id, events!inner(id, status, start_at)')
      .in('venue_id', baselineIds)
      .eq('events.status', 'published')
      .gte('events.start_at', nowIso)
    if (eErr) throw new Error(`loading events: ${eErr.message}`)
    upcomingVenueIds = venueIdsWithUpcomingEvents(links)
  }

  let candidates = geocodableBaseline.filter((v) => upcomingVenueIds.has(v.id))
  if (LIMIT) candidates = candidates.slice(0, LIMIT)

  // Refused venues actually in scope tonight (has an upcoming published
  // event), for reporting — a refused venue with no upcoming event was
  // never going to be geocoded regardless, so it doesn't belong in the log.
  const refusedInScope = refused.filter((r) => upcomingVenueIds.has(r.v.id))

  console.log(`📍  --names mode ${NAMES_WRITE ? '(WRITE)' : '(DRY RUN — pass --write to update rows)'}`)
  console.log(`    candidate baseline (no lat/lng, no usable address): ${baseline.length}`)
  console.log(`    refused (junk venue name, zero API calls): ${refusedInScope.length}`)
  console.log(`    planned after (also has >=1 upcoming published event, pre-gate): ${candidates.length}\n`)

  let updated = 0
  const skipped = []
  const failed = []
  let blocked = false

  for (const v of candidates) {
    try {
      // Walk buildNameVariants(v.name) — verbatim name first, then cleaned/
      // derived rungs — stopping at the first variant whose result clears
      // every gate (class, polygon, city, similarity). A variant whose
      // results ALL fail a gate does not stop the walk; the next variant is
      // tried. Across every variant/result attempted, the single highest-
      // similarity REJECTED hit is kept so a total miss can still report the
      // closest thing found and why it didn't clear.
      const variants = buildNameVariants(v.name)
      let matched = null // { result, similarity, lat, lng, variant, rungIndex }
      let bestRejected = null // { result, similarity, variant, rungIndex, why }

      for (let rungIndex = 0; rungIndex < variants.length && !matched; rungIndex++) {
        const variant = variants[rungIndex]
        const results = await geocodeByName(variant, v.city)

        for (const result of results) {
          // (a) a result exists with finite coordinates.
          const lat = parseFloat(result.lat)
          const lng = parseFloat(result.lon)
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue

          // Similarity is scored against the variant ACTUALLY QUERIED, not
          // v.name — a derived rung ("Rialto Theatre") should be judged on
          // its own merits, not diluted by locality words the venue's full
          // on-file name happened to carry ("... in Kenmore").
          const similarity = tokenOverlapSimilarity(variant, resultDisplayName(result))
          const considerRejected = (why) => {
            if (!bestRejected || similarity > bestRejected.similarity) {
              bestRejected = { result, similarity, variant, rungIndex, why }
            }
          }

          // (b) not a junk class/type — highway, boundary, bare place=house,
          // or (extended) a place=<city/town/village/...> administrative
          // centroid.
          if (isJunkClassType(result.class, result.type)) {
            considerRejected(`junk class/type (${result.class}/${result.type})`)
            continue
          }

          // (c) the real Summit County polygon, not just the NAMES_BBOX
          // query bound — a hit can sit inside the viewbox rectangle yet
          // outside the actual county line.
          if (classifySummitLocation({ lat, lng }) !== 'in') {
            considerRejected(`out of Summit County (${lat.toFixed(4)}, ${lng.toFixed(4)})`)
            continue
          }

          // (d) the result's reported city (if any) must agree with the
          // venue's city (if any) — catches a same-named venue in the wrong
          // town that still happens to fall inside the county polygon (e.g.
          // near a border).
          if (!cityMatches(v.city, result)) {
            const gotCity = resultCityOf(result) || 'none'
            considerRejected(`city mismatch (venue=${v.city}, result=${gotCity})`)
            continue
          }

          // (e) name-similarity gate, scored against the queried variant.
          if (similarity < MIN_SIMILARITY_NAMES) {
            considerRejected(`low similarity ${similarity.toFixed(2)}`)
            continue
          }

          // All gates cleared — stop scanning this variant's results and
          // stop the outer variant walk (STOPPING RULE).
          matched = { result, similarity, lat, lng, variant, rungIndex }
          break
        }
      }

      if (!matched) {
        if (bestRejected) {
          const { result, similarity, variant, rungIndex, why } = bestRejected
          logNameDecision(v, result, similarity, 'skip', why, variant, rungIndex)
          skipped.push({ v, why })
        } else {
          logNameDecision(v, null, null, 'fail', 'no result')
          failed.push({ v, why: 'no result' })
        }
        continue
      }

      if (NAMES_WRITE) {
        const { error: upErr } = await supabaseAdmin
          .from('venues').update({ lat: matched.lat, lng: matched.lng }).eq('id', v.id)
        if (upErr) {
          logNameDecision(v, matched.result, matched.similarity, 'fail', upErr.message, matched.variant, matched.rungIndex)
          failed.push({ v, why: upErr.message })
          continue
        }
      }
      updated++
      logNameDecision(
        v, matched.result, matched.similarity,
        NAMES_WRITE ? 'write' : 'would-write', null, matched.variant, matched.rungIndex
      )
    } catch (err) {
      if (err instanceof NominatimBlockedError) {
        blocked = true
        console.error(`\n🚨 BLOCKED: Nominatim policy block — ${err.message}`)
        break
      }
      logNameDecision(v, null, null, 'fail', err.message)
      failed.push({ v, why: err.message })
    }
  }

  const runStatus = summarizeNamesRun(candidates, blocked)
  if (runStatus === 'no-candidates') {
    console.log(`\n0 candidates — nothing qualified for --names mode.`)
  } else if (runStatus === 'blocked') {
    console.log(`\n🚨 BLOCKED: Nominatim policy block`)
    console.log(`   Aborted mid-run after HTTP 403/429 twice in a row (after retry).`)
    console.log(`   This is a capability failure, not "no venues matched" — do not read it as a clean run.`)
  }

  console.log(`\n${NAMES_WRITE ? 'Updated' : 'Would update'}: ${updated}`)
  if (refusedInScope.length) {
    console.log(`\n🚫 Refused before any API call (${refusedInScope.length}):`)
    for (const r of refusedInScope) console.log(`   - ${r.v.id}  "${r.v.name}" — ${r.why}`)
  }
  if (skipped.length) {
    console.log(`\n⚠️  Skipped for manual review (${skipped.length}):`)
    for (const s of skipped) console.log(`   - ${s.v.id}  "${s.v.name}" — ${s.why}`)
  }
  if (failed.length) {
    console.log(`\n✖  Failed (${failed.length}):`)
    for (const f of failed) console.log(`   - ${f.v.id}  "${f.v.name}" — ${f.why}`)
  }

  if (runStatus === 'blocked') {
    throw new Error('degraded run: Nominatim policy block — aborted before completing all candidates')
  }
}

/**
 * The set of venue ids (out of `venueIds`) with >=1 upcoming published event.
 *
 * Chunked AND paginated, both mandatory. One venue already carries 247
 * upcoming link rows, and PostgREST silently truncates a page at 1000 with no
 * error and no flag — an unchunked/unpaginated join would quietly drop
 * venues, which is the same class of bug this narrowing exists to fix. The
 * (event_id, venue_id) primary key gives the ordering below a total order, so
 * range-based paging can't skip or repeat a row.
 *
 * A query error THROWS. Never fall back to the unfiltered set: silently
 * geocoding everything is exactly the failure mode being removed.
 */
async function fetchVenueIdsWithUpcomingEvents(venueIds, nowIso) {
  const upcoming = new Set()
  for (const chunk of chunkIds(venueIds)) {
    for (let from = 0; ; from += EVENT_LINK_PAGE_SIZE) {
      const { data: links, error } = await supabaseAdmin
        .from('event_venues')
        .select('venue_id, events!inner(id, status, start_at)')
        .in('venue_id', chunk)
        .eq('events.status', 'published')
        .gte('events.start_at', nowIso)
        .order('venue_id', { ascending: true })
        .order('event_id', { ascending: true })
        .range(from, from + EVENT_LINK_PAGE_SIZE - 1)
      if (error) throw new Error(`loading events: ${error.message}`)
      const page = links || []
      for (const id of venueIdsWithUpcomingEvents(page)) upcoming.add(id)
      if (page.length < EVENT_LINK_PAGE_SIZE) break // short page = last page
    }
  }
  return upcoming
}

async function main() {
  if (NAMES_MODE) return runNamesMode()

  let query = supabaseAdmin
    .from('venues')
    .select('id, name, address, city, state, zip, lat, lng')
    .not('address', 'is', null)
    .order('name', { ascending: true })
  if (!RECHECK) query = query.or('lat.is.null,lng.is.null')

  const { data: rawVenues, error } = await query
  if (error) throw new Error(`loading venues: ${error.message}`)
  const baseline = rawVenues || []

  // Instant-in-time cutoff for "upcoming" — not a calendar-day boundary, so
  // this is not the toISOString() "today" footgun; it mirrors the .gte
  // pattern runNamesMode and the scrapers already use to bound future events.
  const nowIso = new Date().toISOString()
  const upcomingVenueIds = GEO_ALL
    ? null
    : await fetchVenueIdsWithUpcomingEvents(baseline.map((v) => v.id), nowIso)

  // --limit is applied LAST, after narrowing (see narrowAndLimit).
  const narrowed = narrowAndLimit(baseline, upcomingVenueIds, null)
  const venues = narrowAndLimit(baseline, upcomingVenueIds, LIMIT)

  const baseLabel = RECHECK ? 'addressed venue(s)' : 'addressed venue(s) missing coordinates'
  const reason = GEO_ALL
    ? ' (--all: no upcoming-event filter)'
    : ` with an upcoming published event (${baseline.length - narrowed.length} skipped: no upcoming events)`
  const limitNote = venues.length < narrowed.length ? ` — capped at ${venues.length} by --limit` : ''
  console.log(`📍  ${baseline.length} ${baseLabel} → ${narrowed.length}${reason}${limitNote}${DRY_RUN ? ' (dry run)' : ''}…\n`)

  let updated = 0
  const skipped = []
  const failed = []
  let blocked = false

  for (const v of venues) {
    const address = fullAddress(v)
    if (!address) { skipped.push({ v, why: 'no address' }); continue }

    try {
      const result = await geocodeAddress(v)

      if (!result) { failed.push({ v, why: 'no result' }); continue }
      if (!passesAddressGate(v, result)) {
        skipped.push({ v, why: addressGateFailureReason(v, result) }); continue
      }

      const lat = parseFloat(result.lat)
      const lng = parseFloat(result.lon)

      if (!DRY_RUN) {
        const { error: upErr } = await supabaseAdmin
          .from('venues').update({ lat, lng }).eq('id', v.id)
        if (upErr) { failed.push({ v, why: upErr.message }); continue }
      }
      updated++
      console.log(`  ✓ ${v.name} → ${lat.toFixed(6)}, ${lng.toFixed(6)}`)
    } catch (err) {
      if (err instanceof NominatimBlockedError) {
        blocked = true
        console.error(`\n🚨 BLOCKED: Nominatim policy block — ${err.message}`)
        break
      }
      failed.push({ v, why: err.message })
    }
  }

  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'}: ${updated}`)
  if (skipped.length) {
    console.log(`\n⚠️  Skipped for manual review (${skipped.length}):`)
    for (const s of skipped) console.log(`   - ${s.v.name} [${fullAddress(s.v)}] — ${s.why}`)
  }
  if (failed.length) {
    console.log(`\n✖  Failed (${failed.length}):`)
    for (const f of failed) console.log(`   - ${f.v.name} — ${f.why}`)
  }

  if (blocked) {
    console.log(`\n🚨 BLOCKED: Nominatim policy block — aborted before completing all venues.`)
    throw new Error('degraded run: Nominatim policy block — aborted before completing all venues')
  }
}

// Import-safe: only run when invoked directly (never on import, e.g. in tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`✖ geocode-venues failed: ${err.message}`)
    process.exit(1)
  })
}
