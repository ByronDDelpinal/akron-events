/**
 * scrape-musica.js
 *
 * Ingests upcoming shows at Musica (downtown Akron live-music venue) directly
 * from the DICE partner API. Musica sells through DICE and embeds the DICE
 * event-list widget rather than running a native calendar, so aggregator feeds
 * (e.g. the CVB) often drop the show time. Pulling from DICE gives authoritative
 * start times, prices, and ticket links.
 *
 * Platform: DICE partner API (see scripts/lib/dice.js)
 *
 * Usage:
 *   DICE_API_KEY=… node scripts/scrape-musica.js
 *   DICE_DEBUG=1 DICE_API_KEY=… node scripts/scrape-musica.js   # dump first raw event
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   DICE_API_KEY  — the DICE widget's public x-api-key (copy from the venue
 *                   widget's network request; not committed)
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'
import { fetchDiceEvents, normaliseDiceEvent } from './lib/dice.js'

const SOURCE_KEY = 'musica'
const DICE_VENUE = 'Musica'          // the venue name DICE filters on
const SITE_URL   = 'https://www.theofficialmusica.com'

// Publicly available front-end API key from Musica's network request — the DICE
// event-list widget ships this x-api-key to every browser that loads the venue
// page, so it's not a secret. An env var overrides it if it ever rotates.
const DICE_API_KEY = process.env.DICE_API_KEY || 'A1XgRsnir2auvJeoQrfgC3lU6Sk7qAM23c2Zgg1C'

const VENUE_DETAILS = {
  address: '51 E Market St',
  city:    'Akron',
  state:   'OH',
  zip:     '44308',
  website: SITE_URL,
}

// ── Tag mapping ─────────────────────────────────────────────────────────────

export function mapTags(ev) {
  const t    = (ev?.name || '').toLowerCase()
  const tags = ['live-music', 'concert', 'music', 'akron', 'musica']
  if (/\b(comedy|stand-?up)\b/.test(t)) tags.push('comedy')
  if (/\b(dj|dance party)\b/.test(t))   tags.push('dj')
  // DICE genre tags like "gig:indierock" → "indierock"
  for (const g of ev?.genre_tags ?? []) {
    const slug = String(g).split(':').pop().trim().toLowerCase()
    if (slug) tags.push(slug)
  }
  return [...new Set(tags)]
}

// ── Process ─────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, venueId, organizerId) {
  let inserted = 0, skipped = 0
  const now = Date.now()

  for (const ev of rawEvents) {
    try {
      if (typeof ev?.status === 'string' && /cancel/i.test(ev.status)) { skipped++; continue }

      const row = normaliseDiceEvent(ev, { source: SOURCE_KEY, category: 'music', mapTags })
      if (!row || !row.start_at) { skipped++; continue }
      if (new Date(row.start_at).getTime() < now) { skipped++; continue } // past show

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev?.name}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Musica (DICE) ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([
      ensureVenue('Musica', VENUE_DETAILS),
      ensureOrganization('Musica', {
        website:     SITE_URL,
        description: 'Musica is an independent live-music venue and bar in downtown Akron hosting touring and local acts.',
      }),
    ])
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    console.log(`\n🔍  Fetching DICE events for venue "${DICE_VENUE}"…`)
    const rawEvents = await fetchDiceEvents({ venue: DICE_VENUE, apiKey: DICE_API_KEY })
    console.log(`  Found ${rawEvents.length} events`)

    if (process.env.DICE_DEBUG && rawEvents.length) {
      console.log('  DEBUG first raw event:\n', JSON.stringify(rawEvents[0], null, 2).slice(0, 4000))
    }

    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

export { mapTags as _mapTags, SOURCE_KEY }
