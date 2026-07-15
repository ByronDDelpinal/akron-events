/**
 * scrape-village-of-reminderville.js
 *
 * Village of Reminderville, Ohio (Summit County) — plain WordPress blog.
 * The village runs a stock WordPress site (reminderville.com) whose
 * "News and Events" page is just the standard blog roll: news notices and
 * community events are BLENDED into one stream of ordinary `post` objects.
 * There is NO events plugin and NO events custom-post-type — the WP REST
 * `/wp/v2/posts` feed is the only structured surface, and post `meta`/content
 * carry no date fields. In fact almost every post BODY is a single flyer
 * image (`<img>` only, no prose), so the event's date/time/venue live entirely
 * in the POST TITLE, e.g.:
 *
 *   "Community Shred Day – August 9 10:00-1:00 at City Hall"
 *   "Kids Halloween Event!  Sat, Oct 25 at the RAC!"
 *   "Annual Seniors Spaghetti Dinner at Fire Station on October 6"
 *   "Reminderville Safety Town: June 16-20"
 *   "June 27: Rain Barrel Workshop at Heritage Hall 5:00pm"
 *
 * Strategy (precision over recall — this is a low-yield source):
 *   1. Fetch all published posts via WP REST (paginated, `_embed` for the
 *      featured image).
 *   2. Drop the news/notice/meeting long tail with a keyword filter
 *      (council/zoning/committee meetings, election/levy/tax notices, refuse &
 *      road closures, NOPEC/utility bulletins, weather advisories, etc.) — the
 *      same pattern as scrape-city-of-cuyahoga-falls.js / scrape-bath-township.js.
 *   3. Parse the event DATE (and time when unambiguous) out of the TITLE prose
 *      (parseEventDate). The post PUBLISH date is NEVER used as the event date
 *      (that was the akronym 0-inserts bug: publish dates are always in the
 *      past). Publish date is used ONLY to infer the year for date tokens with
 *      no explicit year ("October 6" → the publish year, rolled forward when it
 *      would otherwise land >45 days before publication).
 *   4. Times: ONLY explicit-meridiem times are trusted ("5:00pm", "10:30am",
 *      noon/midnight). Bare meridiem-less ranges ("10:00-1:00", "1:00-4:00")
 *      are deliberately treated as time-less rather than guessing AM/PM — a
 *      time-less date becomes easternToIso(date, '') (no fabricated default
 *      time; see the stan_hywet 09:00 lesson).
 *   5. Multi-day ranges ("June 16-20", "6/22-6/26") carry an end date.
 *   6. Geography: every village event is in Reminderville (Summit County). We
 *      still route the resolved venue's city through classifySummitLocation so
 *      the strict Summit gate is honoured uniformly — the only realistic 'out'
 *      is a cross-posted neighbouring-town item (e.g. "…in Aurora", Portage Co.).
 *
 * Usage:
 *   node scripts/scrape-village-of-reminderville.js
 *   node scripts/scrape-village-of-reminderville.js --dry-run   # parse only, no DB
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  inferCategory,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'
import { classifySummitLocation } from './lib/summit-county.js'

// ── Constants ────────────────────────────────────────────────────────────────

export const SOURCE_KEY = 'village_of_reminderville'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

const ORIGIN = 'https://reminderville.com'
const WP_BASE = `${ORIGIN}/wp-json/wp/v2`
const LANDING_URL = `${ORIGIN}/news-and-events/`

const PAST_GRACE_MS = 86_400_000 // keep same-day events visible until midnight ET
const HORIZON_DAYS = 180

// ── Non-event filter ─────────────────────────────────────────────────────────
//
// The blog blends genuine community events with a large tail of municipal
// notices. We drop any post whose title matches a news/meeting/notice keyword,
// even when it carries a date (council meetings, election dates, etc. all have
// dates). The list is intentionally conservative: it targets administrative and
// bulletin language, NOT event nouns, so real events (shred days, rain-barrel
// workshops, recycling drop-offs, spaghetti dinners) pass through.
const NEWS_RE = new RegExp(
  [
    // Government meetings & governance
    'council', 'committee', 'commission', '\\bmeeting\\b', 'work session', 'via zoom',
    'via facebook', 'charter review', 'planning', 'zoning', '\\bboard\\b',
    '\\bcaucus\\b', 'public hearing', 'trustees?', 'letters? of interest',
    'seat', 'proclamation',
    // Elections / finance / legal notices
    'election', 'ballot', '\\blevy\\b', 'results', '\\brfq\\b', '\\brfp\\b',
    'public notice', 'permit', 'ordinance', 'resolution', 'legislation',
    'solicitors?', 'unclaimed funds', 'scholarship', 'j\\.?e\\.?d\\.?d',
    // Utilities / taxes / refuse / roads
    'nopec', 'electric rate', 'ohio edison', '\\btax(?:es)?\\b', '\\brita\\b',
    'kimble', 'pick-?up delay', 'pick-?up schedule', 'branch (?:pick|collection)',
    'leaf (?:pick|collection)', 'roadwork', 'road closure', 'lane closure',
    'closure', 'closed', '\\bcancel?led\\b', '\\bpostponed\\b',
    'snow plow', 'plowing', 'pavement', 'sewer',
    'fiber optic', 'flock camera', 'weatherization', 'utility',
    // Real-estate / county bulletins
    'property (?:value|records)', 'real estate tax', 'damage assessment',
    'tax relief', 'tax deadline', 'fraud', 'sanitary',
    // Public-health / weather advisories
    'advisory', 'warming (?:center|station|)', 'stay-?at-?home', 'covid',
    'coronavirus', 'vaccin', 'mask', 'facial covering', 'emergency order',
    'executive order', 'extreme weather', 'off the ice', 'hand sanitizer',
    'testing', 'quarantine', 'pandemic', 'child care', 'unemployment',
    // Announcements / informational (not events)
    'census', 'survey', '\\bfaq', 'message from', 'statement', 'notice to',
    '\\bupdate', '\\breminder\\b', 'new logo', 'new .*chief', 'firefighters?',
    'interview', 'spotlight', 'history', 'watershed', 'rain garden',
    'dirty dozen', 'grant', 'assistance', 'relief', 'alert system',
    'text message', 'enewsflash', 'newsflash', 'when nature calls',
    'what is', 'what kind of', 'do you know', 'in case of emergency',
    'discount', 'transportation offered', 'donation', 'repaired', 'bus stop',
    'superintendent', 'emergency drill', 'temporarily closed', 'temporary hours',
    'program$', 'delivery program', 'mulch', 'latchkey',
  ].join('|'),
  'i',
)

/** A post is a candidate community event unless its title reads as news/notice. */
export function isCommunityEvent(title) {
  const t = stripHtml(String(title || '')).trim()
  if (!t) return false
  return !NEWS_RE.test(t.toLowerCase())
}

// ── Date / time parsing ──────────────────────────────────────────────────────

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

const MONTH_WORD =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|' +
  'aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'

// "Sat, Oct 25", "August 9", "June 16-20", "March 30, 2024"
const MONTH_FIRST_RE = new RegExp(
  String.raw`(?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?` +
  String.raw`\b(${MONTH_WORD})\s+(\d{1,2})(?:st|nd|rd|th)?` +
  String.raw`(?:\s*[-–—]\s*(\d{1,2})(?:st|nd|rd|th)?)?` +
  String.raw`(?:,?\s*(\d{4}))?`,
  'gi',
)

// "8/23", "12/13/2025", "6/22-6/26", "3/26-4/5"
const NUMERIC_RE =
  /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:\s*[-–—]\s*(\d{1,2})\/(\d{1,2}))?\b/g

// "4th of July" — a fixed date the village never spells out as "July 4".
const JULY4_RE = /\b4th\s+of\s+july\b/i

const monthNum = (w) => MONTHS[String(w).slice(0, 4).toLowerCase()] ?? MONTHS[String(w).slice(0, 3).toLowerCase()]

function fourDigitYear(y) {
  if (y == null) return null
  const n = parseInt(y, 10)
  if (n < 100) return 2000 + n
  return n
}

/** Infer a full year for a month/day that had none, anchored to the publish date. */
function inferYear(month, day, pubMs, pubYear) {
  let year = pubYear
  if (Date.UTC(year, month - 1, day) < pubMs - 45 * 86_400_000) year += 1
  return year
}

const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

// ── Time parsing (explicit meridiem only) ────────────────────────────────────
// Community-event times in titles are frequently written without a meridiem
// ("10:00-1:00", "1:00-4:00"). Guessing AM/PM would risk a 1am family-fun-day,
// so we parse a time ONLY when a meridiem (or noon/midnight) is explicit and
// otherwise ingest the event as date-only. Precision over recall.
const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)|\b(noon|midnight)\b`
const TIME_RANGE_RE = new RegExp(
  String.raw`(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))`,
  'i',
)
const TIME_SINGLE_RE = new RegExp(CLOCK, 'i')

function normalizeClock(tok, inheritMeridiem = null) {
  if (!tok) return null
  const t = String(tok).trim().toLowerCase()
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

/** Return { timeStr, endTimeStr } (explicit-meridiem only) or null. */
export function parseTime(text = '') {
  const range = text.match(TIME_RANGE_RE)
  if (range) {
    const end = normalizeClock(range[2])
    const start = normalizeClock(range[1], end?.endsWith('pm') ? 'pm' : end?.endsWith('am') ? 'am' : null)
    if (start && end) return { timeStr: start, endTimeStr: end }
  }
  const single = text.match(TIME_SINGLE_RE)
  if (single) {
    const t = normalizeClock(single[4] ?? single[0])
    if (t) return { timeStr: t, endTimeStr: null }
  }
  return null
}

/**
 * Parse an event date (and optional end date / time) out of title prose.
 * Returns { dateStr, endDateStr|null, timeStr|null, endTimeStr|null } or null.
 * `publishedIso` is used ONLY for year inference, never as the event date.
 */
export function parseEventDate(text = '', publishedIso = '') {
  if (!text) return null
  const pub = new Date(publishedIso)
  const pubMs = Number.isNaN(pub.getTime()) ? Date.now() : pub.getTime()
  const pubYear = new Date(pubMs).getUTCFullYear()

  const candidates = []
  const add = (month, day, year, index, endDate = null) => {
    if (!month || month < 1 || month > 12 || day < 1 || day > 31) return
    const y = year ?? inferYear(month, day, pubMs, pubYear)
    const ms = Date.UTC(y, month - 1, day)
    if (Number.isNaN(ms)) return
    candidates.push({
      index,
      explicitYear: year != null,
      future: ms >= pubMs - PAST_GRACE_MS,
      ms,
      dateStr: iso(y, month, day),
      endDateStr: endDate,
    })
  }

  // 1. "August 9", "Sat, Oct 25", "June 16-20", "March 30, 2024"
  for (const m of text.matchAll(MONTH_FIRST_RE)) {
    const month = monthNum(m[1])
    const day = parseInt(m[2], 10)
    const endDay = m[3] ? parseInt(m[3], 10) : null
    const year = m[4] ? fourDigitYear(m[4]) : null
    let endDate = null
    if (endDay && month) {
      const y = year ?? inferYear(month, day, pubMs, pubYear)
      // A "16-20" range shares the month; an end day < start day is ignored.
      if (endDay >= day && endDay <= 31) endDate = iso(y, month, endDay)
    }
    add(month, day, year, m.index, endDate)
  }

  // 2. Numeric "8/23", "12/13/2025", "6/22-6/26", "3/26-4/5"
  for (const m of text.matchAll(NUMERIC_RE)) {
    const month = parseInt(m[1], 10)
    const day = parseInt(m[2], 10)
    const year = m[3] ? fourDigitYear(m[3]) : null
    if (month < 1 || month > 12 || day < 1 || day > 31) continue
    let endDate = null
    if (m[4] && m[5]) {
      const em = parseInt(m[4], 10)
      const ed = parseInt(m[5], 10)
      const y = year ?? inferYear(month, day, pubMs, pubYear)
      if (em >= 1 && em <= 12 && ed >= 1 && ed <= 31) {
        // Range may roll into the next month/year (e.g. Dec 30 - Jan 2).
        let ey = y
        if (em < month) ey += 1
        endDate = iso(ey, em, ed)
      }
    }
    add(month, day, year, m.index, endDate)
  }

  // 3. "4th of July" — only when nothing more specific matched.
  if (!candidates.length) {
    const j = text.match(JULY4_RE)
    if (j) add(7, 4, null, j.index)
  }

  if (!candidates.length) return null

  // Prefer an explicit-year future date, then any future date, then explicit
  // year, then the first mention. Mirrors the akronym picker.
  const pick =
    candidates.find(c => c.explicitYear && c.future) ??
    candidates.find(c => c.future) ??
    candidates.find(c => c.explicitYear) ??
    candidates[0]

  const times = parseTime(text)
  return {
    dateStr: pick.dateStr,
    endDateStr: pick.endDateStr,
    timeStr: times?.timeStr ?? null,
    endTimeStr: times?.endTimeStr ?? null,
  }
}

// ── Venue resolution ─────────────────────────────────────────────────────────
//
// Titles name a handful of village facilities ("at the RAC", "at City Hall",
// "at Heritage Hall", "at Fire Station"). We map those to real venue records;
// everything else falls back to a village-wide venue at City Hall. Addresses
// are taken from reminderville.com facility pages. Reminderville shares the
// 44202 ZIP with Aurora but is a Summit County municipality (classified by
// city, not ZIP).
const CITY = 'Reminderville'
const STATE = 'OH'
const ZIP = '44202'

const DEFAULT_VENUE = {
  name: 'Village of Reminderville',
  address: '3382 Glenwood Blvd',
  city: CITY, state: STATE, zip: ZIP,
}

const KNOWN_VENUES = [
  [/\brac\b|athletic club|recreation center|community center/i, {
    name: 'Reminderville Athletic Club',
    address: '3100 Glenwood Blvd', city: CITY, state: STATE, zip: ZIP,
  }],
  [/heritage hall|ray williams park/i, {
    name: 'Heritage Hall', address: '3601 Glenwood Blvd',
    city: CITY, state: STATE, zip: ZIP,
  }],
  [/city hall/i, {
    name: 'Reminderville City Hall', address: '3382 Glenwood Blvd',
    city: CITY, state: STATE, zip: ZIP,
  }],
  [/fire station|fire department/i, {
    // No public street address published; city-only is fine for the Summit gate.
    name: 'Reminderville Fire Station', address: null,
    city: CITY, state: STATE, zip: ZIP,
  }],
]

/**
 * Resolve a venue spec from title text. A neighbouring-town mention overrides
 * the city so the Summit gate can drop cross-posted out-of-county items
 * (Aurora is Portage County).
 */
export function resolveVenue(title = '') {
  const t = String(title)
  let spec = KNOWN_VENUES.find(([re]) => re.test(t))?.[1] ?? DEFAULT_VENUE
  if (/\baurora\b/i.test(t)) spec = { ...spec, name: 'Aurora', address: null, city: 'Aurora' }
  return spec
}

// ── Facets ───────────────────────────────────────────────────────────────────

const FAMILY_RE =
  /\bkids?\b|children|family|easter|egg|halloween|santa|toy delivery|safety town|art show|story ?time|scavenger hunt|bingo/i

export function isFamilyEvent(title = '') {
  return FAMILY_RE.test(String(title))
}

// A few confident content-category overrides; otherwise inferCategory decides.
const CATEGORY_OVERRIDES = [
  [/parade|fun day|eggstravaganza|halloween|festival|palooza|carp roundup|meet ?& ?greet|meet and greet/i, 'festival'],
  [/spaghetti dinner|pancake|breakfast|lunch|chili|cookout|grill/i, 'food'],
  [/workshop|safety town|art show|story ?time|lunch & learn|lunch and learn/i, 'learning'],
  [/eclipse/i, 'outdoors'],
]

export function categoryFor(title = '') {
  const hit = CATEGORY_OVERRIDES.find(([re]) => re.test(title))
  if (hit) return hit[1]
  return inferCategory(title, '')
}

// ── Row construction (pure) ──────────────────────────────────────────────────

function extractImage(post) {
  const media = post?._embedded?.['wp:featuredmedia']?.[0]
  if (media?.source_url) return media.source_url
  if (media?.media_details?.sizes?.large?.source_url) return media.media_details.sizes.large.source_url
  const match = (post?.content?.rendered ?? '').match(/<img[^>]+src="([^"]+)"/i)
  return match?.[1] ?? null
}

/**
 * Build an event row (+ venueSpec) from a WP post, or null for non-events /
 * undated posts. Pure — no DB access.
 */
export function buildRow(post) {
  if (!post || !post.title) return null
  const title = stripHtml(post.title.rendered ?? '').replace(/\s+/g, ' ').trim()
  if (!title) return null
  if (!isCommunityEvent(title)) return null

  const parsed = parseEventDate(title, post.date)
  if (!parsed) return null

  const start_at = easternToIso(parsed.dateStr, parsed.timeStr ?? '')
  if (!start_at) return null

  // End time / date.
  let end_at = null
  if (parsed.timeStr && parsed.endTimeStr) {
    end_at = easternToIso(parsed.dateStr, parsed.endTimeStr)
    if (end_at && end_at <= start_at) end_at = null
  } else if (parsed.timeStr && !parsed.endDateStr) {
    // Timed single-day event with no explicit end — default 3-hour duration.
    end_at = new Date(new Date(start_at).getTime() + 3 * 3600_000).toISOString()
  }
  if (parsed.endDateStr) {
    // Multi-day span: end at the (time-less) end date, overriding any 3h default.
    const spanEnd = easternToIso(parsed.endDateStr, parsed.endTimeStr ?? '')
    if (spanEnd && spanEnd > start_at) end_at = spanEnd
  }

  const venueSpec = resolveVenue(title)
  const category = categoryFor(title)

  return {
    venueSpec,
    row: {
      title,
      description: null,
      start_at,
      end_at,
      category,
      is_family: isFamilyEvent(title) || undefined,
      tags: ['reminderville', 'summit-county'],
      price_min: null,
      price_max: null,
      age_restriction: 'all_ages',
      image_url: extractImage(post),
      ticket_url: post.link ?? LANDING_URL,
      source_url: post.link ?? LANDING_URL,
      source: SOURCE_KEY,
      source_id: String(post.id),
      status: 'published',
      featured: false,
    },
  }
}

/** True when the event window overlaps [now - grace, now + horizon]. */
export function isWithinWindow(startUtc, endUtc, nowMs = Date.now()) {
  if (!startUtc) return false
  const startMs = new Date(startUtc).getTime()
  const endMs = endUtc ? new Date(endUtc).getTime() : startMs
  if (Number.isNaN(startMs)) return false
  if (endMs < nowMs - PAST_GRACE_MS) return false
  if (startMs > nowMs + HORIZON_DAYS * 86_400_000) return false
  return true
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchAllPosts() {
  const all = []
  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const url = new URL(`${WP_BASE}/posts`)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))
    url.searchParams.set('status', 'publish')
    url.searchParams.set('_embed', 'true')
    url.searchParams.set('_fields', 'id,date,link,title,content,_links,_embedded')

    const res = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; AkronPulseBot/1.0)',
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
    all.push(...JSON.parse(text))
    page++
    if (page <= totalPages) await new Promise(r => setTimeout(r, 150))
  }
  return all
}

// ── Venue / organizer ────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureRvVenue(venueSpec, organizerId) {
  if (venueCache.has(venueSpec.name)) return venueCache.get(venueSpec.name)
  const venueId = await ensureVenue(venueSpec.name, {
    address: venueSpec.address || undefined,
    city: venueSpec.city,
    state: venueSpec.state,
    zip: venueSpec.zip,
    website: ORIGIN,
  })
  if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
  venueCache.set(venueSpec.name, venueId)
  return venueId
}

async function ensureRvOrg() {
  return ensureOrganization('Village of Reminderville', {
    website: ORIGIN,
    description:
      'The Village of Reminderville, Ohio (Summit County). Hosts community ' +
      'events including the 4th of July Parade, Family Fun Day, the Easter ' +
      'Eggstravaganza, Safety Town, and the annual Santa Toy Delivery.',
  })
}

// ── Upsert pipeline ──────────────────────────────────────────────────────────

async function processEvents(prepared, organizerId) {
  let inserted = 0
  let skipped = 0

  for (const { row, venueSpec } of prepared) {
    try {
      const geo = classifySummitLocation({ city: venueSpec.city })
      if (geo === 'out') {
        skipped++
        continue
      }
      if (geo === 'unknown') {
        row.status = 'pending_review'
        row.needs_review = true
      }

      const venueId = await ensureRvVenue(venueSpec, organizerId)
      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${row.title}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Village of Reminderville ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    const organizerId = DRY_RUN ? null : await ensureRvOrg()

    console.log('\n🔍  Fetching Reminderville WP posts…')
    const posts = await fetchAllPosts()
    console.log(`  Feed returned ${posts.length} post(s).`)

    const now = Date.now()
    const built = posts.map(buildRow).filter(Boolean)
    console.log(`  ${built.length} dated community event(s) after dropping news/notices.`)

    const seen = new Set()
    const prepared = built.filter(b => {
      if (!isWithinWindow(b.row.start_at, b.row.end_at, now)) return false
      if (seen.has(b.row.source_id)) return false
      seen.add(b.row.source_id)
      return true
    })
    console.log(`  ${prepared.length} within the ${HORIZON_DAYS}-day window.`)

    if (DRY_RUN) {
      for (const { row, venueSpec } of prepared) {
        console.log(`     • ${row.title}\n       ${row.start_at}${row.end_at ? ` → ${row.end_at}` : ''}  cat=${row.category}  @ ${venueSpec.name}`)
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run] — ${prepared.length} event(s) prepared`)
      return
    }

    console.log(`\n📥  Processing ${prepared.length} event(s)…`)
    const { inserted, skipped } = await processEvents(prepared, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: prepared.length,
      durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes the pure parsers
// without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
