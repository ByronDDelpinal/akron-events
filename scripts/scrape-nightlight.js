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
import { logUpsertResult } from './lib/normalize.js'

const BASE_URL   = 'https://nightlightcinema.com/wp-json/tribe/events/v1/events'
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

function parseTags(categories = [], tags = []) {
  const all = [
    ...categories.map(c => c.name?.toLowerCase()).filter(Boolean),
    ...tags.map(t => t.name?.toLowerCase()).filter(Boolean),
    'film', 'cinema',
  ]
  return [...new Set(all)]
}

// ── Venue / Organizer ─────────────────────────────────────────────────────

async function ensureVenue() {
  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', 'The Nightlight Cinema').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:         'The Nightlight Cinema',
    address:      '30 N High St',
    city:         'Akron',
    state:        'OH',
    zip:          '44308',
    lat:          41.0851,
    lng:          -81.5193,
    parking_type: 'street',
    parking_notes:'Street parking on N High St and Bowery St.',
    website:      'https://nightlightcinema.com',
    description:  'Akron\'s independent cinema and cultural venue in the heart of downtown.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Nightlight venue:', error.message); return null }
  console.log('  ✚ Created The Nightlight Cinema venue')
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'The Nightlight Cinema').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:    'The Nightlight Cinema',
    website: 'https://nightlightcinema.com',
    description: 'Independent cinema and arts venue in downtown Akron, OH.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Nightlight organizer:', error.message); return null }
  console.log('  ✚ Created The Nightlight Cinema organizer')
  return data.id
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
      throw new Error(`Nightlight API returned HTML instead of JSON — the site may be blocking or redirecting the request.`)
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
        source:          'nightlight_cinema',
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
    const [venueId, organizerId] = await Promise.all([ensureVenue(), ensureOrganizer()])
    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, venueId, organizerId)
    logUpsertResult('nightlight_cinema', inserted, 0, skipped)
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    console.error('\n❌  Fatal error:', err.message)
    process.exit(1)
  }
}

main()
