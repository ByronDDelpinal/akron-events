/**
 * scrape-akronym.js
 *
 * Fetches upcoming events from Akronym Brewing (akronymbrewing.com) via the
 * WordPress REST API. Events are stored as standard WordPress posts under an
 * "Events" (or similar) category.
 *
 * Strategy:
 *   1. Discover the events category ID dynamically from /wp-json/wp/v2/categories
 *   2. Fetch all posts in that category with _embed=true (gives featured image)
 *   3. Parse date/time from post meta fields (registered with show_in_rest) or
 *      fall back to parsing from the post content / title
 *
 * Usage:
 *   node scripts/scrape-akronym.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError } from './lib/normalize.js'

const WP_BASE    = 'https://akronymbrewing.com/wp-json/wp/v2'
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

/**
 * Convert a local Eastern date + time string to an ISO 8601 UTC string.
 * Handles basic DST: EDT (UTC-4) from March 2nd Sunday to November 1st Sunday;
 * EST (UTC-5) otherwise.
 */
function easternToIso(dateStr, timeStr = '12:00 am') {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return null

  // DST: second Sunday of March → first Sunday of November
  const year = d.getFullYear()
  const dstStart = getNthSunday(year, 2, 2) // March (month 2), 2nd Sunday
  const dstEnd   = getNthSunday(year, 10, 1) // November (month 10), 1st Sunday
  const isDST    = d >= dstStart && d < dstEnd
  const offsetMs = isDST ? 4 * 3600_000 : 5 * 3600_000

  // Parse time: "7:00 pm", "7pm", "19:00", etc.
  const timeMatch = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!timeMatch) return null
  let hours   = parseInt(timeMatch[1], 10)
  const mins  = parseInt(timeMatch[2] ?? '0', 10)
  const ampm  = timeMatch[3]?.toLowerCase()
  if (ampm === 'pm' && hours < 12) hours += 12
  if (ampm === 'am' && hours === 12) hours = 0

  const localMs = d.getTime() + hours * 3600_000 + mins * 60_000
  return new Date(localMs + offsetMs).toISOString()
}

function getNthSunday(year, month, n) {
  const d = new Date(year, month, 1)
  const day = d.getDay()
  const firstSunday = day === 0 ? 1 : 8 - day
  return new Date(year, month, firstSunday + (n - 1) * 7)
}

/**
 * Try to extract event date from WordPress post meta.
 * Different event plugins store dates under different key names.
 */
function extractDateFromMeta(meta = {}) {
  // Common meta keys used by lightweight event plugins
  const candidates = [
    meta['_event_start_date'],
    meta['event_start_date'],
    meta['start_date'],
    meta['_start_date'],
    meta['event_date'],
    meta['_event_date'],
    meta['date'],
  ]
  for (const v of candidates) {
    if (v && typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function extractTimeFromMeta(meta = {}) {
  const candidates = [
    meta['_event_start_time'],
    meta['event_start_time'],
    meta['start_time'],
    meta['_start_time'],
    meta['event_time'],
  ]
  for (const v of candidates) {
    if (v && typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function extractEndDateFromMeta(meta = {}) {
  const candidates = [
    meta['_event_end_date'],
    meta['event_end_date'],
    meta['end_date'],
  ]
  for (const v of candidates) {
    if (v && typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function extractEndTimeFromMeta(meta = {}) {
  const candidates = [
    meta['_event_end_time'],
    meta['event_end_time'],
    meta['end_time'],
  ]
  for (const v of candidates) {
    if (v && typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

/**
 * Parse event date from the post's rendered content as a last resort.
 * Looks for patterns like "Friday, April 4" or "Saturday, March 22, 2026".
 */
function extractDateFromContent(content = '', postDate = '') {
  // If the post date itself is valid and in the future-ish, use it
  if (postDate) {
    const d = new Date(postDate)
    if (!isNaN(d.getTime())) {
      const dateStr = d.toISOString().split('T')[0]
      const timeStr = d.toTimeString().slice(0, 5)
      return { dateStr, timeStr }
    }
  }
  return null
}

function parseCategory(categories = []) {
  const slugs = categories.map(c =>
    (typeof c === 'string' ? c : c.slug ?? c.name ?? '').toLowerCase()
  )
  if (slugs.some(s => s.includes('music') || s.includes('concert') || s.includes('live'))) return 'music'
  if (slugs.some(s => s.includes('trivia') || s.includes('game') || s.includes('bingo'))) return 'community'
  if (slugs.some(s => s.includes('art') || s.includes('comedy') || s.includes('show'))) return 'art'
  if (slugs.some(s => s.includes('food') || s.includes('tasting') || s.includes('pairing'))) return 'food'
  return 'community' // Brewery default
}

function parseImage(post) {
  // _embed gives us the featured media object
  const media = post?._embedded?.['wp:featuredmedia']?.[0]
  if (media?.source_url) return media.source_url
  if (media?.media_details?.sizes?.medium?.source_url) return media.media_details.sizes.medium.source_url

  // Fallback: first <img> in the rendered content
  const match = (post?.content?.rendered ?? '').match(/<img[^>]+src="([^"]+)"/)
  return match?.[1] ?? null
}

// ── Category discovery ────────────────────────────────────────────────────

async function findEventsCategoryId() {
  const res = await fetch(`${WP_BASE}/categories?per_page=100&hide_empty=true`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
    },
  })

  if (!res.ok) throw new Error(`Categories fetch failed: ${res.status}`)

  const text = await res.text()
  if (text.trimStart().startsWith('<')) {
    throw new Error('WordPress REST API returned HTML — site may be blocking requests.')
  }

  const cats = JSON.parse(text)
  console.log(`  Found ${cats.length} categories:`, cats.map(c => `${c.slug} (${c.id})`).join(', '))

  // Look for "events" by slug or name
  const CANDIDATE_SLUGS = ['events', 'event', 'upcoming-events', 'shows', 'live-events']
  for (const slug of CANDIDATE_SLUGS) {
    const match = cats.find(c => c.slug === slug || c.name?.toLowerCase() === slug)
    if (match) {
      console.log(`  ✓ Events category: "${match.name}" (id ${match.id}, slug "${match.slug}")`)
      return match.id
    }
  }

  // If no obvious match, list all categories for manual inspection and bail gracefully
  console.warn('  ⚠ No "events" category found. Available categories:')
  cats.forEach(c => console.warn(`    - ${c.name} (slug: ${c.slug}, id: ${c.id}, count: ${c.count})`))
  return null
}

// ── Fetch posts ───────────────────────────────────────────────────────────

async function fetchEventPosts(categoryId) {
  const cutoff    = new Date().toISOString().split('T')[0]
  const allPosts  = []
  let page        = 1
  let totalPages  = 1

  console.log('\n🔍  Fetching Akronym events via WP REST API…')

  while (page <= totalPages) {
    const url = new URL(`${WP_BASE}/posts`)
    url.searchParams.set('per_page',  100)
    url.searchParams.set('page',      page)
    url.searchParams.set('status',    'publish')
    url.searchParams.set('_embed',    'true')
    if (categoryId) url.searchParams.set('categories', categoryId)

    const res = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
      },
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`WP posts fetch failed (${res.status}): ${body.slice(0, 200)}`)
    }

    const text = await res.text()
    if (text.trimStart().startsWith('<')) {
      throw new Error('WP REST API returned HTML — site may be blocking requests.')
    }

    totalPages = parseInt(res.headers.get('X-WP-TotalPages') ?? '1', 10)
    const posts = JSON.parse(text)
    allPosts.push(...posts)
    console.log(`  Page ${page}/${totalPages}: ${posts.length} posts (total: ${allPosts.length})`)
    page++

    if (page <= totalPages) await new Promise(r => setTimeout(r, 150))
  }

  return allPosts
}

// ── Process ───────────────────────────────────────────────────────────────

async function processEvents(posts, venueId, organizerId) {
  const now        = Date.now()
  const horizon    = now + DAYS_AHEAD * 86400_000
  let inserted = 0, updated = 0, skipped = 0

  for (const post of posts) {
    try {
      const meta       = post.meta ?? {}
      const title      = stripHtml(post.title?.rendered ?? '')
      const descText   = stripHtml(post.content?.rendered ?? '')
      const imageUrl   = parseImage(post)
      const ticketUrl  = post.link ?? null

      // ── Date parsing ──────────────────────────────────────────────────
      const metaDate    = extractDateFromMeta(meta)
      const metaTime    = extractTimeFromMeta(meta) ?? '8:00 pm'
      const metaEndDate = extractEndDateFromMeta(meta)
      const metaEndTime = extractEndTimeFromMeta(meta)

      let startAt = null
      let endAt   = null

      if (metaDate) {
        // Meta fields present — convert Eastern → UTC
        startAt = easternToIso(metaDate, metaTime)
        if (metaEndDate) {
          endAt = easternToIso(metaEndDate, metaEndTime ?? '11:00 pm')
        } else if (startAt) {
          // Default: 3-hour event
          endAt = new Date(new Date(startAt).getTime() + 3 * 3600_000).toISOString()
        }
      } else {
        // Fallback: use post published date as event date
        const parsed = extractDateFromContent('', post.date)
        if (parsed) {
          startAt = easternToIso(parsed.dateStr, '8:00 pm')
          endAt   = new Date(new Date(startAt).getTime() + 3 * 3600_000).toISOString()
        }
      }

      if (!startAt) {
        console.log(`  ⚠ Skipping "${title}" — could not determine event date`)
        skipped++
        continue
      }

      // Skip events outside our window
      const startMs = new Date(startAt).getTime()
      if (startMs < now - 3 * 3600_000 || startMs > horizon) {
        skipped++
        continue
      }

      // ── Category / tags ───────────────────────────────────────────────
      const wpCats  = post._embedded?.['wp:term']?.[0] ?? []
      const wpTags  = post._embedded?.['wp:term']?.[1] ?? []
      const category = parseCategory(wpCats)
      const tags = [
        ...wpCats.map(c => c.name?.toLowerCase()).filter(Boolean),
        ...wpTags.map(t => t.name?.toLowerCase()).filter(Boolean),
        'brewery', 'akronym',
      ].filter((v, i, a) => a.indexOf(v) === i)

      const row = {
        title,
        description:     descText || null,
        start_at:        startAt,
        end_at:          endAt,
        venue_id:        venueId,
        organizer_id:    organizerId,
        category,
        tags,
        price_min:       0,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ticketUrl,
        source:          'akronym_brewing',
        source_id:       String(post.id),
        status:          'published',
        featured:        false,
      }

      const { error } = await supabaseAdmin
        .from('events')
        .upsert(row, { onConflict: 'source,source_id', ignoreDuplicates: false })

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${title}":`, error.message)
        skipped++
      } else {
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing post ${post.id}:`, err.message)
      skipped++
    }
  }

  return { inserted, updated, skipped }
}

// ── Venue / Organizer ─────────────────────────────────────────────────────

async function ensureVenue() {
  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', 'Akronym Brewing').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:         'Akronym Brewing',
    address:      '58 E Mill St',
    city:         'Akron',
    state:        'OH',
    zip:          '44308',
    lat:          41.0808,
    lng:          -81.5163,
    parking_type: 'street',
    parking_notes:'Street parking on E Mill St and surrounding downtown streets.',
    website:      'https://akronymbrewing.com',
    description:  'Craft brewery in downtown Akron, OH.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Akronym venue:', error.message); return null }
  console.log('  ✚ Created Akronym Brewing venue')
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'Akronym Brewing').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:    'Akronym Brewing',
    website: 'https://akronymbrewing.com',
    description: 'Craft brewery and live events venue in downtown Akron, OH.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Akronym organizer:', error.message); return null }
  console.log('  ✚ Created Akronym Brewing organizer')
  return data.id
}

// ── Entry point ───────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akronym Brewing ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId, categoryId] = await Promise.all([
      ensureVenue(),
      ensureOrganizer(),
      findEventsCategoryId(),
    ])

    if (!categoryId) {
      // No events category found — log zero events and exit cleanly so scrape:all continues
      console.warn('\n⚠  No events category found on akronymbrewing.com.')
      console.warn('   Check the category list above and update CANDIDATE_SLUGS if needed.')
      await logUpsertResult('akronym_brewing', 0, 0, 0, {
        status:       'error',
        errorMessage: 'No events category found — category slug may have changed',
        durationMs:   Date.now() - start,
        eventsFound:  0,
      })
      process.exit(0)
    }

    const posts = await fetchEventPosts(categoryId)
    console.log(`\n📥  Processing ${posts.length} posts…`)

    const { inserted, updated, skipped } = await processEvents(posts, venueId, organizerId)
    await logUpsertResult('akronym_brewing', inserted, updated, skipped, {
      eventsFound: posts.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('akronym_brewing', err, start)
    process.exit(1)
  }
}

main()
