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
  fetchSchemaDescription,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'

const API_BASE   = 'https://services.akronlibrary.org/eeventcaldata'
const DAYS_AHEAD = 180  // fetch 6 months at a time

// ── Known branch library addresses ───────────────────────────────────────
// Used to pre-populate venue records. Branches not listed here get name-only records.
export const BRANCH_INFO = {
  'Main Library':                     { address: '60 S High St',            zip: '44326', lat: 41.0819, lng: -81.5188, parking_type: 'garage',  parking_notes: 'Parking garage adjacent to building on S High St.' },
  'Highland Square Branch Library':   { address: '807 W Market St',         zip: '44303', lat: 41.0808, lng: -81.5468, parking_type: 'lot',     parking_notes: 'Free surface lot behind building.' },
  'Kenmore Branch Library':           { address: '969 Kenmore Blvd',        zip: '44314', lat: 41.0510, lng: -81.5355, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Firestone Park Branch Library':    { address: '1486 Aster Ave',          zip: '44301', lat: 41.0450, lng: -81.5093, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Ellet Branch Library':             { address: '2470 E Market St',        zip: '44312', lat: 41.0808, lng: -81.4706, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'North Hill Branch Library':        { address: '183 E Cuyahoga Falls Ave', zip: '44310', lat: 41.1108, lng: -81.5143, parking_type: 'lot',    parking_notes: 'Free on-site parking lot.' },
  'Green Branch Library':             { address: '4046 Massillon Rd', city: 'Green',       zip: '44232', lat: 40.9478, lng: -81.4696, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Goodyear Branch Library':          { address: '60 Goodyear Blvd',        zip: '44305', lat: 41.0680, lng: -81.4870, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Northwest Akron Branch Library':   { address: '1720 Shatto Ave',         zip: '44313', lat: 41.1065, lng: -81.5665, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Fairlawn-Bath Branch Library':     { address: '3490 W Market St', city: 'Fairlawn',        zip: '44333', lat: 41.1353, lng: -81.5927, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Portage Lakes Branch Library':     { address: '4261 Shriver Rd',         zip: '44319', lat: 40.9987, lng: -81.5346, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Mogadore Branch Library':          { address: '144 S Cleveland Ave', city: 'Mogadore',      zip: '44260', lat: 41.0593, lng: -81.4018, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Maple Valley Branch Library':      { address: '1187 Mogadore Rd',        zip: '44306', lat: 41.0588, lng: -81.4625, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Richfield Branch Library':         { address: '3761 S Park Dr', city: 'Richfield',          zip: '44286', lat: 41.2304, lng: -81.6412, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Nordonia Hills Branch Library':    { address: '70 Olde Eight Rd', city: 'Northfield',        zip: '44067', lat: 41.2112, lng: -81.5107, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Norton Branch Library':            { address: '3930 S Cleveland-Massillon Rd', city: 'Norton', zip: '44203', lat: 40.9892, lng: -81.6395, parking_type: 'lot', parking_notes: 'Free on-site parking lot.' },
  'Springfield-Lakemore Branch Library': { address: '1100 Canton Rd', city: 'Lakemore',       zip: '44312', lat: 41.0169, lng: -81.4632, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Tallmadge Branch Library':         { address: '90 North Ave', city: 'Tallmadge',            zip: '44278', lat: 41.0992, lng: -81.4426, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Odom Boulevard Branch Library':    { address: '600 Vernon Odom Blvd',    zip: '44307', lat: 41.0631, lng: -81.5372, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
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
  return /\b(bab(y|ies)|toddlers?|preschool|kids?|child(ren)?|family|families|grades? [k0-9]|tweens?)\b/.test(t) || undefined
}

function parseTags(tagStr = '', ageStr = '') {
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

const venueCache = new Map() // locationId → venueId

async function ensureLibraryVenue(locationId, locationName, organizerId) {
  if (venueCache.has(locationId)) return venueCache.get(locationId)

  const branchInfo = BRANCH_INFO[locationName]

  let venueId
  if (branchInfo) {
    // Known library branch — create with full branch-specific details
    venueId = await ensureVenue(locationName, {
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
    // Off-site / external venue — create with generic info only;
    // do NOT stamp it with library website/description
    // do NOT link to organization as these are external venues
    venueId = await ensureVenue(locationName, {
      city:  'Akron',
      state: 'OH',
    })
  }

  venueCache.set(locationId, venueId)
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
  const startDate = new Date().toISOString().split('T')[0]
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
      const venueId = await ensureLibraryVenue(ev.location_id, ev.location || 'Akron-Summit County Public Library', organizerId)

      const title    = stripHtml(ev.title || '')
      const category = parseCategory(ev.tags, title)
      const tags     = parseTags(ev.tags, ev.age)
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
        is_family:       parseIsFamily(ev.age, ev.tags),
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
        await linkEventVenue(upserted.id, venueId)
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
