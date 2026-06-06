/**
 * scrape-city-of-green.js
 *
 * Fetches public-facing events from the City of Green, Ohio — a Summit
 * County municipality (~10 mi south of Akron) running an active Parks
 * & Rec programming calendar: FreedomFest, Summer Concert Series at
 * Boettler Park, Movie in the Park, art-A-palooza, Trick-or-Treat
 * Trail, Christmas at Central Park, Twisted WilderFest, Memorial Day
 * and Veterans Day ceremonies, Senior Expo, plus seasonal community
 * events.
 *
 * Platform: cityofgreen.org runs on CivicPlus (CivicEngage). The
 * city's master calendar is exposed as a standard RFC 5545 iCalendar
 * feed at the canonical CivicPlus path:
 *   /common/modules/iCalendar/iCalendar.aspx?catID=14&feed=calendar
 * (catID=14 == "City of Green Main Calendar".)
 *
 * Filter: the master calendar mixes public-facing events with
 * administrative entries — committee meetings, City Council meetings,
 * planning & zoning, holiday observances ("Christmas Day", "Veterans
 * Day" the federal holiday vs "Veterans Day Ceremony" the public
 * event). We drop those and let everything else through, so newly
 * added City of Green specials flow in without code changes. Mirrors
 * the inclusion/exclusion pattern in scrape-akron-public-schools.js.
 *
 * Why this lives outside runIcsScraper: the shared runIcsScraper
 * pipeline doesn't expose a per-event include hook, so we do the
 * fetch + parse + filter manually using the same lib/ics.js
 * primitives (fetchIcsFeed, parseIcs, normaliseIcsEvent) and the
 * normalize.js upsert helpers.
 *
 * Usage:
 *   node scripts/scrape-city-of-green.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { fetchIcsFeed, parseIcs, normaliseIcsEvent } from './lib/ics.js'
import {
  ensureOrganization,
  ensureVenue,
  linkOrganizationVenue,
  logUpsertResult,
  logScraperError,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
} from './lib/normalize.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY = 'city_of_green'
const ICS_FEED_URL =
  process.env.CITY_OF_GREEN_ICS_URL ||
  'https://www.cityofgreen.org/common/modules/iCalendar/iCalendar.aspx?catID=14&feed=calendar'

// Default venue when a VEVENT's LOCATION field is empty. Most City of
// Green programming runs at Boettler Park; Christmas at Central Park
// and a few others move to Central Park near city hall. The ICS feed
// almost always carries a usable LOCATION, so this fallback is rare.
const DEFAULT_VENUE = {
  name:    'Boettler Park',
  address: '5300 Massillon Rd',
  city:    'Green',
  state:   'OH',
  zip:     '44232',
  // Boettler Park center.
  lat:     41.0123,
  lng:     -81.4742,
  website: 'https://www.cityofgreen.org/170/Boettler-Park',
  description:
    "Boettler Park is the City of Green's flagship community park and the main host site for " +
    "FreedomFest, the Summer Concert Series, Movie in the Park, and other Parks & Recreation " +
    "programming.",
  parking_type:  'lot',
  parking_notes: 'Free on-site parking lot.',
}

const ORG_INFO = {
  name: 'City of Green Parks & Recreation',
  details: {
    website:     'https://www.cityofgreen.org/237/Special-Events',
    description:
      'The City of Green (Summit County, OH) Parks & Recreation department runs an active ' +
      'year-round special-events calendar: FreedomFest, Summer Concert Series, Movie in the ' +
      'Park, art-A-palooza, Trick-or-Treat Trail, Christmas at Central Park, Twisted WilderFest, ' +
      'Memorial Day and Veterans Day ceremonies, Senior Expo, and seasonal community events.',
  },
}

// ── Public-event filter ──────────────────────────────────────────────────
//
// EXCLUDE rather than allowlist: the city's special-events lineup
// expands every year (new summer concerts, new movies) and a closed
// allowlist would force a code change every time. Excluding the
// known-administrative summaries keeps the gate stable and lets
// future events flow in automatically.

const EXCLUDE_EXACT_SUMMARIES = new Set([
  // Recurring administrative meetings
  'committee meeting',
  'city council meeting',
  'planning & zoning commission',
  'parks & recreation board meeting',
  'veterans advisory commission meeting',
  "mayor's morning meet-up",
  'green veterans rally point',
  // Federal holiday observances (distinct from the public ceremonies,
  // which have "Ceremony" in their summary — e.g. "Veterans Day
  // Ceremony" stays, "Veterans Day" the holiday gets dropped)
  'christmas day',
  'veterans day',
  'independence day',
  "new year's day",
])

function isPublicSpecialEvent(ev) {
  const summary = (ev.SUMMARY || '').trim().toLowerCase()
  if (!summary) return false
  if (EXCLUDE_EXACT_SUMMARIES.has(summary)) return false
  // Drop any "...Canceled for Summer Recess" / "Canceled" markers
  if (/\bcanceled\b|\bcancelled\b/.test(summary)) return false
  return true
}

// ── Category mapping ─────────────────────────────────────────────────────

// Category: infer from event text; Green special events default to 'other'.
function mapCategory(ev) {
  return inferCategory(ev.SUMMARY || '', ev.DESCRIPTION || '')
}

function mapTags(ev) {
  const text = (ev.SUMMARY || '').toLowerCase()
  const tags = ['city-of-green', 'green-ohio', 'summit-county', 'parks-recreation']
  if (/freedomfest|4th of july|fourth of july|independence/.test(text))   tags.push('fourth-of-july')
  if (/christmas|holiday/.test(text))                                     tags.push('seasonal', 'holiday')
  if (/trick-or-treat|halloween|wilderfest/.test(text))                   tags.push('halloween', 'family')
  if (/memorial day|veterans/.test(text))                                 tags.push('ceremony', 'patriotic')
  if (/movie in the park/.test(text))                                     tags.push('family', 'free', 'outdoor')
  if (/summer concert|concert series/.test(text))                         tags.push('free', 'outdoor')
  if (/senior expo/.test(text))                                           tags.push('seniors')
  if (/egg scramble|breakfast with the bunny|easter/.test(text))          tags.push('easter')
  if (/fishing derby|trail challenge|nature/.test(text))                  tags.push('outdoor')
  return [...new Set(tags)]
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌳  Starting City of Green ingestion (CivicPlus iCalendar feed)…')
  const start = Date.now()

  try {
    console.log(`  → Fetching ${ICS_FEED_URL}`)
    const icsText = await fetchIcsFeed(ICS_FEED_URL)
    const allEvents = parseIcs(icsText)
    console.log(`  Parsed ${allEvents.length} VEVENTs`)

    const publicEvents = allEvents.filter(isPublicSpecialEvent)
    console.log(`  Filtered to ${publicEvents.length} public-facing events (dropped ${allEvents.length - publicEvents.length} admin/holiday entries)`)

    if (publicEvents.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: 'error',
        errorMessage: 'Feed parsed but contained 0 public-facing events after filter',
        durationMs:  Date.now() - start,
        eventsFound: allEvents.length,
      })
      console.warn('  ⚠ No public events — exiting without an error so the next scheduled run still tries.')
      process.exit(0)
    }

    // Ensure the org + default venue once before the loop.
    const organizerId = await ensureOrganization(ORG_INFO.name, ORG_INFO.details)
    const defaultVenueId = await ensureVenue(DEFAULT_VENUE.name, {
      address:       DEFAULT_VENUE.address,
      city:          DEFAULT_VENUE.city,
      state:         DEFAULT_VENUE.state,
      zip:           DEFAULT_VENUE.zip,
      lat:           DEFAULT_VENUE.lat,
      lng:           DEFAULT_VENUE.lng,
      website:       DEFAULT_VENUE.website,
      description:   DEFAULT_VENUE.description,
      parking_type:  DEFAULT_VENUE.parking_type,
      parking_notes: DEFAULT_VENUE.parking_notes,
    })
    if (organizerId && defaultVenueId) {
      await linkOrganizationVenue(organizerId, defaultVenueId)
    }

    console.log(`\n📥  Processing ${publicEvents.length} events…`)
    let inserted = 0, skipped = 0
    const venueCache = new Map()

    for (const ev of publicEvents) {
      try {
        const row = normaliseIcsEvent(ev, {
          source:          SOURCE_KEY,
          mapCategory,
          mapTags,
          defaultPriceMin: 0,        // City programming is overwhelmingly free
          defaultPriceMax: null,
          ageRestriction:  'all_ages',
          // CivicPlus VEVENT URLs are root-relative; absolutise against the
          // feed's origin so ticket_url/source_url are valid links.
          linkBaseUrl:     new URL(ICS_FEED_URL).origin,
        })
        if (!row || !row.start_at || !row.source_id) { skipped++; continue }

        // Per-event venue: prefer VEVENT LOCATION when present, fall back to
        // Boettler Park as the default Green-area venue.
        let venueId = defaultVenueId
        const locName = (ev.LOCATION || '').trim()
        if (locName) {
          if (venueCache.has(locName)) {
            venueId = venueCache.get(locName)
          } else {
            venueId = await ensureVenue(locName, { city: 'Green', state: 'OH' })
            venueCache.set(locName, venueId)
          }
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
          continue
        }

        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${ev.SUMMARY}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: allEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

main()
