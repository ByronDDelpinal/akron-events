/**
 * scrape-nightlight.js
 *
 * Fetches upcoming events from The Nightlight Cinema (nightlightcinema.com) via
 * The Events Calendar (Tribe) REST API — same platform as Summit Artspace.
 *
 * Usage:
 *   node scripts/scrape-nightlight.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import {
  logUpsertResult, logScraperError, stripHtml, enrichWithImageDimensions, upsertEventSafe,
  linkEventVenue, linkEventOrganization, ensureVenue, linkOrganizationVenue,
  parseCostFromTribe, parseTagsFromTribe, ensureOrganization,
} from './lib/normalize.js'

const BASE_URL   = 'https://nightlightcinema.com/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180

/**
 * Sentinel error class for when the source is blocking our requests.
 * We catch this separately and exit 0 so `scrape:all` keeps running.
 */
class BlockedError extends Error {
  constructor(msg) { super(msg); this.name = 'BlockedError' }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  const match = descriptionHtml.match(/<img[^>]+src="([^"]+)"/)
  return match?.[1] ?? null
}

/** The Nightlight is a cinema and cultural arts venue — most events are 'art' */
function parseCategory(categories = [], title = '') {
  const slugs = categories.map(c => c.slug?.toLowerCase() ?? '')
  const t = title.toLowerCase()

  if (slugs.some(s => s.includes('music') || s.includes('concert'))) return 'music'
  if (slugs.some(s => s.includes('food') || s.includes('drink'))) return 'food'
  if (slugs.some(s => s.includes('educat') || s.includes('workshop') || s.includes('class'))) return 'education'
  if (slugs.some(s => s.includes('communit') || s.includes('family'))) return 'community'
  if (t.includes('fundrais') || t.includes('benefit') || t.includes('gala')) return 'nonprofit'

  // Default: cinema is art
  return 'art'
}


// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = new Date().toISOString().split('T')[0]
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]
  let page = 1, hasMore = true
  const all = []

  console.log('\n🔍  Fetching Nightlight events via Tribe REST API…')

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetch(url.toString(), {
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
      },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`Nightlight API error ${res.status}: ${await res.text()}`)

    const text = await res.text()
    if (text.trimStart().startsWith('<')) {
      // The site is behind Cloudflare or has disabled its REST API endpoint.
      // We treat this as a known "blocked" condition rather than a hard error
      // so that `scrape:all` can continue running the other scrapers.
      throw new BlockedError(`Nightlight API returned HTML — site is blocking automated requests.`)
    }
    const data = JSON.parse(text)
    const events = data.events ?? []
    all.push(...events)
    console.log(`  Page ${page}/${data.total_pages}: ${events.length} events (total: ${all.length})`)

    hasMore = page < (data.total_pages ?? 1)
    page++
    if (hasMore) await new Promise(r => setTimeout(r, 200))
  }
  return all
}

// ── Process ───────────────────────────────────────────────────────────────

async function processEvents(rawEvents, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const category = parseCategory(ev.categories, ev.title)
      const tags     = parseTagsFromTribe(ev.categories, ev.tags, ['film', 'cinema'])
      const imageUrl = parseImage(ev.image, ev.description)
      const descText = stripHtml(ev.description)

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
        end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
        category,
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ev.website || null,
        source:          'nightlight_cinema',
        source_id:       String(ev.id),
        status:          'published',
        featured:        ev.featured ?? false,
      }

      if (!row.start_at) { skipped++; continue }

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
  console.log('🚀  Starting Nightlight Cinema ingestion…')
  const start = Date.now()

  try {
    const venueId = await ensureVenue('The Nightlight Cinema', {
      address:      '30 N High St',
      city:         'Akron',
      state:        'OH',
      zip:          '44308',
      lat:          41.0851,
      lng:          -81.5193,
      parking_type: 'street',
      parking_notes: 'Street parking on N High St and Bowery St.',
      website:      'https://nightlightcinema.com',
      description:  'Akron\'s independent cinema and cultural venue in the heart of downtown.',
    })

    const organizerId = await ensureOrganization('The Nightlight Cinema', {
      website:     'https://nightlightcinema.com',
      description: 'Independent cinema and arts venue in downtown Akron, OH.',
    })

    await linkOrganizationVenue(organizerId, venueId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, venueId, organizerId)
    logUpsertResult('nightlight_cinema', inserted, 0, skipped)
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    if (err instanceof BlockedError) {
      // Not a bug — the site is actively blocking scrapers.
      // Log to scraper_runs so the health dashboard shows the problem,
      // but exit 0 so `scrape:all` continues with the remaining scrapers.
      console.warn('\n⚠  Nightlight Cinema:', err.message)
      console.warn('   This source requires manual intervention or an alternative approach.')
      await logUpsertResult('nightlight_cinema', 0, 0, 0, {
        status:       'error',
        errorMessage: err.message,
        durationMs:   Date.now() - start,
        eventsFound:  0,
      })
      process.exit(0)
    }

    await logScraperError('nightlight_cinema', err, start)
    process.exit(1)
  }
}

main()
