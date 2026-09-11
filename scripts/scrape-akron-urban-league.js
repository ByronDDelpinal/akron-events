/**
 * scrape-akron-urban-league.js
 *
 * Scrapes Akron Urban League events from their WordPress site.
 * Platform: WordPress 6.x + Divi theme (server-rendered HTML, REST enabled)
 *
 * Strategy (ADR-070, 2026-09):
 *   1. DISCOVERY via the WP REST API: resolve the "Events" category id from
 *      /wp-json/wp/v2/categories?slug=events, then page
 *      /wp-json/wp/v2/posts?categories=<id> for every published post in it.
 *   2. DISCOVERY (secondary, additive): keep scanning the events-workshops hub
 *      pages for /events/ and /events-archive/ hrefs and union the results by
 *      URL. A hub fetch failure is a warning, never a run failure.
 *   3. EXTRACTION stays HTML: fetch each detail page and parse og:* meta tags
 *      plus body copy for title, date, time, venue, description and links.
 *
 * 2026-09 finding (why discovery moved):
 *   - AUL publishes event posts at the SITE ROOT (/<slug>/), not under /events/,
 *     so the hub link scan matched nothing and the scraper logged clean zeroes
 *     for months. The posts are all filed in category "events" (id 30, 25 posts).
 *   - /category/events/ redirects to the events-workshops hub, so the category
 *     archive HTML is useless — the REST taxonomy query is the only reliable
 *     enumeration.
 *   - `content.rendered` comes back EMPTY on this install (Divi builder content
 *     is not serialised into REST), so the REST payload can only be used for
 *     discovery; every field still has to come from the rendered detail page.
 *
 * Date/time notes:
 *   - Dates appear in body copy as "Month D, YYYY" (e.g. "November 6, 2026").
 *   - Times appear as "9 a.m. to 3 p.m.", "7:30 AM", "1:00pm-4:00pm", etc.
 *   - The Divi hero renders the POST PUBLISH DATE ("September 2, 2026") above
 *     the article body, so a naive "first Month D, YYYY on the page" read can
 *     pick the publish date as the event date. `pickEventDate()` drops any
 *     candidate equal to the REST `date` and prefers the first future one.
 *     article:published_time / the WP post date are NEVER the event date.
 *
 * Usage:
 *   node scripts/scrape-akron-urban-league.js
 *   node scripts/scrape-akron-urban-league.js --dry-run   # fetch + parse only
 *
 * Required .env vars (not needed for --dry-run):
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  decodeEntities,
  easternToIso,
  easternTodayIso,
  enrichWithImageDimensions,
  ensureOrganization,
  ensureVenue,
  inferCategory,
  linkEventOrganization,
  linkEventVenue,
  linkOrganizationVenue,
  logScraperError,
  logUpsertResult,
  stripHtml,
  upsertEventSafe,
} from './lib/normalize.js'
import { classifySummitLocation } from './lib/summit-county.js'
import { fetchWithRetry } from './lib/http.js'
import { makeWindowFilter } from './lib/event-window.js'

const BASE_URL     = 'https://www.akronurbanleague.org'
const LISTING_URL  = `${BASE_URL}/get-involved/events-workshops/`
// Workshop sub-pages that may carry their own event links.
const EXTRA_LISTINGS = [
  `${BASE_URL}/get-involved/events-workshops/wfd-workshop-calendar/`,
  `${BASE_URL}/get-involved/events-workshops/mbac-workshop-calendar/`,
]

export const SOURCE_KEY = 'akron_urban_league'
const DAYS_AHEAD  = 365
// Same semantics the scraper has always used: a 3-hour past grace (an event
// stays eligible while it is running) and a 365-day forward horizon.
const PAST_GRACE_MS = 3 * 3600_000
export const isWithinWindow = makeWindowFilter({ horizonDays: DAYS_AHEAD, pastGraceMs: PAST_GRACE_MS })
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

const WP_BASE = `${BASE_URL}/wp-json/wp/v2`
const EVENTS_CATEGORY_SLUG = 'events'
// Observed 2026-09; only used when the slug lookup fails outright.
const EVENTS_CATEGORY_ID_FALLBACK = 30
const POSTS_PER_PAGE = 100
const PAGE_DELAY_MS = 150
// Hard cap on detail fetches per run (most-recent-by-publish first).
const MAX_DETAIL_FETCHES = 60

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetchWithRetry(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

/**
 * Fetch a WP REST endpoint. Throws on non-ok, on a non-JSON body, and on an
 * HTML body (a WAF interstitial or a redirect to a themed page both look like
 * `<`-prefixed text, and silently treating that as "no events" is how this
 * source went dark before).
 */
async function fetchJson(url) {
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  const body = await res.text()
  if (body.trimStart().startsWith('<')) {
    throw new Error(`Expected JSON from ${url} but got HTML (${body.length} bytes)`)
  }
  return { json: JSON.parse(body), headers: res.headers }
}

// ── REST discovery ─────────────────────────────────────────────────────────

/** Resolve the "Events" category id by slug; fall back to the observed id. */
async function resolveEventsCategoryId() {
  const url = `${WP_BASE}/categories?slug=${EVENTS_CATEGORY_SLUG}&_fields=id,slug,count`
  try {
    const { json } = await fetchJson(url)
    const hit = Array.isArray(json) ? json.find(t => t?.slug === EVENTS_CATEGORY_SLUG) : null
    if (hit?.id) {
      console.log(`  Category "${EVENTS_CATEGORY_SLUG}" → id ${hit.id} (lookup; ${hit.count ?? '?'} posts)`)
      return hit.id
    }
    console.warn(`  ⚠ Category lookup returned no "${EVENTS_CATEGORY_SLUG}" term — using fallback id ${EVENTS_CATEGORY_ID_FALLBACK}`)
  } catch (err) {
    console.warn(`  ⚠ Category lookup failed (${err.message}) — using fallback id ${EVENTS_CATEGORY_ID_FALLBACK}`)
  }
  return EVENTS_CATEGORY_ID_FALLBACK
}

/**
 * Page through every published post in the given category.
 * Returns [{ url, publishedIso, restTitle }] in feed order (newest first).
 */
async function fetchEventPostLinks(categoryId) {
  const out = []
  let page = 1
  let totalPages = 1

  do {
    const url = `${WP_BASE}/posts?categories=${categoryId}&per_page=${POSTS_PER_PAGE}`
      + `&page=${page}&status=publish&_fields=id,date,link,title`
    const { json, headers } = await fetchJson(url)
    if (!Array.isArray(json)) throw new Error(`Expected an array of posts from ${url}`)

    for (const post of json) {
      if (!post?.link) continue
      out.push({
        url:          post.link,
        publishedIso: post.date ?? null,
        restTitle:    stripHtml(post.title?.rendered ?? ''),
      })
    }

    if (page === 1) {
      const reported = Number(headers.get('x-wp-totalpages'))
      if (Number.isFinite(reported) && reported > 0) totalPages = reported
    }
    page++
    if (page <= totalPages) await sleep(PAGE_DELAY_MS)
  } while (page <= totalPages)

  console.log(`  REST returned ${out.length} post(s) across ${totalPages} page(s)`)
  return out
}

// ── Meta parsing ───────────────────────────────────────────────────────────

/**
 * Extract all <meta property="..." content="..."> and
 * <meta name="..." content="..."> values from raw HTML.
 *
 * KNOWN DEFECT (found 2026-09-11, deliberately NOT fixed here — out of ADR-070
 * scope): the branch below tests `re.source.startsWith('/<meta…')`, but
 * RegExp#source has no leading delimiter, so the test is always false and BOTH
 * patterns are read value-first. The map therefore ends up keyed by content
 * strings and `meta['og:title']` is always undefined — title silently falls
 * through to the <h1>, and og:image / og:description are dropped entirely.
 * Fixing it is a one-line change but it would start writing AUL's 227x80 site
 * LOGO into image_url for every event, so it needs a product call first.
 */
export function parseMeta(html) {
  const meta = {}
  // Handle both property= and name= variants; content may come before or after
  const patterns = [
    /<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/gi,
    /<meta\s+content="([^"]*)"\s+(?:property|name)="([^"]+)"/gi,
  ]
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      // First pattern: key=m[1], value=m[2]; second pattern: value=m[1], key=m[2]
      const [key, val] = re.source.startsWith('/<meta\\s+(?:property|name)')
        ? [m[1], m[2]]
        : [m[2], m[1]]
      if (key && !(key in meta)) meta[key] = val
    }
  }
  return meta
}

// ── Date / time parsing ────────────────────────────────────────────────────

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

const DATE_RE =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/gi

/**
 * Every "Month D, YYYY" / "Month D YYYY" date in `text`, in document order.
 * Returns [{ dateStr: 'YYYY-MM-DD', index }].
 */
export function extractDateCandidates(text) {
  if (!text) return []
  const out = []
  for (const m of String(text).matchAll(DATE_RE)) {
    const month = MONTH_MAP[m[1].toLowerCase()]
    if (!month) continue
    const day = parseInt(m[2], 10)
    if (!(day >= 1 && day <= 31)) continue
    out.push({
      dateStr: `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      index:   m.index,
    })
  }
  return out
}

/** First "Month D, YYYY" date in text, or null. Used for the slug fallback. */
function extractDate(text) {
  return extractDateCandidates(text)[0]?.dateStr ?? null
}

/**
 * Choose the event date out of the candidates found on a detail page.
 *
 * LOAD-BEARING: the Divi hero prints the post's publish date above the body, so
 * the FIRST date on the page is frequently the publish date, not the event
 * date. Rules, in order:
 *   1. Drop any candidate equal to the publish day — unless that would empty
 *      the pool (a post published the morning of its own event is legitimate).
 *   2. Prefer the first remaining candidate on/after Eastern "today".
 *   3. Otherwise take the first remaining candidate (past events still parse;
 *      the ingestion window rejects them downstream as `skipped`, not errors).
 *
 * The publish date is never used AS the event date — only to veto an echo.
 */
export function pickEventDate(candidates = [], publishedIso = null, todayIso = easternTodayIso()) {
  if (!candidates?.length) return null
  const publishedDay = publishedIso ? String(publishedIso).slice(0, 10) : null

  let pool = candidates
  if (publishedDay) {
    const withoutEcho = pool.filter(c => c.dateStr !== publishedDay)
    if (withoutEcho.length) pool = withoutEcho
  }

  return (pool.find(c => c.dateStr >= todayIso) ?? pool[0]).dateStr
}

/**
 * Find the first time in text and return "HH:MM:00".
 * Handles: "7:30 AM", "8:00am", "1:00pm", "6 PM", "9 a.m.", "noon", "midnight".
 * Returns null if nothing found.
 */
export function extractTime(text) {
  if (!text) return null
  const lower = text.toLowerCase()
  if (/\bnoon\b/.test(lower))     return '12:00:00'
  if (/\bmidnight\b/.test(lower)) return '00:00:00'

  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi
  const matches = [...text.matchAll(re)]
  if (!matches.length) return null

  // Prefer a time where the immediately preceding ~40 chars mention "begin" or "start"
  // (e.g. "Breakfast Begins: 8:00 AM"). Using a short lookback avoids mistakenly
  // favouring an earlier time just because "Doors Open" appears anywhere before it.
  const preferred = matches.find(m => /begin|start/i.test(text.slice(Math.max(0, m.index - 40), m.index)))
    ?? matches[0]

  let hr      = parseInt(preferred[1], 10)
  const min   = preferred[2] ?? '00'
  const isPm  = /p/i.test(preferred[3])
  if (hr > 12) return null
  if (isPm && hr !== 12) hr += 12
  if (!isPm && hr === 12) hr = 0
  return `${String(hr).padStart(2, '0')}:${min}:00`
}

// ── Category / tag mapping ─────────────────────────────────────────────────

// Category: infer from title + description.
function mapCategory(title = '', desc = '') {
  return inferCategory(title, desc)
}

export function mapTags(title = '', desc = '') {
  const t    = (title + ' ' + desc).toLowerCase()
  const tags = ['akron', 'community']
  if (/mlk|martin luther king|breakfast/.test(t))   tags.push('mlk', 'annual-breakfast')
  if (/juneteenth/.test(t))                          tags.push('juneteenth')
  if (/gala|champions of change/.test(t))            tags.push('gala', 'fundraiser')
  if (/business|entrepreneur|mbac|mccap/.test(t))    tags.push('business', 'entrepreneurship')
  if (/youth|kids|camp|summer/.test(t))              tags.push('youth')
  if (/workforce|job|career/.test(t))                tags.push('workforce-development')
  if (/santa|holiday|christmas/.test(t))             tags.push('holiday', 'family')
  if (/credible messenger/.test(t))                  tags.push('community-safety')
  if (/scholars|scholarship|luncheon/.test(t))       tags.push('education', 'scholarship')
  if (/seeds.*growth|growth.*seeds/.test(t))         tags.push('community-growth')
  return [...new Set(tags)]
}

// ── Listing page — collect event URLs (secondary discovery) ────────────────

/**
 * Scan listing page HTML for all unique event detail URLs.
 * Matches /events/<slug>/ and /events-archive/<slug>/ (excludes the listing page itself).
 * Kept as an additive source: it costs two requests and catches any legacy
 * /events/ page that never got filed in the Events category.
 */
function extractEventUrls(html) {
  const seen = new Set()
  const urls = []
  const re   = /href="(https:\/\/www\.akronurbanleague\.org\/events(?:-archive)?\/[^/"]+\/)"/g
  for (const m of html.matchAll(re)) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      urls.push(m[1])
    }
  }
  return urls
}

// ── Detail page — full event data ──────────────────────────────────────────

const ADDRESS_CITIES = 'Akron|Fairlawn|Cuyahoga Falls|Hudson|Stow|Kent|Tallmadge|Bath|Barberton|Norton|Green|Copley'
const STREET_SUFFIX  = 'Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Way|Parkway|Pkwy|Circle|Cir|Court|Ct|Place|Pl|Highway|Hwy'
// "440 Vernon Odom Blvd., Akron, OH 44307"
const ADDR_FULL_RE = new RegExp(`([^\\n,]{3,80}),\\s*(${ADDRESS_CITIES}),?\\s*OH\\s+(\\d{5})`, 'i')
// "…at 440 Vernon Odom Boulevard in Akron" / "…, 440 Vernon Odom Boulevard, Akron"
const ADDR_LOOSE_RE = new RegExp(
  `(\\d{2,6}\\s+[A-Za-z0-9.'\\-]+(?:\\s+[A-Za-z0-9.'\\-]+){0,5}\\s+(?:${STREET_SUFFIX}))\\.?\\s*(?:,|\\sin)\\s+(${ADDRESS_CITIES})\\b`,
  'i',
)

/**
 * Parse a single event detail page.
 *
 * @param {string}  html
 * @param {string}  eventUrl
 * @param {?string} publishedIso  REST `date` for this post, or null for a
 *                                hub-scan URL we have no REST record for.
 * @param {string}  todayIso      Eastern "today" (injectable for tests).
 */
export function parseDetailPage(html, eventUrl, publishedIso = null, todayIso = easternTodayIso()) {
  const meta = parseMeta(html)

  // ── Title ──────────────────────────────────────────────────────────────
  let title = decodeEntities(meta['og:title'] ?? '')
    .replace(/\s*[-–|]\s*Akron Urban League\s*$/i, '')
    .trim()
  if (!title) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    title = h1 ? stripHtml(h1[1]).trim() : ''
  }

  // ── Image ──────────────────────────────────────────────────────────────
  const imageUrl = meta['og:image'] ?? null

  // ── Description ────────────────────────────────────────────────────────
  let description = meta['og:description'] ?? meta.description ?? null
  if (description) description = decodeEntities(description).trim() || null
  // og:description often leads with the title — strip it for cleaner copy
  if (description && title) {
    const safePfx = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    description = description.replace(new RegExp(`^${safePfx}\\s*`, 'i'), '').trim() || description
  }

  // ── Isolate main content block for date/time/venue parsing ────────────
  const contentBlock = (
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? html
  )
  const contentText = stripHtml(contentBlock)

  // ── Date ───────────────────────────────────────────────────────────────
  const dateCandidates = extractDateCandidates(contentText)
  let dateStr = pickEventDate(dateCandidates, publishedIso, todayIso)
  // Last-resort: derive from the URL slug (several posts embed the date there).
  if (!dateStr) {
    const slugTail = eventUrl.replace(/\/$/, '').split('/').pop() ?? ''
    dateStr = extractDate(slugTail.replace(/-/g, ' '))
  }

  // ── Time ───────────────────────────────────────────────────────────────
  const timeStr = extractTime(contentText)

  // ── Venue + address ────────────────────────────────────────────────────
  const addrM = contentText.match(ADDR_FULL_RE) ?? contentText.match(ADDR_LOOSE_RE)
  let venue        = null
  let venueAddress = null
  // NOTE: venueCity defaults to 'Akron' for the venue record, but the Summit
  // gate keys off `addressMatched` — a post with NO address must not pass the
  // gate on a defaulted city.
  let venueCity    = 'Akron'
  const venueState = 'OH'
  let venueZip     = null

  if (addrM) {
    venueAddress = addrM[1].trim().replace(/^(?:at|,)\s+/i, '')
    venueCity    = addrM[2].trim()
    venueZip     = addrM[3] ?? null
    // Venue name: the line immediately before the address in the content
    const beforeAddr = contentText.slice(0, contentText.indexOf(addrM[0])).trim()
    const lines      = beforeAddr.split('\n').map(l => l.trim()).filter(Boolean)
    const candidate  = lines[lines.length - 1] ?? ''
    if (candidate.length > 3 && candidate.length < 80 && !/[.!?]$/.test(candidate)
        && !/^(join|this|the|our|come|we |register)/i.test(candidate)) {
      venue = candidate
    }
  }

  // ── Registration / ticket URL ──────────────────────────────────────────
  const registerRe = /<a[^>]+href="([^"]+)"[^>]*>\s*(?:Register(?:\s+Now)?|Buy\s+Tickets?|RSVP|Get\s+Tickets?)\s*<\/a>/i
  const ticketUrl  = html.match(registerRe)?.[1] ?? eventUrl

  return {
    title, description, imageUrl, dateStr, timeStr, dateCandidates,
    publishedIso, addressMatched: Boolean(addrM),
    venue, venueAddress, venueCity, venueState, venueZip, ticketUrl,
  }
}

/** source_id for an event URL: the slug tail (stable across runs). */
export function deriveSourceId(eventUrl) {
  return eventUrl.replace(/\/$/, '').split('/').pop() ?? ''
}

// ── Venue cache + helper ───────────────────────────────────────────────────

const venueCache = new Map()

async function resolveVenue(parsed, organizerId) {
  const { venue, venueAddress, venueCity, venueState, venueZip } = parsed
  if (!venue && !venueAddress) return null

  const cacheKey = venue ?? venueAddress
  if (venueCache.has(cacheKey)) return venueCache.get(cacheKey)

  const venueId = await ensureVenue(venue ?? venueAddress, {
    address: venueAddress,
    city:    venueCity  ?? 'Akron',
    state:   venueState ?? 'OH',
    zip:     venueZip   ?? null,
    website: null,
  })

  if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
  venueCache.set(cacheKey, venueId)
  return venueId
}

// ── Process all events ─────────────────────────────────────────────────────

async function processEvents(posts, organizerId) {
  const now     = Date.now()
  const todayIso = easternTodayIso()
  let inserted = 0, skipped = 0
  let skippedPast = 0, skippedNoDate = 0, skippedOutOfCounty = 0, flaggedReview = 0
  const prepared = []

  for (const { url, publishedIso } of posts) {
    try {
      console.log(`  → ${url}`)
      const html   = await fetchHtml(url)
      const parsed = parseDetailPage(html, url, publishedIso, todayIso)

      if (!parsed.title) {
        console.warn('    ⚠ No title — skipping')
        skipped++
        continue
      }

      if (!parsed.dateStr) {
        console.warn(`    ⚠ No date found for "${parsed.title}" — skipping`)
        skipped++
        skippedNoDate++
        continue
      }

      const publishedDay = publishedIso ? String(publishedIso).slice(0, 10) : null
      const dateNote = publishedDay && publishedDay !== parsed.dateStr
        ? `${parsed.dateStr} (published ${publishedDay})`
        : parsed.dateStr

      const dateTime = parsed.timeStr
        ? `${parsed.dateStr} ${parsed.timeStr}`
        : parsed.dateStr
      const startAt  = easternToIso(dateTime)

      if (!startAt) { skipped++; skippedNoDate++; continue }

      if (!isWithinWindow(startAt, null, now)) {
        console.log(`    ↳ Outside window (${dateNote}) — skipping`)
        skipped++
        skippedPast++
        continue
      }

      // Summit gate — key off whether an address ACTUALLY matched, not the
      // defaulted city, so an address-less post lands in review.
      const geo = parsed.addressMatched
        ? classifySummitLocation({ city: parsed.venueCity })
        : 'unknown'
      if (geo === 'out') {
        console.log(`    ↳ Out of Summit County (${parsed.venueCity}) — skipping`)
        skipped++
        skippedOutOfCounty++
        continue
      }

      const category = mapCategory(parsed.title, parsed.description ?? '')
      const tags     = mapTags(parsed.title, parsed.description ?? '')

      const row = {
        title:           parsed.title,
        description:     parsed.description || null,
        start_at:        startAt,
        end_at:          null,
        category,
        tags,
        price_min:       null,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       parsed.imageUrl ?? null,
        ticket_url:      parsed.ticketUrl ?? url,
        source:          SOURCE_KEY,
        source_id:       deriveSourceId(url),
        status:          'published',
        featured:        false,
      }

      if (geo === 'unknown') {
        row.status = 'pending_review'
        row.needs_review = true
        flaggedReview++
      }

      console.log(`    ✓ "${row.title}" on ${dateNote}${parsed.timeStr ? ` @ ${parsed.timeStr}` : ''}${geo === 'unknown' ? ' [needs_review]' : ''}`)

      if (DRY_RUN) {
        prepared.push({ row, parsed })
        continue
      }

      const venueId  = await resolveVenue(parsed, organizerId)
      const enriched = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enriched)

      if (error) {
        console.warn(`    ⚠ Upsert failed for "${row.title}": ${error.message}`)
        skipped++
      } else {
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }

      // Polite delay between requests
      await sleep(400)
    } catch (err) {
      console.warn(`  ⚠ Error processing ${url}: ${err.message}`)
      skipped++
    }
  }

  return {
    inserted, skipped, prepared,
    skippedPast, skippedNoDate, skippedOutOfCounty, flaggedReview,
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akron Urban League ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    // ── 1. REST discovery (authoritative) ────────────────────────────────
    console.log('\n🔍  Resolving the Events category via WP REST…')
    const categoryId = await resolveEventsCategoryId()

    let posts
    try {
      posts = await fetchEventPostLinks(categoryId)
    } catch (err) {
      // A failed taxonomy query is a hard failure: silently logging zero is
      // exactly how this source went dark for months.
      throw new Error(`WP REST posts query failed for category ${categoryId}: ${err.message}`)
    }

    if (posts.length === 0) {
      throw new Error(
        `WP REST returned 0 posts for category ${categoryId} — the Events term has moved or been emptied`,
      )
    }

    // ── 2. Hub scan (secondary, additive, warn-only) ─────────────────────
    const seenUrls = new Set(posts.map(p => p.url))
    let hubUrls = 0
    for (const listing of [LISTING_URL, ...EXTRA_LISTINGS]) {
      try {
        const html = await fetchHtml(listing)
        for (const u of extractEventUrls(html)) {
          if (seenUrls.has(u)) continue
          seenUrls.add(u)
          posts.push({ url: u, publishedIso: null, restTitle: '' })
          hubUrls++
        }
      } catch (err) {
        console.warn(`  ⚠ Could not fetch ${listing}: ${err.message}`)
      }
    }
    console.log(`  Hub scan added ${hubUrls} URL(s) not already in the REST set`)

    // Newest-published first, then cap detail fetches.
    posts.sort((a, b) => String(b.publishedIso ?? '').localeCompare(String(a.publishedIso ?? '')))
    if (posts.length > MAX_DETAIL_FETCHES) {
      console.log(`  Capping detail fetches at ${MAX_DETAIL_FETCHES} (of ${posts.length})`)
      posts = posts.slice(0, MAX_DETAIL_FETCHES)
    }
    console.log(`  ${posts.length} unique event URL(s) to fetch`)

    const organizerId = DRY_RUN ? null : await ensureOrganization('Akron Urban League', {
      website:     BASE_URL,
      description: 'The Akron Urban League improves the quality of life of Summit County residents, particularly African Americans, through economic self-reliance and social empowerment.',
    })

    console.log(`\n📥  Fetching and processing ${posts.length} event detail page(s)…`)
    const result = await processEvents(posts, organizerId)

    console.log(
      `\n📊  skipped past/out-of-window: ${result.skippedPast}`
      + ` · no date: ${result.skippedNoDate}`
      + ` · out of county: ${result.skippedOutOfCounty}`
      + ` · needs_review: ${result.flaggedReview}`,
    )

    if (DRY_RUN) {
      for (const { row } of result.prepared) {
        console.log(`     • ${row.title}\n       ${row.start_at}  cat=${row.category}  status=${row.status}  id=${row.source_id}`)
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run] — ${result.prepared.length} event(s) prepared, ${result.skipped} skipped`)
      return
    }

    await logUpsertResult(SOURCE_KEY, result.inserted, 0, result.skipped, {
      eventsFound: posts.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${result.inserted} inserted, ${result.skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-akron-urban-league.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
