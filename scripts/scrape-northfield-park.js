/**
 * scrape-northfield-park.js
 *
 * Northfield Park Racino — MGM Northfield Park's live entertainment (Center
 * Stage concerts & comedy) in Northfield, at the far-north edge of Summit
 * County. This is the venue's OWN calendar, so it is the first-party source for
 * these shows; Ticketmaster also lists many of them, and pinning every event to
 * the canonical "Northfield Park Racino - Center Stage" venue lets the shared
 * cross-source dedupe collapse the Ticketmaster copies onto this first-party
 * row (see SOURCE_PRIORITY — northfield_park outranks ticketmaster). That is the
 * point: replace aggregator copies with the venue's own data.
 *
 * Platform: WordPress + The Events Calendar (Tribe) REST API.
 *   https://northfieldparkracino.com/wp-json/tribe/events/v1/events
 *
 * CRITICAL FILTER: the same feed is dominated by casino gaming PROMOTIONS
 * (category "promotions": free-play kiosks, point multipliers, invite-only
 * offers) — ~44 of ~50 rows. Those are not community events. We ingest ONLY the
 * "entertainment" category (the ticketed concerts/comedy at Center Stage).
 *
 * Usage:   node scripts/scrape-northfield-park.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, fetchSchemaDescription,
  enrichWithImageDimensions, upsertEventSafe, setEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  parseCostFromTribe, parseTagsFromTribe,
  easternTodayIso,
} from './lib/normalize.js'

export const SOURCE_KEY = 'northfield_park'
const BASE_URL   = 'https://northfieldparkracino.com/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 365

const ORG_NAME = 'Northfield Park Racino'
const RACINO = {
  address: '10777 Northfield Rd', city: 'Northfield', state: 'OH', zip: '44067',
  website: 'https://northfieldparkracino.com',
}
const CENTER_STAGE_NAME = 'Northfield Park Racino - Center Stage'
const CENTER_STAGE_DETAILS = { ...RACINO, description: 'Center Stage is the ticketed concert & comedy hall at MGM Northfield Park.' }

// ── Pure parsers (exported for tests) ────────────────────────────────────────

/** Only the "entertainment" category is a community event; drop casino promos. */
export function isEntertainment(ev) {
  return (ev?.categories ?? []).some((c) => (c.slug ?? '').toLowerCase() === 'entertainment')
}

/**
 * Resolve the Tribe venue (the ROOM) → { name, details }. The feed uses per-room
 * venues: "Center Stage" (the ticketed concert hall) and "Neon Room" (the lounge
 * that hosts the free live-music series), among others. Center Stage maps to the
 * exact name Ticketmaster uses so the two sources dedupe onto one venue; any
 * other room becomes "Northfield Park Racino - <Room>"; a missing room pins to
 * the property itself — never assume Center Stage (the earlier bug that put the
 * free Neon Room acts in the ticketed concert hall).
 */
export function resolveVenue(ev) {
  const raw = ev && ev.venue && !Array.isArray(ev.venue) && ev.venue.venue
    ? String(ev.venue.venue).trim() : ''
  if (/center\s*stage/i.test(raw)) return { name: CENTER_STAGE_NAME, details: CENTER_STAGE_DETAILS }
  if (raw) return { name: `Northfield Park Racino - ${raw}`, details: RACINO }
  return { name: 'Northfield Park Racino', details: RACINO }
}

/** Comedy vs. music from title/description/categories; default music (concerts). */
export function parseCategory(ev) {
  const text = `${ev.title ?? ''} ${stripHtml(ev.description ?? '')} ${(ev.categories ?? []).map((c) => c.name).join(' ')}`.toLowerCase()
  if (/\bcomedy\b|comedian|stand-?up/.test(text)) return 'comedy'
  return 'music'
}

/** Stable per-occurrence source_id (Tribe recurring series can repeat ids). */
export function buildSourceId(ev) {
  const day = (ev.start_date ?? ev.utc_start_date ?? '').slice(0, 10)
  return day ? `${ev.id}-${day}` : String(ev.id)
}

function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  return descriptionHtml.match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = easternTodayIso()
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page = 1, hasMore = true
  const all = []
  console.log('\n🔍  Fetching Northfield Park events via Tribe REST API…')

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')
    url.searchParams.set('categories', 'entertainment')   // server-side filter…

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)' },
      redirect: 'follow',
    })
    if (res.status === 400) break   // Tribe returns 400 "no results" on an empty window
    if (!res.ok) throw new Error(`Northfield Park API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

    const data   = await res.json()
    const events = data.events ?? []
    all.push(...events)
    console.log(`  Page ${page}/${data.total_pages ?? 1}: ${events.length} events (total: ${all.length})`)

    hasMore = page < (data.total_pages ?? 1)
    page++
    if (hasMore) await new Promise((r) => setTimeout(r, 200))
  }
  // …plus a client-side guard in case the category param is ignored.
  return all.filter(isEntertainment)
}

// ── Process ──────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0
  const venueCache = new Map()

  for (const ev of rawEvents) {
    try {
      const startAt = ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null
      if (!startAt) { skipped++; continue }

      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const tags = parseTagsFromTribe(ev.categories, ev.tags, ['northfield', 'concert', 'live-music'])
      const imageUrl = parseImage(ev.image, ev.description)

      let descText = stripHtml(ev.description)
      if (!descText && ev.url) descText = (await fetchSchemaDescription(ev.url)) ?? ''

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        startAt,
        end_at:          ev.utc_end_date ? ev.utc_end_date.replace(' ', 'T') + 'Z' : null,
        category:        parseCategory(ev),
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ev.website || ev.url || null,
        source:          SOURCE_KEY,
        source_id:       buildSourceId(ev),
        status:          'published',
        featured:        ev.featured ?? false,
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        // Resolve this event's actual room (Center Stage vs. the Neon Room
        // lounge, etc.). setEventVenue replaces any stale link, so re-running
        // corrects rows a previous version wrongly pinned to Center Stage.
        const v = resolveVenue(ev)
        let venueId = venueCache.get(v.name)
        if (venueId === undefined) {
          venueId = await ensureVenue(v.name, v.details)
          venueCache.set(v.name, venueId)
        }
        if (venueId)     await setEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎰  Starting Northfield Park ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization(ORG_NAME, {
      website: 'https://northfieldparkracino.com',
      description: 'MGM Northfield Park is a racino in Northfield, Summit County, whose Center Stage hosts touring concerts and comedy.',
    })
    // Pre-create the canonical Center Stage venue + link it to the org (most
    // ticketed shows are there); other rooms are ensured per-event below.
    const centerStageId = await ensureVenue(CENTER_STAGE_NAME, CENTER_STAGE_DETAILS)
    if (organizerId && centerStageId) await linkOrganizationVenue(organizerId, centerStageId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} entertainment events…`)
    const { inserted, skipped } = await processEvents(rawEvents, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
