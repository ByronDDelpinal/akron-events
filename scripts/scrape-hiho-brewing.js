/**
 * scrape-hiho-brewing.js
 *
 * HiHO Brewing Co. — a small craft brewery and taproom in downtown Cuyahoga
 * Falls (1707 Front St), overlooking the Cuyahoga River. Hosts trivia, live
 * music, and all-day music days ("Shakedown Street").
 *
 * Platform: Squarespace (native Events collection — ?format=json&view=upcoming),
 * so this reuses lib/squarespace.js exactly like Artisan Coffee / Rialto.
 *
 * Usage:   node scripts/scrape-hiho-brewing.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, enrichWithImageDimensions, upsertEventSafe,
  linkEventVenue, linkEventOrganization, ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import {
  fetchSquarespaceEvents, normaliseSquarespaceEvent, parseSquarespaceLocation, buildSquarespaceEventUrl,
} from './lib/squarespace.js'

const SITE_BASE_URL   = 'https://www.hihobrewingco.com'
const COLLECTION_URLS = [`${SITE_BASE_URL}/taproom-events`]
const SOURCE_KEY      = 'hiho_brewing'

const VENUE_NAME     = 'HiHO Brewing Co.'
const VENUE_FALLBACK = {
  address: '1707 Front St',
  city:    'Cuyahoga Falls',
  state:   'OH',
  zip:     '44221',
  website: SITE_BASE_URL,
}

const MUSIC_RE = /\b(live music|concert|acoustic|\bband\b|\bdj\b|songwriter|shakedown|open mic|karaoke)\b/i
const GAMES_RE = /\b(trivia|bingo|game night|euchre|cornhole|quizzo|pub quiz)\b/i

/** Brewery programming: music / games get a hint, everything else defers to inference. */
export function mapCategory(item) {
  const t = item.title || ''
  if (MUSIC_RE.test(t)) return 'music'
  if (GAMES_RE.test(t)) return 'games'
  return null
}

export function mapTags(item) {
  const t = item.title || ''
  const tags = ['brewery', 'hiho-brewing', 'cuyahoga-falls']
  if (MUSIC_RE.test(t)) tags.push('live-music')
  if (GAMES_RE.test(t)) tags.push('trivia')
  return [...new Set(tags)]
}

const venueCache = new Map()

async function ensureEventVenue(item, organizerId) {
  const loc  = parseSquarespaceLocation(item.location)
  const name = loc?.name || VENUE_NAME
  if (venueCache.has(name)) return venueCache.get(name)

  const venueId = await ensureVenue(name, {
    address: loc?.address ?? VENUE_FALLBACK.address,
    city:    loc?.city    ?? VENUE_FALLBACK.city,
    state:   loc?.state   ?? VENUE_FALLBACK.state,
    zip:     loc?.zip     ?? VENUE_FALLBACK.zip,
    lat:     loc?.lat     ?? null,
    lng:     loc?.lng     ?? null,
    website: SITE_BASE_URL,
  })
  if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
  venueCache.set(name, venueId)
  return venueId
}

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0
  for (const item of rawEvents) {
    try {
      const row = normaliseSquarespaceEvent(item, {
        source:          SOURCE_KEY,
        mapCategory,
        mapTags,
        defaultPriceMin: null, // never assume free
        defaultPriceMax: null,
        ageRestriction:  'all_ages',
      })
      row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url
      if (!row.start_at) { skipped++; continue }

      const venueId = await ensureEventVenue(item, organizerId)
      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) { console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message); skipped++; continue }
      if (venueId) await linkEventVenue(upserted.id, venueId)
      await linkEventOrganization(upserted.id, organizerId)
      inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing "${item.title}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

async function main() {
  console.log('🍺  Starting HiHO Brewing ingestion…')
  const start = Date.now()
  try {
    const organizerId = await ensureOrganization('HiHO Brewing Co.', {
      website:     SITE_BASE_URL,
      description: 'HiHO Brewing Co. is a craft brewery and taproom in downtown Cuyahoga Falls hosting trivia, live music, and community events.',
    })

    const allEvents = []
    for (const url of COLLECTION_URLS) {
      console.log(`\n🔍  Fetching ${url}…`)
      const events = await fetchSquarespaceEvents(url)
      console.log(`  Found ${events.length} upcoming events`)
      allEvents.push(...events)
    }

    console.log(`\n📥  Processing ${allEvents.length} events…`)
    const { inserted, skipped } = await processEvents(allEvents, organizerId)
    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: allEvents.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

export { SITE_BASE_URL, SOURCE_KEY }
