/**
 * scrape-akron-library.js
 *
 * Fetches upcoming events from the Akron-Summit County Public Library
 * via their internal Communico/Libnet event API — no auth required.
 *
 * Usage:
 *   node scripts/scrape-akron-library.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  htmlToText,
  fetchSchemaDescription,
  enrichWithImageDimensions,
  upsertEventSafe,
  setEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  looksLikeStreetAddress,
  venueNameKey,
  easternToIso,
  easternTodayIso,
} from './lib/normalize.js'

const API_BASE   = 'https://services.akronlibrary.org/eeventcaldata'
const DAYS_AHEAD = 180  // fetch 6 months at a time

// ── Known branch library addresses ───────────────────────────────────────
// Used to pre-populate venue records. Branches not listed here get name-only records.
//
// COORDINATES ARE GEOCODED, NOT EYEBALLED.
// Every lat/lng below was obtained by geocoding that branch's own street
// address (as published on akronlibrary.org/locations) against Nominatim and
// taking a building-precision result. Street-centerline fallbacks and
// no-results were rejected rather than rounded into place.
//
// Why this matters: the previous hand-estimated table put six branches on the
// WRONG neighborhood hub, by 1.1 km to 9.0 km. Highland Square resolved to
// west-akron, Kenmore to summit-lake, Ellet to goodyear-heights, Northwest
// Akron to wallhaven, Odom Boulevard to summit-lake, and Maple Valley to
// ellet. Each of those branches is a short walk from the neighborhood it is
// named after, and each was filed under a different one. Two of them carried
// well over a hundred upcoming events onto the wrong hub.
//
// This also corrects the record on a 2026-06-14 note describing a "GeoJSON
// defect: the resolver places the entire Kenmore Blvd corridor in summit-lake
// instead of kenmore", which prescribed setting neighborhood_slug by hand as a
// workaround. That diagnosis was wrong. Multiple Kenmore Blvd addresses
// geocode and resolve to kenmore correctly; the polygon is fine. What was
// wrong was this table's Kenmore coordinate, 2 km off, and someone patched the
// slug instead of the coordinate.
//
// THE RULE: neighborhood_slug is DERIVED. scripts/lib/neighborhood-resolver.js
// computes it from the coordinate, and ensureVenue calls into it. Never hand
// assign a slug to paper over a coordinate you have not checked. If a venue is
// landing on the wrong hub, the coordinate is the bug; fix that.
//
// Seven of the addresses here were also wrong (Fairlawn-Bath, Maple Valley,
// Nordonia Hills, Portage Lakes, Richfield, Springfield-Lakemore and Tallmadge
// all named a street the library does not sit on), which is what made the bad
// coordinates so hard to spot: re-geocoding the stored address reproduced the
// error. Addresses below are taken from the library's own branch pages.
export const BRANCH_INFO = {
  'Main Library':                     { address: '60 S High St',            zip: '44326', lat: 41.083244, lng: -81.516898, parking_type: 'garage',  parking_notes: 'Parking garage adjacent to building on S High St.' },
  'Highland Square Branch Library':   { address: '807 W Market St',         zip: '44303', lat: 41.096814, lng: -81.543184, parking_type: 'lot',     parking_notes: 'Free surface lot behind building.' },
  'Kenmore Branch Library':           { address: '969 Kenmore Blvd',        zip: '44314', lat: 41.043914, lng: -81.558088, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Firestone Park Branch Library':    { address: '1486 Aster Ave',          zip: '44301', lat: 41.042605, lng: -81.514814, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Ellet Branch Library':             { address: '2470 E Market St',        zip: '44312', lat: 41.055068, lng: -81.441012, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'North Hill Branch Library':        { address: '183 E Cuyahoga Falls Ave', zip: '44310', lat: 41.108174, lng: -81.509635, parking_type: 'lot',    parking_notes: 'Free on-site parking lot.' },
  'Green Branch Library':             { address: '4046 Massillon Rd', city: 'Green',       zip: '44232', lat: 40.951168, lng: -81.466773, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Goodyear Branch Library':          { address: '60 Goodyear Blvd',        zip: '44305', lat: 41.066637, lng: -81.481270, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Northwest Akron Branch Library':   { address: '1720 Shatto Ave',         zip: '44313', lat: 41.115917, lng: -81.574512, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  // Address corrected from '3490 W Market St': the branch is on Smith Rd.
  'Fairlawn-Bath Branch Library':     { address: '3101 Smith Rd', city: 'Fairlawn',        zip: '44333', lat: 41.136374, lng: -81.621903, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  // Address corrected from '4261 Shriver Rd': the branch is on Manchester Rd.
  'Portage Lakes Branch Library':     { address: '4261 Manchester Rd',      zip: '44319', lat: 40.987139, lng: -81.558632, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Mogadore Branch Library':          { address: '144 S Cleveland Ave', city: 'Mogadore',      zip: '44260', lat: 41.047242, lng: -81.393902, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  // Address corrected from '1187 Mogadore Rd' (44306): the branch is at 1187
  // Copley Rd in West Akron, 9 km away. The old coordinate resolved to ellet.
  'Maple Valley Branch Library':      { address: '1187 Copley Rd',          zip: '44320', lat: 41.083586, lng: -81.565055, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  // COORDINATE UNVERIFIED. Address corrected from '3761 S Park Dr', but neither
  // that address, '3761 S Grant St', nor the branch name returns any result from
  // Nominatim (OpenStreetMap has no record of this building). The lat/lng below
  // is the original hand-estimated value, left in place deliberately rather than
  // replaced with a guess. Re-verify against another geocoder before trusting it.
  'Richfield Branch Library':         { address: '3761 S Grant St', city: 'Richfield',          zip: '44286', lat: 41.2304, lng: -81.6412, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  // Address corrected from '70 Olde Eight Rd': the branch is at 9458 Olde Eight Rd.
  'Nordonia Hills Branch Library':    { address: '9458 Olde Eight Rd', city: 'Northfield',        zip: '44067', lat: 41.317428, lng: -81.539517, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Norton Branch Library':            { address: '3930 S Cleveland-Massillon Rd', city: 'Norton', zip: '44203', lat: 41.031752, lng: -81.639153, parking_type: 'lot', parking_notes: 'Free on-site parking lot.' },
  // Address corrected from '1100 Canton Rd': the branch is at 1500 Canton Rd
  // (Lakemore Plaza). City stays Lakemore so it hubs there, per the branch-city test.
  'Springfield-Lakemore Branch Library': { address: '1500 Canton Rd', city: 'Lakemore',       zip: '44312', lat: 41.024972, lng: -81.425697, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  // Address corrected from '90 North Ave': the branch is at 90 Community Rd.
  'Tallmadge Branch Library':         { address: '90 Community Rd', city: 'Tallmadge',            zip: '44278', lat: 41.103898, lng: -81.433631, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Odom Boulevard Branch Library':    { address: '600 Vernon Odom Blvd',    zip: '44307', lat: 41.071137, lng: -81.544269, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
}

/**
 * Normalize a URL from the library API.
 * The Communico/Libnet API occasionally returns paths with duplicate slashes,
 * e.g. "https://akronlibrary.libnet.info//event/123". Parse and reconstruct
 * to collapse them before storing.
 */
function sanitizeUrl(url) {
  if (!url) return null
  try {
    const u = new URL(url)
    u.pathname = u.pathname.replace(/\/+/g, '/')
    return u.toString()
  } catch {
    return url  // not a valid URL — store as-is and let the UI handle it
  }
}

// ── Category mapping ──────────────────────────────────────────────────────

// The library publishes a CONTROLLED tag vocabulary (Communico event types —
// "storytime and play time", "art & crafts", "job skills & career", …), so
// exact phrases are mapped first and generic keywords are fallbacks. Insertion
// order matters: first matching pattern wins. Values are v2 slugs.
//
// Deliberately unmapped (they are audiences/purposes, not content — facets and
// inference handle them): family/kids/teen/senior, volunteer/fundrais (the
// fundraiser facet regex catches these), games & gaming / bingo (honestly
// 'other'). See docs/tagging-audit-2026-06.md (library section).
const LIBRARY_CATEGORY_MAP = {
  // Controlled tag vocabulary, most specific first
  'storytime and play time':      'learning',
  'art & crafts':                 'visual-art',
  'arts & crafts':                'visual-art',
  'maker & diy':                  'visual-art',
  'books & writing':              'learning',
  'summer reading':               'learning',
  'job skills & career':          'learning',
  'computers & technology':       'learning',
  'stem & steam':                 'learning',
  'exercise & wellness':          'fitness',
  'nature & outdoors':            'outdoors',
  'food & cooking':               'food',
  'business & personal finance':  'learning',
  'law & legal':                  'learning',
  'community discussion':         'civic',
  'live performance':             'music',
  'book sale':                    'market',
  // Generic keyword fallbacks (tag fragments + title words)
  'storytime':            'learning',
  'story time':           'learning',
  'art':                  'visual-art',
  'music':                'music',
  'concert':              'music',
  'performance':          'music',
  'film':                 'film',
  'movie':                'film',
  'movies':               'film',
  'book':                 'learning',
  'education':            'learning',
  'computer':             'learning',
  'technology':           'learning',
  'stem':                 'learning',
  'science':              'learning',
  'history':              'learning',
  'financial':            'learning',
  'job':                  'learning',
  'career':               'learning',
  'scam':                 'learning',
  'fraud':                'learning',
  'safety':               'learning',
  'digital literacy':     'learning',
  'internet':             'learning',
  'cybersecurity':        'learning',
  'orientation':          'learning',
  'information session':  'learning',
  'workshop':             'learning',
  'yoga':                 'fitness',
  'tai chi':              'fitness',
  'fitness':              'fitness',
  'food':                 'food',
  'cooking':              'food',
}

// Pre-compile keyword patterns with word boundaries so that substring
// matches like "smart" → "art" or "start" → "art" are impossible.
// Multi-word phrases (e.g. "arts & crafts") are anchored as-is — the
// ampersand is not a word char so \b sits naturally around it.
const _LIBRARY_CATEGORY_PATTERNS = Object.entries(LIBRARY_CATEGORY_MAP).map(
  ([keyword, cat]) => [new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), cat]
)

function parseCategory(tagStr = '', title = '') {
  const combined = `${tagStr} ${title}`
  for (const [pattern, cat] of _LIBRARY_CATEGORY_PATTERNS) {
    if (pattern.test(combined)) return cat
  }
  // No hint — text inference decides; genuinely unclassifiable library
  // programs (bingo, Pokémon club) are honestly 'other'.
  return null
}

/**
 * The library's Ages field is an authoritative audience signal — far better
 * than title regexes. Family = explicitly kid-programmed (baby through
 * grade-school, or "family"); teen-only and adult programs are not.
 * Returns true or undefined (never false) so inference can still flag
 * family events the Ages field misses.
 */
export function parseIsFamily(ageStr = '', tagStr = '') {
  const t = `${ageStr} ${tagStr}`.toLowerCase()
  // Reads the library's structured Ages field, so teen/youth are safe here
  // (no free-text "supporting local youth" noise) — unlike inference, which
  // title-scopes those words. Keeps the big block of teen/tween/youth library
  // programming flagged for the audience filter.
  return /\b(bab(y|ies)|toddlers?|preschool|kids?|child(ren)?|family|families|grades? [k0-9]|tweens?|teens?|youth)\b/.test(t) || undefined
}

export function parseTags(tagStr = '', ageStr = '') {
  const tags = []
  if (tagStr) tags.push(...tagStr.toLowerCase().split(',').map(t => t.trim()).filter(Boolean))
  if (ageStr) {
    const ages = ageStr.toLowerCase().split(',').map(a => a.trim()).filter(Boolean)
    for (const age of ages) {
      if (age.includes('baby') || age.includes('toddler') || age.includes('preschool')) tags.push('kids')
      if (age.includes('teen') || age.includes('tween')) tags.push('teens')
      if (age.includes('adult')) tags.push('adults')
      if (age.includes('senior') || age.includes('older')) tags.push('seniors')
    }
  }
  tags.push('free', 'library')
  return [...new Set(tags)]
}

// ── Venue management ──────────────────────────────────────────────────────

// Cache key is the NORMALIZED VENUE NAME, never `location_id`.
//
// The feed reuses one `location_id` for every event a branch *hosts*, including
// the ones it holds somewhere else: id 1495 (Tallmadge) arrives as "Tallmadge
// Branch Library" on one row and "Danbury Senior Living" on the next, id 1487
// covers Macedonia Community Center, Macedonia City Center and MV Games. Keying
// the cache on the id meant the first row of the run won the id outright and
// every later row at that id was handed the FIRST row's venue before its own
// name was ever read — 125 events filed at a venue they are not held at.
const venueCache = new Map() // venueNameKey(name) → venueId

/** Feed placeholders for an online program. "Zoom: Main Library" is a Zoom
 *  call, not a room at Main Library, and must never mint or resolve a venue.
 *  isJunkVenueName() only catches these by accident (it matches "Zoom:
 *  Highland Square" purely because the last token is a street suffix), so the
 *  skip has to be explicit. */
const VIRTUAL_VENUE_RE = /^(zoom|virtual|online)\b/i

/** Cache key for a parsed venue — derived from the name ALONE, so two venues
 *  sharing a `location_id` can never collide. Pure + exported for tests. */
export function libraryVenueCacheKey(venue) {
  return venue ? venueNameKey(venue.name) : null
}

/**
 * Parse one feed row into venue fields. Pure: no DB, no network, no defaults
 * invented from thin air.
 *
 * Returns `null` for a virtual/online row (no venue exists to link), otherwise
 * `{ name, address?, city?, state, zip? }` with the optional keys OMITTED
 * rather than guessed. The previous code hardcoded `city: 'Akron'` for every
 * off-site venue, which put Macedonia, Tallmadge and Northfield addresses on
 * the Akron hub and left them ungeocodable.
 *
 * `venue_description` is parsed with htmlToText, NOT stripHtml: the feed writes
 * the address as `<p>`/`<br>` blocks and stripHtml flattens ALL whitespace by
 * contract, welding "9691 Valley View Rd" onto "Macedonia, OH 44056" into one
 * line with no recoverable boundary. Shapes seen live include a single comma
 * line ("1280 E Aurora Rd, Macedonia, OH 44056"), `<br>`-separated lines with
 * the zip alone on the last one, and a leading line repeating the venue name.
 *
 * `venue_room` is deliberately ignored — it is sometimes a room ("Bistro
 * Room"), sometimes an unlabeled address, and nothing distinguishes them.
 *
 * Exported for tests.
 */
export function parseLibraryVenue(ev) {
  const name = stripHtml(ev?.venue_name || ev?.location || '')
  if (!name) return null
  if (VIRTUAL_VENUE_RE.test(name)) return null

  // Every venue in this feed is a Summit-County-area library program site; the
  // state is the one field the source never varies and never states wrongly.
  const venue = { name, state: 'OH' }

  const segments = htmlToText(ev?.venue_description || '')
    .split(/\n+/)
    .flatMap((line) => line.split(','))
    .map((s) => s.trim())
    .filter(Boolean)
  if (!segments.length) return venue

  // The zip turns up glued to the state ("OH 44056"), comma-split off it
  // ("OH", "44278"), or alone on its own line ("44308"). Peel it off first so
  // what remains of that segment can still be recognized as the state.
  let zip = null
  const parts = []
  for (const seg of segments) {
    const m = zip ? null : seg.match(/\b(\d{5}(?:-\d{4})?)$/)
    if (m) {
      zip = m[1]
      const rest = seg.slice(0, m.index).trim().replace(/[.,]$/, '')
      if (rest) parts.push(rest)
    } else {
      parts.push(seg)
    }
  }
  if (zip) venue.zip = zip

  const stateIdx = parts.findIndex((p) => /^(OH|Ohio)\.?$/i.test(p))

  // City is the segment before the state — and only if it actually reads like
  // a place name. A description that skips the city ("123 Main St, OH 44444")
  // must yield no city rather than a street masquerading as one.
  let cityIdx = -1
  if (stateIdx > 0) {
    const candidate = parts[stateIdx - 1]
    if (!/\d/.test(candidate) && !looksLikeStreetAddress(candidate)) {
      cityIdx = stateIdx - 1
      venue.city = candidate
    }
  }

  // Street is the LAST address-shaped segment ahead of the city, which skips a
  // leading line that merely repeats the venue name. looksLikeStreetAddress is
  // the gate and stays strict: "920 Hereford Park." is prose, not an address,
  // so that venue is emitted with no address at all rather than a bad one.
  const limit = cityIdx >= 0 ? cityIdx : (stateIdx >= 0 ? stateIdx : parts.length)
  for (let i = limit - 1; i >= 0; i--) {
    if (looksLikeStreetAddress(parts[i])) {
      venue.address = parts[i]
      break
    }
  }

  return venue
}

async function ensureLibraryVenue(ev, organizerId) {
  const parsed = parseLibraryVenue(ev)
  if (!parsed) return null   // online-only program: there is no venue to link

  const cacheKey = libraryVenueCacheKey(parsed)
  if (venueCache.has(cacheKey)) return venueCache.get(cacheKey)

  // Branch on a BRANCH_INFO hit, not on the feed's `venue_type`: it labels some
  // branch-hosted rows "external" (and is null on others), while the branch
  // table is the thing that actually knows the address and coordinate.
  const branchInfo = BRANCH_INFO[parsed.name]

  let venueId
  if (branchInfo) {
    // Known library branch — create with full branch-specific details
    venueId = await ensureVenue(parsed.name, {
      address:       branchInfo.address,
      // Branches outside Akron proper carry their real municipality so they
      // surface on the correct city / regional hub (Green, Tallmadge, Fairlawn,
      // Norton, Mogadore, …) instead of being mis-filed under Akron.
      city:          branchInfo.city ?? 'Akron',
      state:         'OH',
      zip:           branchInfo.zip,
      lat:           branchInfo.lat,
      lng:           branchInfo.lng,
      parking_type:  branchInfo.parking_type,
      parking_notes: branchInfo.parking_notes,
      website:       'https://www.akronlibrary.org',
      description:   'Branch of the Akron-Summit County Public Library.',
    })
    // Link this branch venue to the organization
    if (venueId && organizerId) {
      await linkOrganizationVenue(organizerId, venueId)
    }
  } else {
    // Off-site / external venue — carry whatever the feed actually published
    // and nothing more. No library website/description (it is not a library
    // building) and no organization link (it is not a library venue).
    const details = { state: parsed.state }
    if (parsed.address) details.address = parsed.address
    if (parsed.city)    details.city    = parsed.city
    if (parsed.zip)     details.zip     = parsed.zip
    venueId = await ensureVenue(parsed.name, details)
  }

  venueCache.set(cacheKey, venueId)
  return venueId
}

async function ensureOrganizer() {
  return ensureOrganization('Akron-Summit County Public Library', {
    website:     'https://www.akronlibrary.org',
    description: 'The Akron-Summit County Public Library provides resources for learning, programs for all ages, and events that enrich community life across Summit County.',
  })
}

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchEvents() {
  const startDate = easternTodayIso()
  console.log(`\n🔍  Fetching library events for next ${DAYS_AHEAD} days…`)

  const req = JSON.stringify({
    private:   false,
    date:      startDate,
    days:      DAYS_AHEAD,
    locations: [],
    ages:      [],
    types:     [],
  })

  const url = `${API_BASE}?event_type=0&req=${encodeURIComponent(req)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Library API error ${res.status}: ${await res.text()}`)

  const data = await res.json()
  console.log(`  Received ${data.length} events`)
  return data
}

// ── Process ───────────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      // May be null — an online-only program, or a name the venue guards
      // refuse to mint. The event is still worth publishing without a venue.
      const venueId = await ensureLibraryVenue(ev, organizerId)

      const title    = stripHtml(ev.title || '')
      const category = parseCategory(ev.tags, title)
      // Feed field is `ages` (PLURAL) — `ev.age` does not exist. The singular
      // read shipped silently and disabled the authoritative audience signal
      // for every event until 2026-07-08 (Glow Party leaked past the no-kids
      // toggle with Ages "Tween, School Age, Preschool").
      const tags     = parseTags(ev.tags, ev.ages)
      const startAt  = easternToIso(ev.raw_start_time)
      const endAt    = easternToIso(ev.raw_end_time)
      let   descText = stripHtml(ev.long_description || ev.description || '')
      // Fall back to the library's event detail page when the API
      // returns no body — keeps storytimes and program announcements
      // from rendering as a bare title on Akron Pulse.
      if (!descText) {
        const url = sanitizeUrl(ev.url)
        if (url) descText = (await fetchSchemaDescription(url)) ?? ''
      }

      if (!startAt) { skipped++; continue }

      const row = {
        title,
        description:     descText || null,
        start_at:        startAt,
        end_at:          endAt,
        category,
        // Authoritative audience signal from the library's Ages field;
        // undefined (not false) when absent so inference still decides.
        is_family:       parseIsFamily(ev.ages, ev.tags),
        tags,
        price_min:       0,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       ev.image ? `https://services.akronlibrary.org/images/events/akronlibrary/${ev.image}` : null,
        ticket_url:      sanitizeUrl(ev.url),
        source:          'akron_library',
        source_id:       String(ev.id),
        status:          'published',
        featured:        false,
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        // setEventVenue, not linkEventVenue: a library event has exactly one
        // venue, and add-only linking leaves every venue this event was ever
        // mis-filed under attached to it forever.
        if (venueId) await setEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ───────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akron-Summit County Library ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganizer()
    const rawEvents   = await fetchEvents()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, organizerId)
    await logUpsertResult('akron_library', inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('akron_library', err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-akron-library.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
