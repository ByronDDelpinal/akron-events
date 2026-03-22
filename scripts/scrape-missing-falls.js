/**
 * scrape-missing-falls.js
 *
 * Fetches upcoming events from Missing Falls Brewery (missingfallsbrewery.com)
 * via The Events Calendar (Tribe) REST API — same platform as Summit Artspace.
 *
 * NOTE: Missing Falls is a smaller venue and may have zero or few upcoming events
 * at any given time. The scraper will log a "zero events" result to scraper_runs
 * which the health dashboard will track. This is expected behavior, not a bug —
 * a zero streak of ≥2 runs will surface as a warning in the health view.
 *
 * Usage:
 *   node scripts/scrape-missing-falls.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError } from './lib/normalize.js'

const BASE_URL   = 'https://missingfallsbrewery.com/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180

// ── Helpers ───────────────────────────────────────────────────────────────

function stripHtml(html = '') {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
    .replace(/\s+/g, ' ').trim()
}

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
  if (!cost || cost.toLowerCase().includes('free')) return { price_min: 0, price_max: null }
  const numbers = cost.match(/\d+(\.\d+)?/g)?.map(Number)
  if (!numbers?.length) return { price_min: 0, price_max: null }
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  return { price_min: min, price_max: max > min ? max : null }
}

function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  const match = descriptionHtml.match(/<img[^>]+src="([^"]+)"/)
  return match?.[1] ?? null
}

function parseCategory(categories = [], title = '') {
  const slugs = categories.map(c => c.slug?.toLowerCase() ?? '')
  const t = title.toLowerCase()
  if (slugs.some(s => s.includes('music') || s.includes('concert') || s.includes('live'))) return 'music'
  if (slugs.some(s => s.includes('trivia') || s.includes('game') || s.includes('bingo'))) return 'community'
  if (slugs.some(s => s.includes('art') || s.includes('comedy') || s.includes('show'))) return 'art'
  if (slugs.some(s => s.includes('food') || s.includes('tasting') || s.includes('pairing'))) return 'food'
  if (slugs.some(s => s.includes('sport') || s.includes('fitness') || s.includes('run'))) return 'sports'
  if (t.includes('trivia') || t.includes('bingo') || t.includes('game night')) return 'community'
  if (t.includes('live') || t.includes('music') || t.includes('band') || t.includes('dj')) return 'music'
  // Brewery events default to community
  return 'community'
}

function parseTags(categories = [], tags = []) {
  const all = [
    ...categories.map(c => c.name?.toLowerCase()).filter(Boolean),
    ...tags.map(t => t.name?.toLowerCase()).filter(Boolean),
    'brewery', 'akron',
  ]
  return [...new Set(all)]
}

// ── Venue / Organizer ─────────────────────────────────────────────────────

async function ensureVenue() {
  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', 'Missing Falls Brewery').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:         'Missing Falls Brewery',
    address:      '1250 Triplett Blvd',
    city:         'Akron',
    state:        'OH',
    zip:          '44306',
    lat:          41.0601,
    lng:          -81.4958,
    parking_type: 'lot',
    parking_notes: 'Free lot parking on site.',
    website:      'https://missingfallsbrewery.com',
    description:  'Craft brewery and taproom in Akron, OH.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Missing Falls venue:', error.message); return null }
  console.log('  ✚ Created Missing Falls Brewery venue')
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'Missing Falls Brewery').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:    'Missing Falls Brewery',
    website: 'https://missingfallsbrewery.com',
    description: 'Craft brewery and community events venue in Akron, OH.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Missing Falls organizer:', error.message); return null }
  console.log('  ✚ Created Missing Falls Brewery organizer')
  return data.id
}

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = new Date().toISOString().split('T')[0]
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]
  let page = 1, hasMore = true
  const all = []

  console.log('\n🔍  Fetching Missing Falls events via Tribe REST API…')

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
      throw new Error(`Missing Falls API error ${res.status}: ${body.slice(0, 200)}`)
    }

    const text = await res.text()
    if (text.trimStart().startsWith('<')) {
      throw new Error('Missing Falls API returned HTML — endpoint may be unavailable.')
    }

    const data = JSON.parse(text)
    const events = data.events ?? []
    all.push(...events)
    console.log(`  Page ${page}/${data.total_pages ?? 1}: ${events.length} events (total: ${all.length})`)

    hasMore = page < (data.total_pages ?? 1)
    page++
    if (hasMore) await new Promise(r => setTimeout(r, 200))
  }

  return all
}

// ── Process ───────────────────────────────────────────────────────────────

async function processEvents(rawEvents, venueId, organizerId) {
  let inserted = 0, updated = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      const { price_min, price_max } = parseCost(ev.cost, ev.cost_details)
      const category = parseCategory(ev.categories, ev.title)
      const tags     = parseTags(ev.categories, ev.tags)
      const imageUrl = parseImage(ev.image, ev.description)
      const descText = stripHtml(ev.description)

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
        end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
        venue_id:        venueId,
        organizer_id:    organizerId,
        category,
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ev.website || null,
        source:          'missing_falls',
        source_id:       String(ev.id),
        status:          'published',
        featured:        ev.featured ?? false,
      }

      if (!row.start_at) { skipped++; continue }

      const { error } = await supabaseAdmin
        .from('events')
        .upsert(row, { onConflict: 'source,source_id', ignoreDuplicates: false })

      if (error) { console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message); skipped++ }
      else inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.title ?? '?'}":`, err.message)
      skipped++
    }
  }

  return { inserted, updated, skipped }
}

// ── Entry point ───────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Missing Falls Brewery ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureVenue(), ensureOrganizer()])
    const rawEvents = await fetchAllPages()

    if (rawEvents.length === 0) {
      console.log('\n  ℹ  No upcoming events found — this is normal for this venue.')
    } else {
      console.log(`\n📥  Processing ${rawEvents.length} events…`)
    }

    const { inserted, updated, skipped } = await processEvents(rawEvents, venueId, organizerId)
    await logUpsertResult('missing_falls', inserted, updated, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('missing_falls', err, start)
    process.exit(1)
  }
}

main()
