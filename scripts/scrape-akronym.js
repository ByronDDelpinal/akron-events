/**
 * scrape-akronym.js
 *
 * Fetches upcoming events from Akronym Brewing (akronymbrewing.com) via the
 * WordPress REST API. Events are plain WordPress blog posts (Elementor) under
 * the "Events" and/or "Biergarten" categories — there is NO events plugin, so
 * post `meta` carries no date fields (only `footnotes`) and the real event
 * date/time lives in the prose (e.g. "Sunday, August 2, 2026, from Noon to
 * 4PM", "On Saturday, June 13th … from 10-11AM").
 *
 * Strategy:
 *   1. Discover ALL event-ish category IDs from /wp-json/wp/v2/categories
 *      (events + biergarten + trivia — Biergarten-only posts like the 4th of
 *      July show would otherwise be missed).
 *   2. Fetch posts in those categories with _embed=true (gives featured image).
 *   3. Parse date/time from post meta if an events plugin ever appears, else
 *      parse the rendered content/title prose (extractEventDateTime). Posts
 *      with no parseable calendar date (news, awards, hours) are skipped —
 *      the post PUBLISH date is never used as an event date (that was the bug
 *      that kept this scraper at 0 inserts: publish dates are always in the
 *      past, so every post was window-skipped).
 *   4. Time-less dates follow the fairgrounds convention: easternToIso(date, '')
 *      (no fabricated default time — see the stan_hywet 09:00 lesson).
 *
 * Usage:
 *   node scripts/scrape-akronym.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  easternToIso,
} from './lib/normalize.js'

const WP_BASE    = 'https://akronymbrewing.com/wp-json/wp/v2'
const DAYS_AHEAD = 180

// ── Helpers ───────────────────────────────────────────────────────────────
// stripHtml imported from normalize.js — handles all named + numeric HTML entities

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

// ── Content date/time parsing ─────────────────────────────────────────────

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

const DATE_RE = new RegExp(
  String.raw`(?:(?:sun|mon|tues?|wednes|thurs?|fri|satur)day,?\s+)?` +
  String.raw`(january|february|march|april|may|june|july|august|september|october|november|december)` +
  String.raw`\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?`,
  'gi'
)

// Day-first forms: "4th of July", "17th of March, 2026"
const DAY_FIRST_RE = new RegExp(
  String.raw`(\d{1,2})(?:st|nd|rd|th)\s+of\s+` +
  String.raw`(january|february|march|april|may|june|july|august|september|october|november|december)` +
  String.raw`(?:,?\s+(\d{4}))?`,
  'gi'
)

// Fixed-date holidays a taproom posts about without spelling out the date
// (apostrophes may be straight or curly after stripHtml entity decoding).
const HOLIDAYS = [
  [/st\.?\s*patrick(?:'|’)?s?\b/gi, 3, 17],
  [/new\s+year(?:'|’)?s\s+eve/gi, 12, 31],
  [/\bhalloween\b/gi, 10, 31],
  [/valentine(?:'|’)?s\s+day/gi, 2, 14],
  [/cinco\s+de\s+mayo/gi, 5, 5],
]

// Relative weekday ("This Friday") — resolved against the post publish date.
const REL_WEEKDAY_RE = /\b(?:this|next)\s+(sun|mon|tues?|wednes|thurs?|fri|satur)day\b/gi
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, tues: 2, wednes: 3, thur: 4, thurs: 4, fri: 5, satur: 6 }

const TIME_PART = String.raw`(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight)`
// Range: "from Noon to 4PM", "10-11AM", "6 – 9 pm". The start may omit its
// meridiem ("10-11AM") and inherits it from the end token.
const TIME_RANGE_RE = new RegExp(
  String.raw`(?:from\s+)?(${TIME_PART}|\d{1,2}(?::\d{2})?)\s*(?:–|—|-|to|until)\s*(${TIME_PART})`, 'i'
)
const TIME_SINGLE_RE = new RegExp(String.raw`(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)|\b(noon|midnight)\b`, 'i')

/** "4PM" / "10:30 am" / "noon" / "midnight" → "H:MM am|pm" (easternToIso-friendly), or null. */
function normalizeClock(tok, inheritMeridiem = null) {
  if (!tok) return null
  const t = tok.trim().toLowerCase()
  if (t === 'noon') return '12:00 pm'
  if (t === 'midnight') return '12:00 am'
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/)
  if (!m) return null
  const hour = parseInt(m[1], 10)
  const minute = m[2] ?? '00'
  const mer = m[3] ? (m[3].startsWith('p') ? 'pm' : 'am') : inheritMeridiem
  if (!mer || hour < 1 || hour > 12) return null
  return `${hour}:${minute} ${mer}`
}

/** Find a start (and optional end) time inside `text`. */
function extractTimesFromText(text) {
  const range = text.match(TIME_RANGE_RE)
  if (range) {
    const end = normalizeClock(range[2])
    const start = normalizeClock(range[1], end?.endsWith('pm') ? 'pm' : end?.endsWith('am') ? 'am' : null)
    if (start && end) return { timeStr: start, endTimeStr: end }
    if (start) return { timeStr: start, endTimeStr: null }
  }
  const single = text.match(TIME_SINGLE_RE)
  if (single) {
    const tok = single[4] ?? single[0]
    const t = normalizeClock(tok)
    if (t) return { timeStr: t, endTimeStr: null }
  }
  return null
}

/**
 * Parse the event's calendar date (+ time when present) out of post prose.
 * Returns { dateStr: 'YYYY-MM-DD', timeStr|null, endTimeStr|null } or null.
 *
 * Year inference for "Saturday, June 13th"-style dates (no year): assume the
 * post's publish year, rolling forward one year when that lands >45 days
 * before the publish date (December posts announcing January events).
 * The publish date itself is ONLY used for year inference — never as the
 * event date.
 */
export function extractEventDateTime(text = '', publishedIso = '') {
  if (!text) return null
  const pub = new Date(publishedIso)
  const pubMs = isNaN(pub.getTime()) ? Date.now() : pub.getTime()
  const pubYear = new Date(pubMs).getUTCFullYear()

  const candidates = []
  const addCandidate = (month, day, explicitYear, index) => {
    if (!month || day < 1 || day > 31) return
    let year = explicitYear
    if (!year) {
      year = pubYear
      if (Date.UTC(year, month - 1, day) < pubMs - 45 * 86400_000) year += 1
    }
    const ms = Date.UTC(year, month - 1, day)
    candidates.push({
      index,
      explicitYear: explicitYear != null,
      future: ms >= pubMs - 86400_000,
      dateStr: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    })
  }

  // 1. "August 2, 2026" / "Saturday, June 13th" (month-first)
  for (const m of text.matchAll(DATE_RE)) {
    addCandidate(MONTHS[m[1].toLowerCase()], parseInt(m[2], 10), m[3] ? parseInt(m[3], 10) : null, m.index)
  }
  // 2. "4th of July" (day-first)
  for (const m of text.matchAll(DAY_FIRST_RE)) {
    addCandidate(MONTHS[m[2].toLowerCase()], parseInt(m[1], 10), m[3] ? parseInt(m[3], 10) : null, m.index)
  }
  // 3. Fixed-date holiday names ("St. Patrick's Day") — lowest confidence,
  //    only added when nothing explicit matched.
  if (!candidates.length) {
    for (const [re, month, day] of HOLIDAYS) {
      for (const m of text.matchAll(re)) addCandidate(month, day, null, m.index)
    }
  }
  // 4. "This Friday" relative to the publish CALENDAR date (the WP `date`
  //    field is site-local ET; use its date part only — never local Date math,
  //    see the Delight Nights off-by-one lesson). Same-day delta of 0 is kept
  //    ("this Friday" posted Friday morning).
  if (!candidates.length && /^\d{4}-\d{2}-\d{2}/.test(String(publishedIso))) {
    const [py, pm, pd] = String(publishedIso).slice(0, 10).split('-').map(Number)
    const baseMs = Date.UTC(py, pm - 1, pd)
    const baseDow = new Date(baseMs).getUTCDay()
    for (const m of text.matchAll(REL_WEEKDAY_RE)) {
      const target = WEEKDAY_INDEX[m[1].toLowerCase()]
      if (target == null) continue
      const delta = (target - baseDow + 7) % 7
      const d = new Date(baseMs + delta * 86400_000)
      candidates.push({
        index: m.index,
        explicitYear: false,
        future: true,
        dateStr: d.toISOString().slice(0, 10),
      })
    }
  }

  if (!candidates.length) return null
  const pick =
    candidates.find(c => c.explicitYear && c.future) ??
    candidates.find(c => c.future) ??
    candidates.find(c => c.explicitYear) ??
    candidates[0]

  // Look for a time near the chosen date mention first, then anywhere.
  const near = text.slice(pick.index, pick.index + 180)
  const times = extractTimesFromText(near) ?? extractTimesFromText(text)
  return { dateStr: pick.dateStr, timeStr: times?.timeStr ?? null, endTimeStr: times?.endTimeStr ?? null }
}

/** Drop SEO pipe-segments: "Books & Brews 2026 | Akron Brewery … | Akronym Brewing" → "Books & Brews 2026". */
export function cleanTitle(raw = '') {
  return raw.split(' | ')[0].trim()
}

/**
 * "Lager Fest Tickets Are On Sale Now …"-style follow-up posts should never
 * beat the original announcement as the canonical event, regardless of length.
 */
export function isTicketFollowUp(title = '') {
  return /tickets?\s+(?:are\s+)?(?:now\s+)?on\s+sale|on\s+sale\s+now/i.test(title)
}

function parseCategory(categories = []) {
  const slugs = categories.map(c =>
    (typeof c === 'string' ? c : c.slug ?? c.name ?? '').toLowerCase()
  )
  if (slugs.some(s => s.includes('music') || s.includes('concert') || s.includes('live'))) return 'music'
  if (slugs.some(s => s.includes('trivia') || s.includes('game') || s.includes('bingo'))) return 'other'
  if (slugs.some(s => s.includes('comedy'))) return 'comedy'
  // Word-boundary match: "biergARTen" must not read as art (cf. the bare
  // "civic" venue-name collision lesson).
  if (slugs.some(s => /\bart\b|\bshows?\b/.test(s))) return 'visual-art'
  if (slugs.some(s => s.includes('food') || s.includes('tasting') || s.includes('pairing'))) return 'food'
  return 'other' // Brewery default — taproom events without a clearer signal
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

async function findEventCategoryIds() {
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

  // Every category that carries events. "biergarten" matters: posts like the
  // 4th of July show are ONLY in Biergarten, not Events.
  const CANDIDATE_SLUGS = ['events', 'event', 'upcoming-events', 'shows', 'live-events', 'biergarten', 'trivia']
  const ids = cats
    .filter(c => CANDIDATE_SLUGS.includes(c.slug) || CANDIDATE_SLUGS.includes(c.name?.toLowerCase()))
    .map(c => {
      console.log(`  ✓ Event category: "${c.name}" (id ${c.id}, slug "${c.slug}", ${c.count} posts)`)
      return c.id
    })

  if (!ids.length) {
    console.warn('  ⚠ No event categories found. Available categories:')
    cats.forEach(c => console.warn(`    - ${c.name} (slug: ${c.slug}, id: ${c.id}, count: ${c.count})`))
  }
  return ids
}

// ── Fetch posts ───────────────────────────────────────────────────────────

async function fetchEventPosts(categoryIds) {
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
    if (categoryIds?.length) url.searchParams.set('categories', categoryIds.join(','))

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
  let inserted = 0, skipped = 0
  const updated = 0

  const byStart = new Map() // startAt ISO → row (in-run duplicate guard)

  // Announcements first, then most-detailed-first, so the duplicate guard
  // keeps the canonical post ("LagerFest Returns…" beats its longer
  // "Tickets Are On Sale Now" follow-up).
  const ordered = [...posts].sort((a, b) => {
    const ta = isTicketFollowUp(stripHtml(a.title?.rendered ?? '')) ? 1 : 0
    const tb = isTicketFollowUp(stripHtml(b.title?.rendered ?? '')) ? 1 : 0
    return ta - tb || (b.content?.rendered?.length ?? 0) - (a.content?.rendered?.length ?? 0)
  })

  for (const post of ordered) {
    try {
      const meta       = post.meta ?? {}
      const title      = cleanTitle(stripHtml(post.title?.rendered ?? ''))
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
      let hasTime = false

      if (metaDate) {
        // Meta fields present (events plugin) — convert Eastern → UTC
        startAt = easternToIso(metaDate, metaTime)
        hasTime = true
        if (metaEndDate) {
          endAt = easternToIso(metaEndDate, metaEndTime ?? '11:00 pm')
        } else if (startAt) {
          // Default: 3-hour event
          endAt = new Date(new Date(startAt).getTime() + 3 * 3600_000).toISOString()
        }
      } else {
        // Akronym posts carry no event meta — the date lives in the prose.
        // (Never fall back to the publish date: it is always in the past.)
        const parsed = extractEventDateTime(`${title}. ${descText}`, post.date)
        if (parsed) {
          hasTime = Boolean(parsed.timeStr)
          startAt = easternToIso(parsed.dateStr, parsed.timeStr ?? '')
          if (startAt && parsed.endTimeStr) {
            endAt = easternToIso(parsed.dateStr, parsed.endTimeStr)
            // Ranges that cross midnight ("9 PM - 1 AM") land before start — roll a day.
            if (endAt && endAt <= startAt) {
              endAt = new Date(new Date(endAt).getTime() + 86400_000).toISOString()
            }
          } else if (startAt && hasTime) {
            endAt = new Date(new Date(startAt).getTime() + 3 * 3600_000).toISOString()
          }
        }
      }

      if (!startAt) {
        console.log(`  ⚠ Skipping "${title}" — no event date found in content (news post?)`)
        skipped++
        continue
      }

      // In-run duplicate guard: two posts about the same event (announcement +
      // "tickets on sale") parse to the same timed start. Posts are processed
      // most-detailed-first, so the richer post always wins. Time-less
      // (midnight) collisions are allowed — two different all-day events can
      // share a date.
      if (hasTime && byStart.has(startAt)) {
        console.log(`  ⚠ Skipping "${title}" — duplicate of "${byStart.get(startAt).title}" at ${startAt}`)
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
        category,
        tags,
        price_min:       null,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ticketUrl,
        source:          'akronym_brewing',
        source_id:       String(post.id),
        status:          'published',
        featured:        false,
      }

      byStart.set(startAt, row)

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
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

async function ensureAkronymVenue() {
  return ensureVenue('Akronym Brewing', {
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
  })
}

async function ensureAkronymOrganizer() {
  return ensureOrganization('Akronym Brewing', {
    website: 'https://akronymbrewing.com',
    description: 'Craft brewery and live events venue in downtown Akron, OH.',
  })
}

// ── Entry point ───────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akronym Brewing ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId, categoryIds] = await Promise.all([
      ensureAkronymVenue(),
      ensureAkronymOrganizer(),
      findEventCategoryIds(),
    ])

    if (!categoryIds.length) {
      // No event categories found — log zero events and exit cleanly so scrape:all continues
      console.warn('\n⚠  No event categories found on akronymbrewing.com.')
      console.warn('   Check the category list above and update CANDIDATE_SLUGS if needed.')
      await logUpsertResult('akronym_brewing', 0, 0, 0, {
        status:       'error',
        errorMessage: 'No event categories found — category slugs may have changed',
        durationMs:   Date.now() - start,
        eventsFound:  0,
      })
      process.exit(0)
    }

    const posts = await fetchEventPosts(categoryIds)
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

// Run only when invoked directly (`node scripts/scrape-akronym.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
