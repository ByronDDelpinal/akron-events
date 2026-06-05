/**
 * scrape-akron-public-schools.js
 *
 * Fetches district-wide calendar events from Akron Public Schools.
 *
 * Caveat: the district calendar mixes public-facing events (music
 * performances, sports, open houses, community meetings) with internal
 * administrative dates (PTO meetings, staff training, building closures).
 * We apply a keyword filter to surface only public-facing items.
 *
 * Per the config memory, final filter tuning should be reviewed with the
 * user — this is a conservative starting pass.
 *
 * Usage:
 *   node scripts/scrape-akron-public-schools.js
 *
 * Environment overrides:
 *   AKRON_PUBLIC_SCHOOLS_ICS_URL — direct ICS feed URL
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { fetchIcsFeed, parseIcs, normaliseIcsEvent, discoverIcsFeed } from './lib/ics.js'
import {
  ensureOrganization,
  ensureVenue,
  logUpsertResult,
  logScraperError,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
} from './lib/normalize.js'

const SOURCE_KEY = 'akron_public_schools'
const CALENDAR_PAGE = 'https://www.akronschools.com/district/district-information/calendar'

// ── Public-facing event filter ────────────────────────────────────────────
//
// Rather than ingest every VEVENT, only include items that look like public
// gatherings. Tune these keyword lists as patterns emerge from real data.

const PUBLIC_KEYWORDS = [
  'concert', 'recital', 'performance', 'show', 'play', 'musical', 'band', 'choir', 'orchestra',
  'game', 'match', 'meet', 'tournament', 'scrimmage',   // athletics
  'open house', 'family night', 'community', 'fair', 'festival',
  'graduation', 'commencement', 'ceremony',
  'board meeting', 'school board', 'public hearing',
  'fundraiser', 'bake sale', 'book fair',
]

const EXCLUDE_KEYWORDS = [
  'staff', 'pd day', 'professional development', 'in-service', 'teacher workday',
  'no school', 'early dismissal', 'late start', 'closed',
  'report cards', 'progress reports', 'conferences only',
]

function isPublicFacing(ev) {
  const hay = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''} ${ev.CATEGORIES || ''}`.toLowerCase()
  if (EXCLUDE_KEYWORDS.some(k => hay.includes(k))) return false
  return PUBLIC_KEYWORDS.some(k => hay.includes(k))
}

function mapCategory(ev) {
  const text = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''}`.toLowerCase()
  if (/\b(concert|recital|musical|band|choir|orchestra)\b/.test(text)) return 'music'
  if (/\b(game|match|tournament|meet|scrimmage)\b/.test(text))         return 'sports'
  if (/\b(play|show|performance|drama|theater|theatre)\b/.test(text))  return 'art'
  if (/\b(graduation|commencement|ceremony)\b/.test(text))             return 'community'
  if (/\b(fair|festival|open house|family night)\b/.test(text))        return 'community'
  return 'education'
}

function mapTags(ev) {
  const tags = ['schools', 'akron-public-schools', 'education']
  const text = (ev.SUMMARY || '').toLowerCase()
  if (/\b(game|match|tournament)\b/.test(text)) tags.push('athletics')
  if (/\b(concert|recital|band|choir|orchestra)\b/.test(text)) tags.push('music')
  return [...new Set(tags)]
}

async function main() {
  console.log('🚀  Starting Akron Public Schools scrape…')
  const start = Date.now()

  try {
    let feedUrl = process.env.AKRON_PUBLIC_SCHOOLS_ICS_URL
    if (!feedUrl) {
      console.log('  🔎  Discovering ICS feed from district calendar page…')
      feedUrl = await discoverIcsFeed(CALENDAR_PAGE)
      if (!feedUrl) {
        throw new Error(
          'No ICS feed discovered on APS calendar page. ' +
          'Visit the district calendar in a browser, find the "Subscribe" or RSS/iCal link, ' +
          'and set AKRON_PUBLIC_SCHOOLS_ICS_URL in .env.'
        )
      }
      console.log(`  ✓ Discovered feed: ${feedUrl}`)
    }

    const icsText   = await fetchIcsFeed(feedUrl)
    const allEvents = parseIcs(icsText)
    console.log(`  Parsed ${allEvents.length} VEVENTs`)

    const publicEvents = allEvents.filter(isPublicFacing)
    console.log(`  Filtered to ${publicEvents.length} public-facing events (dropped ${allEvents.length - publicEvents.length})`)

    if (publicEvents.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: 'error',
        errorMessage: 'Feed parsed but contained 0 public-facing events after filter',
        durationMs: Date.now() - start,
        eventsFound: allEvents.length,
      })
      process.exit(0)
    }

    const organizationId = await ensureOrganization('Akron Public Schools', {
      website:     'https://www.akronschools.com',
      description: 'Akron Public Schools is the public school district serving Akron, Ohio.',
    })

    console.log(`\n📥  Processing ${publicEvents.length} events…`)
    let inserted = 0, skipped = 0
    const venueCache = new Map()

    for (const ev of publicEvents) {
      try {
        const row = normaliseIcsEvent(ev, {
          source: SOURCE_KEY,
          mapCategory,
          mapTags,
          defaultPriceMin: null,
          defaultPriceMax: null,
          ageRestriction:  'all_ages',
        })
        if (!row || !row.start_at || !row.source_id) { skipped++; continue }

        const locName = (ev.LOCATION || '').trim()
        let venueId = null
        if (locName) {
          if (venueCache.has(locName)) {
            venueId = venueCache.get(locName)
          } else {
            venueId = await ensureVenue(locName, { city: 'Akron', state: 'OH' })
            venueCache.set(locName, venueId)
          }
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)
        if (error) { console.warn(`  ⚠ Upsert failed: ${error.message}`); skipped++; continue }

        if (venueId)        await linkEventVenue(upserted.id, venueId)
        if (organizationId) await linkEventOrganization(upserted.id, organizationId)
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
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

main()
