/**
 * scrape-akron-soul-train.js
 *
 * Akron Soul Train — a small downtown Akron artist-residency gallery (191 S
 * Main St) running free/donation-based art programs: live demos, exhibitions,
 * and performances.
 *
 * Platform: Wix Events → parsed via the shared lib/wix-events.js (reads the
 * server-rendered #wix-warmup-data blob). Each event carries its own location,
 * which may be the gallery or a partner venue (e.g. the Myers School of Art);
 * we fall back to the gallery only when an event has no location.
 *
 * Price is left null (never assume free — even "free or donation-based" isn't a
 * guarantee for a given program).
 *
 * Usage:   node scripts/scrape-akron-soul-train.js
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

const SOURCE_KEY     = 'akron_soul_train'
const SITE           = 'https://www.akronsoultrain.org'
const EVENTS_URL     = `${SITE}/events`
const MAX_DAYS_AHEAD = 240

// Gallery fallback used only when an event omits a location.
const GALLERY = {
  name: 'Akron Soul Train', address: '191 S Main St', city: 'Akron', state: 'OH', zip: '44308',
  neighborhood_slug: 'downtown-akron',
}

/** Venue fields for an event: its own Wix location, or the gallery fallback. */
export function venueFor(location) {
  const p = parseWixLocation(location) || {}
  const name = p.name || GALLERY.name
  const isGallery = name === GALLERY.name
  return {
    name,
    address: p.address || (isGallery ? GALLERY.address : null),
    city:    p.city    || (isGallery ? GALLERY.city : null),
    state:   p.state   || (isGallery ? GALLERY.state : 'OH'),
    zip:     p.zip     || (isGallery ? GALLERY.zip : null),
    lat:     p.lat,
    lng:     p.lng,
    neighborhood_slug: isGallery ? GALLERY.neighborhood_slug : undefined,
    isGallery,
  }
}

const venueCache = new Map()
async function ensureEventVenue(v, organizerId) {
  if (venueCache.has(v.name)) return venueCache.get(v.name)
  const id = await ensureVenue(v.name, {
    address: v.address ?? undefined, city: v.city ?? undefined, state: v.state ?? undefined,
    zip: v.zip ?? undefined, lat: v.lat ?? undefined, lng: v.lng ?? undefined,
    neighborhood_slug: v.neighborhood_slug, website: v.isGallery ? SITE : undefined,
  })
  if (id && organizerId && v.isGallery) await linkOrganizationVenue(organizerId, id)
  venueCache.set(v.name, id)
  return id
}

async function main() {
  console.log('🎨  Starting Akron Soul Train ingestion…')
  const start = Date.now()
  try {
    const organizerId = await ensureOrganization('Akron Soul Train', {
      website: SITE,
      description: 'Akron Soul Train is a downtown Akron artist-residency gallery presenting free and donation-based art programs, exhibitions, and performances.',
    })

    const events = await fetchWixEvents(EVENTS_URL)
    console.log(`  Found ${events.length} event object(s) in warmup data`)
    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    let inserted = 0, skipped = 0

    for (const raw of events) {
      try {
        const row = normaliseWixEvent(raw, {
          source:          SOURCE_KEY,
          mapTags:         () => ['akron-soul-train', 'art', 'gallery', 'akron'],
          defaultPriceMin: null, // never assume free
          ageRestriction:  'all_ages',
          siteBaseUrl:     SITE,
        })
        if (!row.title || !row.start_at) { skipped++; continue }
        row.category = inferCategory(row.title, row.description || '')

        const startMs = Date.parse(row.start_at)
        if (startMs < now - 86_400_000 || startMs > cutoff) { skipped++; continue }

        const venueId = await ensureEventVenue(venueFor(raw.location), organizerId)
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skipped++; continue }
        if (venueId) await linkEventVenue(upserted.id, venueId)
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
