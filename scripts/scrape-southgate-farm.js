/**
 * scrape-southgate-farm.js
 *
 * Southgate Farm — a small organic farm/CSA in North Canton that hosts public
 * classes and events in its historic barn: weekly summer farm yoga, full-moon
 * yoga + bonfires, farm/garden tours, and craft make-and-takes.
 *
 * Platform: Wix Events → parsed via the shared lib/wix-events.js (reads the
 * server-rendered #wix-warmup-data blob; no Puppeteer needed). Every event is at
 * the one farm address, so we pin them all to a single canonical venue (Wix
 * lists some as "Southgate Farm" and some as "Southgate Farm Barn" — same place,
 * so collapsing avoids a duplicate venue record). Coordinates are taken from the
 * Wix location data when present.
 *
 * Scope note: the farm is at 6521 Mt Pleasant St NW, North Canton (Stark County)
 * — just outside Summit, like our other near-border direct sources (Players
 * Guild, Centennial Plaza). As a first-party venue scraper it isn't Summit-gated.
 * Price is left null (never assume free — most classes are ticketed/RSVP).
 *
 * Usage:   node scripts/scrape-southgate-farm.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, inferCategory, enrichWithImageDimensions,
  upsertEventSafe, linkEventVenue, linkEventOrganization, ensureVenue, ensureOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'
import { fetchWixEvents, parseWixLocation, normaliseWixEvent } from './lib/wix-events.js'

export const SOURCE_KEY = 'southgate_farm'
const SITE           = 'https://www.southgatefarm.com'
const EVENTS_URL     = `${SITE}/events`
const MAX_DAYS_AHEAD  = 300  // farm publishes the whole season at once

// Single canonical venue — every event is at the farm/barn (one address).
export const FARM = {
  name: 'Southgate Farm',
  address: '6521 Mt Pleasant St NW',
  city: 'North Canton',
  state: 'OH',
  zip: '44720',
}

async function main() {
  console.log('🌾  Starting Southgate Farm (Wix Events) ingestion…')
  const start = Date.now()
  try {
    const organizerId = await ensureOrganization('Southgate Farm', {
      website: SITE,
      description: 'Southgate Farm is an organic farm and CSA in North Canton hosting farm yoga, farm/garden tours, and seasonal classes in its historic barn.',
    })

    const events = await fetchWixEvents(EVENTS_URL)
    console.log(`  Found ${events.length} event object(s) in warmup data`)

    // Pull coordinates from the first event that carries them (all same place).
    let coords = {}
    for (const ev of events) {
      const p = parseWixLocation(ev.location)
      if (p && p.lat != null && p.lng != null) { coords = { lat: p.lat, lng: p.lng }; break }
    }
    const venueId = await ensureVenue(FARM.name, {
      address: FARM.address, city: FARM.city, state: FARM.state, zip: FARM.zip,
      website: SITE, ...coords,
    })
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    let inserted = 0, skipped = 0

    for (const raw of events) {
      try {
        const row = normaliseWixEvent(raw, {
          source:          SOURCE_KEY,
          mapTags:         () => ['southgate-farm', 'farm', 'north-canton'],
          defaultPriceMin: null,  // never assume free
          ageRestriction:  'all_ages',
          siteBaseUrl:     SITE,
        })
        if (!row.title || !row.start_at) { skipped++; continue }
        row.category = inferCategory(row.title, row.description || '')

        const startMs = Date.parse(row.start_at)
        if (startMs < now - 86_400_000 || startMs > cutoff) { skipped++; continue }

        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skipped++; continue }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${raw.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: events.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
