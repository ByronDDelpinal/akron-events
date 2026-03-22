/**
 * scrape-jillys.js
 *
 * Fetches upcoming events from Jilly's Music Room (jillysmusicroom.com).
 *
 * Strategy:
 *   1. POST to EventON's `the_ajax_hook` AJAX endpoint with a 6-month window.
 *      The response is JSON with each event's UTC timestamps and post ID.
 *   2. Batch-fetch full event data (content, image, taxonomies) from the WP
 *      REST API using the `include` parameter — one request per 50-ID chunk.
 *   3. Merge both datasets by post ID and upsert to Supabase.
 *
 * Why two sources?
 *   EventON stores event dates in custom meta fields that the WP REST API does
 *   not expose publicly. The EventON AJAX endpoint provides correct UTC Unix
 *   timestamps. The WP REST API provides everything else (content, images, tags).
 *
 * Usage:
 *   node scripts/scrape-jillys.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError, stripHtml } from './lib/normalize.js'

const AJAX_URL   = 'https://jillysmusicroom.com/wp-admin/admin-ajax.php'
const REST_BASE  = 'https://jillysmusicroom.com/wp-json/wp/v2/ajde_events'
const DAYS_AHEAD = 180
const BATCH_SIZE = 50   // WP REST API include= batch size

// ── Helpers ───────────────────────────────────────────────────────────────
// stripHtml imported from normalize.js — handles all named + numeric HTML entities

/** Extract first ticket/purchase URL from HTML content */
function extractTicketUrl(html = '', permalink = '') {
  const ticketPatterns = [
    /href="(https?:\/\/(?:www\.)?(?:tickpick|eventbrite|ticketmaster|axs|dice\.fm|bandsintown)[^"]+)"/i,
    /href="([^"]+)"\s[^>]*>\s*(?:BUY\s+)?TICKET/i,
    /href="([^"]+)"\s[^>]*>\s*GET\s+TICKET/i,
  ]
  for (const re of ticketPatterns) {
    const m = html.match(re)
    if (m) return m[1]
  }
  return permalink || null
}

/** Map EventON taxonomy slugs (from class_list) → our category enum */
function parseCategory(classList = []) {
  const classes = classList.join(' ').toLowerCase()
  if (classes.includes('event_type-music')) return 'music'
  if (classes.includes('event_type-food'))  return 'food'
  if (classes.includes('event_type-class') || classes.includes('event_type-workshop')) return 'education'
  if (classes.includes('event_type-community')) return 'community'
  return 'music'  // Jilly's is primarily a live music venue
}

/** Extract human-readable tags from WP taxonomy term objects */
function parseTags(termArrays = []) {
  const tags = []
  for (const termList of termArrays) {
    for (const term of termList) {
      if (term.name) tags.push(term.name.toLowerCase())
    }
  }
  tags.push('live music', "jilly's")
  return [...new Set(tags)]
}

/** Sleep helper for rate limiting */
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Venue / Organizer ─────────────────────────────────────────────────────

async function ensureVenue() {
  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', "Jilly's Music Room").maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:          "Jilly's Music Room",
    address:       '111 N Main St',
    city:          'Akron',
    state:         'OH',
    zip:           '44308',
    lat:           41.0839,
    lng:           -81.5183,
    parking_type:  'street',
    parking_notes: 'Street parking on N Main St and surrounding blocks. Canal Park garage nearby.',
    website:       'https://jillysmusicroom.com',
    description:   "Akron's premier live music venue in the heart of downtown, featuring jazz, blues, rock, and more.",
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Jilly\'s venue:', error.message); return null }
  console.log("  ✚ Created Jilly's Music Room venue")
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', "Jilly's Music Room").maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:        "Jilly's Music Room",
    website:     'https://jillysmusicroom.com',
    description: "Akron's downtown live music venue hosting jazz, blues, Americana, tribute acts, and more.",
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Jilly\'s organizer:', error.message); return null }
  console.log("  ✚ Created Jilly's Music Room organizer")
  return data.id
}

// ── Step 1: Fetch event IDs + timestamps via EventON AJAX ─────────────────

async function fetchEventonEvents() {
  const now        = new Date()
  const todayUnix  = Math.floor(Date.now() / 1000)
  const endUnix    = todayUnix + DAYS_AHEAD * 86400

  const params = new URLSearchParams({
    action:                              'the_ajax_hook',
    ajaxtype:                            'switchmonth',
    direction:                           'next',
    'shortcode[fixed_month]':            String(now.getMonth() + 1),  // 1-indexed
    'shortcode[fixed_year]':             String(now.getFullYear()),
    'shortcode[fixed_day]':              String(now.getDate()),
    'shortcode[event_count]':            '200',
    'shortcode[cal_id]':                 'MAIN',
    'shortcode[cal_init_nonajax]':       'no',
    'shortcode[hide_past]':              'no',
    'shortcode[event_past_future]':      'future',
    'shortcode[number_of_months]':       String(Math.ceil(DAYS_AHEAD / 30)),
    'shortcode[focus_start_date_range]': String(todayUnix),
    'shortcode[focus_end_date_range]':   String(endUnix),
    'shortcode[sort_by]':                'sort_date',
    'shortcode[_cver]':                  '4.0.6',
  })

  console.log(`\n🔍  Fetching Jilly's events via EventON AJAX…`)

  const res = await fetch(AJAX_URL, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   'Mozilla/5.0 (compatible; The330-bot/1.0)',
    },
    body: params.toString(),
  })

  if (!res.ok) throw new Error(`EventON AJAX error ${res.status}: ${await res.text()}`)

  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`EventON AJAX returned non-JSON: ${text.substring(0, 200)}`)
  }

  if (data.status !== 'GOOD' && !Array.isArray(data.json)) {
    throw new Error(`EventON AJAX bad status: ${JSON.stringify(data).substring(0, 200)}`)
  }

  const events = data.json ?? []
  console.log(`  EventON AJAX returned ${events.length} upcoming events`)
  return events
}

// ── Step 2: Batch-fetch full post data via WP REST API ────────────────────

async function fetchRestBatch(ids) {
  const url = `${REST_BASE}?include=${ids.join(',')}&per_page=${ids.length}&_embed=true`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)' },
  })
  if (!res.ok) throw new Error(`WP REST API error ${res.status}: ${await res.text()}`)
  return res.json()
}

async function fetchAllRestData(ids) {
  const chunks = []
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    chunks.push(ids.slice(i, i + BATCH_SIZE))
  }

  console.log(`\n📦  Fetching full post data in ${chunks.length} REST API batch(es)…`)

  const allPosts = []
  for (let i = 0; i < chunks.length; i++) {
    const posts = await fetchRestBatch(chunks[i])
    allPosts.push(...posts)
    console.log(`  Batch ${i + 1}/${chunks.length}: ${posts.length} posts`)
    if (i < chunks.length - 1) await sleep(300)
  }

  // Index by ID for fast lookup
  const byId = new Map()
  for (const post of allPosts) byId.set(post.id, post)
  return byId
}

// ── Step 3: Process and upsert ────────────────────────────────────────────

async function processEvents(ajaxEvents, restById, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const ev of ajaxEvents) {
    try {
      const postId  = ev.ID
      const restPost = restById.get(postId)

      // Compute UTC timestamps
      // event_start_unix_utc is already UTC
      // event_end_unix is local time; tzOffset = start_utc - start_local
      const tzOffsetSec  = ev.event_start_unix_utc - ev.event_start_unix
      const startAt      = new Date(ev.event_start_unix_utc * 1000).toISOString()
      const endAt        = ev.event_end_unix
        ? new Date((ev.event_end_unix + tzOffsetSec) * 1000).toISOString()
        : null

      // Pull enriched data from REST response (if available)
      let title       = stripHtml(ev.event_title ?? '')
      let description = null
      let imageUrl    = null
      let ticketUrl   = null
      let classList   = []
      let termArrays  = []

      if (restPost) {
        title       = stripHtml(restPost.title?.rendered ?? ev.event_title)
        description = stripHtml(restPost.content?.rendered ?? '') || null
        classList   = restPost.class_list ?? []
        ticketUrl   = extractTicketUrl(restPost.content?.rendered ?? '', restPost.link)

        // Featured media
        const media = restPost._embedded?.['wp:featuredmedia']?.[0]
        imageUrl = media?.source_url ?? null

        // Taxonomy terms (skip first array which is post_tags, usually empty)
        const wpTerms = restPost._embedded?.['wp:term'] ?? []
        termArrays = wpTerms.slice(1)  // skip post_tag, keep event_type + event_type_2
      }

      const category = parseCategory(classList)
      const tags     = parseTags(termArrays)

      const row = {
        title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        venue_id:        venueId,
        organizer_id:    organizerId,
        category,
        tags,
        price_min:       0,    // Jilly's often has free or door-price shows; update if parseable
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ticketUrl,
        source:          'jillys_music_room',
        source_id:       String(postId),
        status:          'published',
        featured:        ev.featured === true || ev.featured === 'yes',
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
      console.warn(`  ⚠ Error processing event ID ${ev.ID}:`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ───────────────────────────────────────────────────────────

async function main() {
  console.log("🚀  Starting Jilly's Music Room ingestion…")
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureVenue(), ensureOrganizer()])

    // Step 1: EventON AJAX — get upcoming event IDs and timestamps
    const ajaxEvents = await fetchEventonEvents()
    if (!ajaxEvents.length) {
      console.log('  No upcoming events found.')
      await logUpsertResult('jillys_music_room', 0, 0, 0, { eventsFound: 0, durationMs: Date.now() - start })
      return
    }

    // Step 2: WP REST API — get content, images, taxonomies
    const ids       = [...new Set(ajaxEvents.map(e => e.ID))]
    const restById  = await fetchAllRestData(ids)

    // Step 3: Merge and upsert
    console.log(`\n📥  Processing ${ajaxEvents.length} events…`)
    const { inserted, skipped } = await processEvents(ajaxEvents, restById, venueId, organizerId)
    await logUpsertResult('jillys_music_room', inserted, 0, skipped, {
      eventsFound: ajaxEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('jillys_music_room', err, start)
    process.exit(1)
  }
}

main()
