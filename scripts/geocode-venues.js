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
 *   - --names mode: token-overlap similarity between the venue name and the
 *     result name clears MIN_SIMILARITY_NAMES, the result isn't a junk
 *     class/type (highway, a bare place=house, a boundary), and the result
 *     falls inside the Summit County bbox
 * Anything failing a gate is listed for manual review, not written.
 *
 * Env:
 *   VITE_SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — service role (bypasses RLS to update venues)
 *
 * Flags:
 *   --dry-run     geocode + report, but write nothing
 *   --limit N     only process the first N candidate venues
 *   --recheck     also re-geocode venues that already have coordinates
 *
 *   --names       ALTERNATE MODE: geocode by venue NAME instead of street
 *                 address, for venues that have NO lat, NO lng, AND NO
 *                 address at all (nothing else to geocode from), and that
 *                 have at least one upcoming published event. Queries
 *                 Nominatim free-form, bounded to a hard Summit County
 *                 bbox, and gates on name-similarity + a junk-class filter
 *                 (see above). NOTE: this mode is DRY RUN BY DEFAULT — the
 *                 opposite of the default mode above — because a bare-name
 *                 lookup is much more likely to hit a same-named place in
 *                 the wrong city. Pass --write to actually update rows.
 *   --write       (only meaningful with --names) perform the writes.
 *                 If --dry-run is also passed, --dry-run wins (no writes) —
 *                 the explicit safety flag beats the explicit danger flag.
 *
 * Usage:  node scripts/geocode-venues.js [--dry-run] [--limit 50]
 *         node scripts/geocode-venues.js --names [--write] [--limit 50]
 */
import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'

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
const NAMES_BBOX = { west: -81.69, south: 40.90, east: -81.36, north: 41.35 }
const MIN_SIMILARITY_NAMES = 0.8
const JUNK_CLASSES = new Set(['highway', 'boundary'])

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const RECHECK = args.includes('--recheck')
const NAMES_MODE = args.includes('--names')
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
async function nominatimFetch(url, attempt = 1) {
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
async function geocodeAddress(v) {
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

/** Lowercase, strip punctuation, split into non-empty whitespace tokens. */
export function normalizeNameTokens(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
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
 * --names mode junk filter: roads, administrative boundaries, and bare
 * place=house results are never a defensible venue match regardless of how
 * similar the name looks (a road can share a name with a business on it).
 */
export function isJunkClassType(cls, type) {
  if (!cls) return false
  if (JUNK_CLASSES.has(cls)) return true
  if (cls === 'place' && type === 'house') return true
  return false
}

/**
 * Combined --names quality gate for one Nominatim hit: not a junk class/type,
 * and its name clears MIN_SIMILARITY_NAMES token-overlap similarity against
 * the venue name. Does NOT check the Summit County bbox — that's a separate
 * post-hoc reject applied by the caller (see inSummitBbox), since it depends
 * on the hit's coordinates rather than its name/class fields.
 */
export function passesNamesGate(venueName, result) {
  if (!result) return false
  if (isJunkClassType(result.class, result.type)) return false
  const candidateName = resultDisplayName(result)
  if (!candidateName) return false
  return tokenOverlapSimilarity(venueName, candidateName) >= MIN_SIMILARITY_NAMES
}

/**
 * --names candidate predicate: no coordinates AND no address — there is
 * nothing else on the row to geocode from besides the venue name.
 */
export function isNameCandidate(v) {
  return v.lat == null && v.lng == null && v.address == null
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

/** Log one --names decision with every field the run report requires. */
function logNameDecision(v, result, similarity, decision, reason) {
  const simStr = typeof similarity === 'number' ? similarity.toFixed(2) : 'n/a'
  const coords = result ? `${parseFloat(result.lat).toFixed(6)}, ${parseFloat(result.lon).toFixed(6)}` : 'n/a'
  const tag = decision === 'write' || decision === 'would-write' ? '✓' : decision === 'skip' ? '⚠' : '✖'
  console.log(`  ${tag} id=${v.id} query="${v.name}" similarity=${simStr} coords=(${coords}) decision=${decision}${reason ? ` reason=${reason}` : ''}`)
}

/**
 * Geocode one venue by NAME (no address), free-form and bounded to Summit
 * County via Nominatim's viewbox+bounded=1 (a hard filter, not just a bias).
 * Returns the raw top result object, or null if Nominatim returned nothing.
 */
async function geocodeByName(name) {
  // Nominatim viewbox corner order is x1,y1,x2,y2 — conventionally the
  // top-left then bottom-right corner, i.e. west,north,east,south.
  const viewbox = `${NAMES_BBOX.west},${NAMES_BBOX.north},${NAMES_BBOX.east},${NAMES_BBOX.south}`
  const params = new URLSearchParams({
    q: name,
    format: 'json',
    namedetails: '1',
    countrycodes: 'us',
    limit: '1',
    bounded: '1',
    viewbox,
    email: CONTACT_EMAIL,
  })
  const url = `https://nominatim.openstreetmap.org/search?${params}`
  const json = await nominatimFetch(url)
  return Array.isArray(json) && json.length ? json[0] : null
}

/**
 * --names mode: geocode venues that have no lat, no lng, AND no address at
 * all, restricted to ones with >=1 upcoming published event (a venue nobody
 * is about to visit isn't worth the API call or the false-positive risk).
 * DRY RUN BY DEFAULT — pass --write to update rows.
 */
async function runNamesMode() {
  // Instant-in-time cutoff for "upcoming" — not a calendar-day boundary, so
  // this is not the toISOString() "today" footgun; it mirrors the .gte
  // pattern other scrapers already use to bound future events.
  const nowIso = new Date().toISOString()

  // 1. Baseline candidates: no coordinates and no address whatsoever.
  const { data: rawVenues, error: vErr } = await supabaseAdmin
    .from('venues')
    .select('id, name, lat, lng, address')
    .is('lat', null)
    .is('lng', null)
    .is('address', null)
    .order('name', { ascending: true })
  if (vErr) throw new Error(`loading venues: ${vErr.message}`)
  const baseline = (rawVenues || []).filter(isNameCandidate)

  // 2. Narrow to venues with >=1 upcoming published event. Inverted from a
  // full unpaginated events scan — PostgREST caps a plain select() at 1000
  // rows with no warning, and the events table runs ~8,000 rows, so that
  // approach silently dropped eligible candidates. Instead, query
  // event_venues bounded by the small baseline candidate list (~40-90 ids)
  // and inner-join to events filtered the same way (status='published',
  // start_at >= now): the result size is bounded by the baseline, not by
  // the whole events table.
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

  let candidates = baseline.filter((v) => upcomingVenueIds.has(v.id))
  if (LIMIT) candidates = candidates.slice(0, LIMIT)

  console.log(`📍  --names mode ${NAMES_WRITE ? '(WRITE)' : '(DRY RUN — pass --write to update rows)'}`)
  console.log(`    candidate baseline (no lat/lng/address): ${baseline.length}`)
  console.log(`    planned after (also has >=1 upcoming published event, pre-gate): ${candidates.length}\n`)

  let updated = 0
  const skipped = []
  const failed = []
  let blocked = false

  for (const v of candidates) {
    try {
      const result = await geocodeByName(v.name)

      if (!result) {
        logNameDecision(v, null, null, 'fail', 'no result')
        failed.push({ v, why: 'no result' })
        continue
      }

      const lat = parseFloat(result.lat)
      const lng = parseFloat(result.lon)
      const similarity = tokenOverlapSimilarity(v.name, resultDisplayName(result))

      if (!inSummitBbox(lng, lat)) {
        const why = `out of Summit County (${lat.toFixed(4)}, ${lng.toFixed(4)})`
        logNameDecision(v, result, similarity, 'skip', why)
        skipped.push({ v, why })
        continue
      }

      if (!passesNamesGate(v.name, result)) {
        const why = isJunkClassType(result.class, result.type)
          ? `junk class/type (${result.class}/${result.type})`
          : `low similarity ${similarity.toFixed(2)}`
        logNameDecision(v, result, similarity, 'skip', why)
        skipped.push({ v, why })
        continue
      }

      if (NAMES_WRITE) {
        const { error: upErr } = await supabaseAdmin
          .from('venues').update({ lat, lng }).eq('id', v.id)
        if (upErr) {
          logNameDecision(v, result, similarity, 'fail', upErr.message)
          failed.push({ v, why: upErr.message })
          continue
        }
      }
      updated++
      logNameDecision(v, result, similarity, NAMES_WRITE ? 'write' : 'would-write')
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

async function main() {
  if (NAMES_MODE) return runNamesMode()

  let query = supabaseAdmin
    .from('venues')
    .select('id, name, address, city, state, zip, lat, lng')
    .not('address', 'is', null)
    .order('name', { ascending: true })
  if (!RECHECK) query = query.or('lat.is.null,lng.is.null')
  if (LIMIT) query = query.limit(LIMIT)

  const { data: venues, error } = await query
  if (error) throw new Error(`loading venues: ${error.message}`)

  console.log(`📍  ${venues.length} venue(s) to geocode${DRY_RUN ? ' (dry run)' : ''}…\n`)

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
