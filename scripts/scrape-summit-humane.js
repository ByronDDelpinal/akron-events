/**
 * scrape-summit-humane.js
 *
 * Humane Society of Summit County (Akron / Twinsburg) — its public "Community
 * Events": dine-to-donate nights, fundraiser yoga, adoption events, benefit
 * walks. First-party source; qualifies for the Give Back facet.
 *
 * Platform: WordPress + The Events Calendar (Tribe) REST API.
 *   https://summithumane.org/wp-json/tribe/events/v1/events
 *
 * Two quirks handled here:
 *   1. Venues vary per event (Texas Roadhouse in Stow, the shelter's Community
 *      Room, etc.) and arrive as a Tribe `venue` object — we resolve each one,
 *      falling back to the shelter when absent.
 *   2. Descriptions are WPBakery Page Builder shortcode soup ([vc_row]…[/vc_row]),
 *      which stripHtml alone leaves as bracket noise — cleanDescription strips
 *      the shortcodes first, then falls back to the page's schema description.
 *
 * Usage:   node scripts/scrape-summit-humane.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, fetchSchemaDescription,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  parseCostFromTribe, parseTagsFromTribe,
  easternTodayIso,
} from './lib/normalize.js'

export const SOURCE_KEY = 'summit_humane'
const BASE_URL   = 'https://summithumane.org/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 365

const ORG_NAME = 'Humane Society of Summit County'
const DEFAULT_VENUE = {
  name: 'Humane Society of Summit County',
  address: '752 West Portage Trail', city: 'Akron', state: 'OH', zip: '44313',
  website: 'https://summithumane.org',
  description: 'The Humane Society of Summit County animal shelter in Akron.',
}

// ── Pure parsers (exported for tests) ────────────────────────────────────────

/** Strip WPBakery [shortcodes] before stripHtml so the description is readable. */
export function cleanDescription(html) {
  if (!html) return null
  const withoutShortcodes = String(html).replace(/\[[^\]]*\]/g, ' ')
  const text = stripHtml(withoutShortcodes).replace(/\s{2,}/g, ' ').trim()
  return text || null
}

/** Resolve the Tribe venue object → { name, details }, or null to use default. */
export function parseVenue(venueObj) {
  if (!venueObj || Array.isArray(venueObj) || !venueObj.venue) return null
  return {
    name: venueObj.venue,
    details: {
      address: venueObj.address || null,
      city:    venueObj.city || null,
      state:   venueObj.state || venueObj.province || venueObj.stateprovince || 'OH',
      zip:     venueObj.zip || null,
    },
  }
}

/** Light content category; the Give Back facet is carried by tags regardless. */
export function parseCategory(ev) {
  const text = `${ev.title ?? ''} ${cleanDescription(ev.description) ?? ''}`.toLowerCase()
  if (/\byoga\b|\b5k\b|\b10k\b|\brun\b|\bwalk\b|fitness/.test(text)) return 'fitness'
  if (/dine to donate|dinner|breakfast|brunch|food truck|tasting/.test(text)) return 'food'
  return null
}

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
  console.log('\n🔍  Fetching Humane Society events via Tribe REST API…')

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)' },
      redirect: 'follow',
    })
    if (res.status === 400) break
    if (!res.ok) throw new Error(`Humane Society API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

    const data   = await res.json()
    const events = data.events ?? []
    all.push(...events)
    console.log(`  Page ${page}/${data.total_pages ?? 1}: ${events.length} events (total: ${all.length})`)

    hasMore = page < (data.total_pages ?? 1)
    page++
    if (hasMore) await new Promise((r) => setTimeout(r, 200))
  }
  return all
}

// ── Process ──────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, defaultVenueId, organizerId) {
  let inserted = 0, skipped = 0
  const venueCache = new Map()

  for (const ev of rawEvents) {
    try {
      const startAt = ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null
      if (!startAt) { skipped++; continue }

      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const tags = parseTagsFromTribe(ev.categories, ev.tags,
        ['give-back', 'fundraiser', 'humane-society', 'animals'])
      const imageUrl = parseImage(ev.image, ev.description)

      let descText = cleanDescription(ev.description)
      if (!descText && ev.url) descText = (await fetchSchemaDescription(ev.url)) ?? ''

      // Resolve this event's venue (varies), caching by name.
      let venueId = defaultVenueId
      const v = parseVenue(ev.venue)
      if (v) {
        if (venueCache.has(v.name)) venueId = venueCache.get(v.name)
        else {
          venueId = await ensureVenue(v.name, v.details)
          venueCache.set(v.name, venueId)
        }
      }

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        startAt,
        end_at:          ev.utc_end_date ? ev.utc_end_date.replace(' ', 'T') + 'Z' : null,
        category:        parseCategory(ev),
        tags,
        price_min,
        price_max,
        age_restriction: 'all_ages',
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
        if (venueId)     await linkEventVenue(upserted.id, venueId)
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
  console.log('🐾  Starting Humane Society of Summit County ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization(ORG_NAME, {
      website: 'https://summithumane.org',
      description: 'The Humane Society of Summit County — animal shelter and adoption center serving Summit County.',
    })
    const defaultVenueId = await ensureVenue(DEFAULT_VENUE.name, DEFAULT_VENUE)
    if (organizerId && defaultVenueId) await linkOrganizationVenue(organizerId, defaultVenueId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, defaultVenueId, organizerId)

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
