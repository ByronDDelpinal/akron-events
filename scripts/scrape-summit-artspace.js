/**
 * scrape-summit-artspace.js
 *
 * Fetches upcoming events from Summit Artspace (summitartspace.org) via
 * The Events Calendar (Tribe) REST API — no HTML scraping needed.
 *
 * Usage:
 *   node scripts/scrape-summit-artspace.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError } from './lib/normalize.js'

const BASE_URL   = 'https://www.summitartspace.org/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180   // 6 months out

// ── Helpers ───────────────────────────────────────────────────────────────

/** Strip HTML tags from description text */
function stripHtml(html = '') {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse price from Tribe cost_details or cost string */
function parseCost(cost = '', costDetails = {}) {
  const values = costDetails.values ?? []

  if (values.length) {
    const nums = values.map(Number).filter(n => !isNaN(n))
    if (nums.length) {
      const min = Math.min(...nums)
      const max = Math.max(...nums)
      return { price_min: min, price_max: max > min ? max : null }
    }
  }

  // Fallback: parse the human-readable cost string
  if (!cost || cost.toLowerCase().includes('free')) {
    return { price_min: 0, price_max: null }
  }

  const numbers = cost.match(/\d+(\.\d+)?/g)?.map(Number)
  if (!numbers?.length) return { price_min: 0, price_max: null }

  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  return { price_min: min, price_max: max > min ? max : null }
}

/** Extract the first usable image URL from the Tribe image object or description HTML */
function parseImage(imageObj, descriptionHtml = '') {
  // Tribe API `image` field
  if (imageObj && imageObj.url) return imageObj.url

  // Fall back to first <img> src in description
  const match = descriptionHtml.match(/<img[^>]+src="([^"]+)"/)
  return match?.[1] ?? null
}

/** Map Tribe category slugs → our category enum */
function parseCategory(categories = []) {
  const slugs = categories.map(c => c.slug?.toLowerCase() ?? '')

  if (slugs.some(s => s.includes('music') || s.includes('concert') || s.includes('perform'))) return 'music'
  if (slugs.some(s => s.includes('art') || s.includes('exhibit') || s.includes('gallery'))) return 'art'
  if (slugs.some(s => s.includes('food') || s.includes('market') || s.includes('culinary'))) return 'food'
  if (slugs.some(s => s.includes('sport') || s.includes('fitness') || s.includes('run'))) return 'sports'
  if (slugs.some(s => s.includes('educat') || s.includes('workshop') || s.includes('class'))) return 'education'
  if (slugs.some(s => s.includes('nonprofit') || s.includes('fundrais') || s.includes('benefit'))) return 'nonprofit'
  if (slugs.some(s => s.includes('communit') || s.includes('family'))) return 'community'

  // Summit Artspace is primarily an arts org — default to 'art'
  return 'art'
}

/** Combine Tribe categories + tags into our tags array */
function parseTags(categories = [], tags = []) {
  const all = [
    ...categories.map(c => c.name?.toLowerCase()).filter(Boolean),
    ...tags.map(t => t.name?.toLowerCase()).filter(Boolean),
  ]
  return [...new Set(all)]
}

// ── Venue lookup ──────────────────────────────────────────────────────────

/** Find or create Summit Artspace venue */
async function ensureVenue() {
  const { data: existing } = await supabaseAdmin
    .from('venues')
    .select('id')
    .eq('name', 'Summit Artspace')
    .maybeSingle()

  if (existing) return existing.id

  const { data, error } = await supabaseAdmin
    .from('venues')
    .insert({
      name:         'Summit Artspace',
      address:      '140 E Market St',
      city:         'Akron',
      state:        'OH',
      zip:          '44308',
      lat:          41.0821,
      lng:          -81.5148,
      parking_type: 'street',
      website:      'https://www.summitartspace.org',
    })
    .select('id')
    .single()

  if (error) {
    console.warn('  ⚠ Could not create Summit Artspace venue:', error.message)
    return null
  }

  console.log('  ✚ Created Summit Artspace venue')
  return data.id
}

// ── Organizer lookup ──────────────────────────────────────────────────────

/** Find or create Summit Artspace organizer */
async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers')
    .select('id')
    .eq('name', 'Summit Artspace')
    .maybeSingle()

  if (existing) return existing.id

  const { data, error } = await supabaseAdmin
    .from('organizers')
    .insert({
      name:        'Summit Artspace',
      website:     'https://www.summitartspace.org',
      description: 'Summit Artspace is a multi-disciplinary arts center in downtown Akron, OH.',
      image_url:   null,
    })
    .select('id')
    .single()

  if (error) {
    console.warn('  ⚠ Could not create Summit Artspace organizer:', error.message)
    return null
  }

  console.log('  ✚ Created Summit Artspace organizer')
  return data.id
}

// ── Fetch all pages ───────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = new Date().toISOString().split('T')[0]
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page     = 1
  let hasMore  = true
  const all    = []

  console.log(`\n🔍  Fetching Summit Artspace events via Tribe REST API…`)

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

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Summit Artspace API error ${res.status}: ${body}`)
    }

    const data   = await res.json()
    const events = data.events ?? []

    all.push(...events)
    console.log(`  Page ${page}/${data.total_pages}: ${events.length} events (total: ${all.length})`)

    hasMore = page < (data.total_pages ?? 1)
    page++

    if (hasMore) await new Promise(r => setTimeout(r, 200))
  }

  return all
}

// ── Process events ────────────────────────────────────────────────────────

async function processEvents(rawEvents, venueId, organizerId) {
  let inserted = 0
  let skipped  = 0

  for (const ev of rawEvents) {
    try {
      const { price_min, price_max } = parseCost(ev.cost, ev.cost_details)
      const category  = parseCategory(ev.categories)
      const tags      = parseTags(ev.categories, ev.tags)
      const imageUrl  = parseImage(ev.image, ev.description)
      const descText  = stripHtml(ev.description)

      // Prefer the event's own venue if it has one; fall back to Summit Artspace
      let eventVenueId = venueId
      if (ev.venue && ev.venue.id) {
        const v = ev.venue
        const { data: existingV } = await supabaseAdmin
          .from('venues')
          .select('id')
          .eq('name', v.venue)
          .maybeSingle()

        if (existingV) {
          eventVenueId = existingV.id
        } else {
          const { data: newV } = await supabaseAdmin
            .from('venues')
            .insert({
              name:         v.venue,
              address:      v.address ?? null,
              city:         v.city ?? 'Akron',
              state:        v.stateprovince ?? 'OH',
              zip:          v.zip ?? null,
              lat:          v.geo_lat ? parseFloat(v.geo_lat) : null,
              lng:          v.geo_lng ? parseFloat(v.geo_lng) : null,
              parking_type: 'unknown',
              website:      v.website ?? null,
            })
            .select('id')
            .single()

          if (newV) eventVenueId = newV.id
        }
      }

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
        end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
        venue_id:        eventVenueId,
        organizer_id:    organizerId,
        category,
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ev.website || null,
        source:          'summit_artspace',
        source_id:       String(ev.id),
        status:          'published',
        featured:        ev.featured ?? false,
      }

      if (!row.start_at) { skipped++; continue }

      const { error } = await supabaseAdmin
        .from('events')
        .upsert(row, { onConflict: 'source,source_id', ignoreDuplicates: false })

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
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
  console.log('🚀  Starting Summit Artspace ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([
      ensureVenue(),
      ensureOrganizer(),
    ])

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    const { inserted, skipped } = await processEvents(rawEvents, venueId, organizerId)
    await logUpsertResult('summit_artspace', inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('summit_artspace', err, start)
    process.exit(1)
  }
}

main()
