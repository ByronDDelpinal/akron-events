/**
 * scrape-mustard-seed.js
 *
 * Mustard Seed Market & Café — a beloved local natural-foods grocer whose
 * Highland Square café has a stage hosting regular live music (plus in-store
 * tastings, classes, and lectures). Exactly the kind of neighborhood
 * programming Akron Pulse exists to surface.
 *
 * Platform: WordPress + EventON 5 (post type `ajde_events`). EventON renders
 * its calendar client-side via Handlebars — the event dates are NOT in the
 * server HTML and the REST "get_events" action needs the calendar's internal
 * config, so a plain fetch can't see them. We therefore render the calendar
 * with Puppeteer to read each event's start/end (the `.eventon_list_event`
 * blocks carry a `data-time="<startUnix>-<endUnix>"`), then enrich every event
 * with its title, permalink, category, venue, and image from the clean WP REST
 * endpoint (`/wp-json/wp/v2/ajde_events?include=<ids>`), joining on event id.
 *
 * Two physical locations are disambiguated from EventON's `event_location-…`
 * class: the Highland Square café (867 W Market St — live-music venue) and the
 * Montrose store (3885 W Market St). Category is taken from the `event_type-…`
 * class where it maps cleanly, otherwise left null for text inference. Price is
 * left null (never assume free; the feed carries no price).
 *
 * Usage:  node scripts/scrape-mustard-seed.js
 * Env:    VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *         MUSTARD_SEED_MONTHS_AHEAD — months of calendar to page through (default 3)
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { withBrowser, newConfiguredPage } from './lib/puppeteer.js'
import {
  logUpsertResult, logScraperError, stripHtml, enrichWithImageDimensions,
  upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'

export const SOURCE_KEY = 'mustard_seed'

const CALENDAR_URL = 'https://www.mustardseedmarket.com/event-directory/'
const REST_BASE    = 'https://www.mustardseedmarket.com/wp-json/wp/v2/ajde_events'
const MONTHS_AHEAD  = Math.max(1, parseInt(process.env.MUSTARD_SEED_MONTHS_AHEAD || '3', 10) || 3)
const ORG_NAME      = 'Mustard Seed Market & Café'

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/**
 * Parse EventON's rendered list HTML into raw events.
 * Each `.eventon_list_event` block carries data-event_id and
 * data-time="<startUnix>-<endUnix>" (seconds). Returns one entry per block;
 * de-duplication across months is the caller's job.
 */
export function parseEventonList(html) {
  if (!html || typeof html !== 'string') return []
  const out = []
  const blocks = html.split('eventon_list_event').slice(1)
  for (const b of blocks) {
    const idM   = b.match(/data-event_id=["'](\d+)["']/)
    const timeM = b.match(/data-time=["'](\d+)-(\d+)["']/)
    if (!idM || !timeM) continue
    const start = parseInt(timeM[1], 10)
    const end   = parseInt(timeM[2], 10)
    if (!start) continue
    const titleM = b.match(/itemprop=["']name["'][^>]*>\s*([^<]+?)\s*</) ||
                   b.match(/class=["'][^"']*evcal_event_title[^"']*["'][^>]*>\s*([^<]+?)\s*</)
    out.push({
      id:    idM[1],
      start,                       // unix seconds (absolute / UTC)
      end:   end || null,
      title: titleM ? stripHtml(titleM[1]).trim() : null,
    })
  }
  return out
}

/** First `event_location-<slug>` found in a WP class_list array, or null. */
export function locationSlug(classList = []) {
  for (const c of classList) {
    const m = /^event_location-(.+)$/.exec(c)
    if (m) return m[1]
  }
  return null
}

/** First `event_type-<slug>` found in a WP class_list array, or null. */
export function typeSlug(classList = []) {
  for (const c of classList) {
    const m = /^event_type-(.+)$/.exec(c)
    if (m) return m[1]
  }
  return null
}

/**
 * Map an EventON location slug to a venue. Highland Square is the café stage
 * (a Highland Square neighborhood venue); Montrose is the west-side store.
 * Unknown/missing locations default to Highland Square — the calendar is
 * overwhelmingly café programming, and a known venue beats a guess.
 */
export function venueForLocation(slug) {
  if (slug && /montrose/.test(slug)) {
    return {
      name: 'Mustard Seed Market & Café – Montrose',
      details: {
        address: '3885 W Market St', city: 'Akron', state: 'OH', zip: '44333',
        website: 'https://www.mustardseedmarket.com',
      },
    }
  }
  return {
    name: 'Mustard Seed Market & Café – Highland Square',
    details: {
      address: '867 W Market St', city: 'Akron', state: 'OH', zip: '44303',
      neighborhood_slug: 'highland-square',
      website: 'https://www.mustardseedmarket.com',
    },
  }
}

/**
 * Map an EventON type slug to a v2 category hint. Only confident mappings are
 * returned; everything else is null so title-based inference decides.
 */
export function mapCategory(slug) {
  if (!slug) return null
  if (/music|concert|live/.test(slug)) return 'music'
  if (/class|lecture|education|workshop|seminar/.test(slug)) return 'learning'
  return null
}

/** Build an event row from a parsed date entry + its REST metadata. */
export function buildRow(dateEntry, meta = {}) {
  const title = stripHtml(meta.title || dateEntry.title || '').trim()
  if (!title || !dateEntry.start) return null
  const venue = venueForLocation(locationSlug(meta.class_list))
  return {
    row: {
      title,
      description: null,
      start_at: new Date(dateEntry.start * 1000).toISOString(),
      end_at:   dateEntry.end ? new Date(dateEntry.end * 1000).toISOString() : null,
      category: mapCategory(typeSlug(meta.class_list)),
      tags: ['mustard-seed', 'highland-square'],
      price_min: null,           // never assume free
      price_max: null,
      age_restriction: 'all_ages',
      image_url: meta.image_url || null,
      ticket_url: meta.link || null,
      source: SOURCE_KEY,
      source_id: `mustard_seed_${dateEntry.id}_${dateEntry.start}`,
      status: 'published',
      featured: false,
    },
    venue,
  }
}

// ── Network / browser steps ──────────────────────────────────────────────────

/**
 * Render the EventON calendar and page forward `monthsAhead` months, capturing
 * the list HTML at each step. Returns a de-duplicated map of id → { start, end,
 * title } across all captured months.
 */
async function collectEventDates(monthsAhead) {
  const htmls = await withBrowser(async (browser) => {
    const page = await newConfiguredPage(browser)
    const captured = []
    await page.goto(CALENDAR_URL, { waitUntil: 'networkidle2', timeout: 30_000 })
    // The first month may legitimately be empty; don't fail if the selector
    // never appears — just capture whatever rendered.
    try {
      await page.waitForSelector('.eventon_list_event', { timeout: 8_000 })
    } catch { /* empty month — continue */ }
    captured.push(await page.content())

    for (let i = 1; i < monthsAhead; i++) {
      const next = await page.$('#evcal_next')
      if (!next) break
      await next.click()
      // EventON re-renders the list via AJAX; give it time to settle.
      await new Promise((r) => setTimeout(r, 2_000))
      captured.push(await page.content())
    }
    return captured
  })

  const byId = new Map()
  for (const html of htmls) {
    for (const ev of parseEventonList(html)) {
      // Key by id+start so a recurring series' distinct dates are all kept.
      byId.set(`${ev.id}_${ev.start}`, ev)
    }
  }
  return [...byId.values()]
}

/**
 * Fetch WP REST metadata (title, permalink, taxonomy class_list, featured
 * image) for the given event ids. Returns a map id → meta.
 */
async function fetchEventMeta(ids) {
  const map = new Map()
  if (!ids.length) return map
  const url = `${REST_BASE}?include=${ids.join(',')}&per_page=100&_embed=wp:featuredmedia`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'AkronPulse-bot/1.0 (+https://akronpulse.com)' },
  })
  if (!res.ok) throw new Error(`WP REST ajde_events HTTP ${res.status}`)
  const arr = await res.json()
  for (const e of arr) {
    map.set(String(e.id), {
      title: e.title?.rendered ?? null,
      link: e.link ?? null,
      class_list: Array.isArray(e.class_list) ? e.class_list : [],
      image_url: e._embedded?.['wp:featuredmedia']?.[0]?.source_url ?? null,
    })
  }
  return map
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱  Starting Mustard Seed (EventON) scrape…')
  const start = Date.now()

  try {
    const dateEntries = await collectEventDates(MONTHS_AHEAD)
    console.log(`  Rendered calendar → ${dateEntries.length} dated events across ${MONTHS_AHEAD} month(s)`)
    if (!dateEntries.length) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, { eventsFound: 0, durationMs: Date.now() - start })
      console.log('✅  No events found (empty calendar) — done.')
      return
    }

    const ids  = [...new Set(dateEntries.map((e) => e.id))]
    const meta = await fetchEventMeta(ids)
    console.log(`  Fetched REST metadata for ${meta.size}/${ids.length} events`)

    const org = await ensureOrganization(ORG_NAME, {
      website: 'https://www.mustardseedmarket.com',
      description: 'Mustard Seed Market & Café is an Akron natural and organic grocer and café, hosting live music, tastings, and educational events at its Highland Square and Montrose locations.',
    })

    const nowMs = Date.now()
    const cutoffPast = nowMs - 86_400_000        // keep today + future
    const venueCache = new Map()
    let inserted = 0, skipped = 0

    for (const entry of dateEntries) {
      try {
        const built = buildRow(entry, meta.get(entry.id))
        if (!built) { skipped++; continue }
        if (Date.parse(built.row.start_at) < cutoffPast) { skipped++; continue }

        const enriched = await enrichWithImageDimensions(built.row)
        const { data: upserted, error } = await upsertEventSafe(enriched)
        if (error) { console.warn(`  ⚠ Upsert failed "${built.row.title}": ${error.message}`); skipped++; continue }

        const vKey = built.venue.name
        let venueId = venueCache.get(vKey)
        if (venueId === undefined) {
          venueId = await ensureVenue(built.venue.name, built.venue.details)
          venueCache.set(vKey, venueId)
          if (org && venueId) await linkOrganizationVenue(org, venueId)
        }
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (org)     await linkEventOrganization(upserted.id, org)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on event ${entry.id}: ${err.message}`)
        skipped++
      }
    }

    const durationMs = Date.now() - start
    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: dateEntries.length, durationMs })
    console.log(`✅  Mustard Seed: ${inserted} posted, ${skipped} skipped in ${(durationMs / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
