/**
 * scrape-cfalls-natatorium.js
 *
 * The Natatorium — the City of Cuyahoga Falls' municipal fitness/aquatic
 * center (2345 4th St, Cuyahoga Falls OH 44221, Summit County). Its
 * "What's New at the Nat" news page (https://www.fallsnat.com/news) is a
 * Drupal 11 blog list, NOT an events calendar: posts carry NO structured
 * date fields — every event date/time lives in the prose of the post body
 * (e.g. "Thursdays, May 21 & 28, 2026, from 11:00 a.m. - 12:00 p.m." or
 * "4 Weeks / July 12 - August 2 … Yoga - 9:15 a.m.").
 *
 * Strategy (news-blend, precision over recall):
 *   1. Fetch the /news list → { slug, title } for each post card.
 *   2. Fetch each post's detail page → full body text (htmlToText for line
 *      structure) + the Amilia registration link.
 *   3. Classify: skip non-events (membership deals/promos, closures, hour
 *      changes) and youth camps (internal youth programs). Only posts that
 *      resolve to a concrete UPCOMING date + an EXPLICIT clock time survive
 *      (swim meets/open swims, community wellness classes, dated series).
 *   4. Parse dates from prose — month-name dates ("May 21 & 28, 2026"),
 *      numeric m/d dates ("7/19"), and cross-/same-month ranges — never the
 *      (absent) publish date. A recurring series that enumerates its session
 *      dates is ingested as ONE rolling card anchored to the NEXT upcoming
 *      session (source_id = slug, no date suffix): each twice-daily scrape
 *      re-points start_at at the next session, so there is exactly one card
 *      per program and no per-instance bloat (see review-queue-cleanup +
 *      sustainable-through-scrape lessons).
 *   5. Time comes from the FIRST explicit-meridiem clock in the body (the
 *      first class time), positionally BEFORE the trailing "Kids Castle open
 *      from 9 a.m. to Noon" facility note — never guess a meridiem, never
 *      synthesize a default time. Time-less posts are skipped, not defaulted
 *      (akronym/stan_hywet lessons).
 *
 * Single fixed Summit County venue → status always 'published' (no geo
 * ambiguity). Overlaps possible with city_of_cuyahoga_falls (municipal Parks
 * & Rec programming) — cross-source dedupe handles that downstream.
 *
 * Usage:
 *   node scripts/scrape-cfalls-natatorium.js
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
  htmlToText,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  easternToIso,
  inferCategory,
} from './lib/normalize.js'

const SOURCE_KEY = 'cfalls_natatorium'
const BASE       = 'https://www.fallsnat.com'
const NEWS_URL   = `${BASE}/news`
const DAYS_AHEAD = 180
const DAY_MS     = 86_400_000

const UA = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.org)'

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}
const MONTH_ALT = Object.keys(MONTHS).join('|')

// ── List parsing ────────────────────────────────────────────────────────────

/**
 * Extract { slug, title, url } for every news post card on the /news list.
 * Cards render as `<a href="/news/<slug>" class="wrap"><h3>Title</h3>…`.
 * Deduped by slug (a slug may be linked more than once).
 */
export function parseNewsList(html = '') {
  const out = []
  const seen = new Set()
  const re = /href="\/news\/([a-z0-9][a-z0-9-]*)"[^>]*>\s*<h3>([\s\S]*?)<\/h3>/gi
  let m
  while ((m = re.exec(html))) {
    const slug = m[1]
    if (seen.has(slug)) continue
    const title = stripHtml(m[2])
    if (!title) continue
    seen.add(slug)
    out.push({ slug, title, url: `${BASE}/news/${slug}` })
  }
  return out
}

/**
 * Pull the readable body text + the Amilia registration link out of a post's
 * detail page. Body is confined to the <article> element; htmlToText keeps
 * line breaks so date/time prose stays on separate lines.
 */
export function extractArticleParts(detailHtml = '') {
  const article = detailHtml.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? detailHtml
  const bodyText = htmlToText(article)

  // Prefer the body's program-specific registration link over the global
  // "memberships" promo link that appears in the page chrome.
  const programLink = detailHtml.match(
    /href="(https:\/\/app\.amilia\.com\/store\/[^"]*\/shop\/programs\/[^"]+)"/i,
  )?.[1]
  const registrationUrl = programLink ? programLink.replace(/&amp;/g, '&') : null

  return { bodyText, registrationUrl }
}

// ── Classification ──────────────────────────────────────────────────────────

// Membership drives / promotions and facility notices are not events.
const PROMO_RE   = /\b(deal|for the price of|\d+\s*%|sale ends|gift card|membership drive|sign up (?:now|today) to save)\b/i
const CLOSURE_RE = /\b(will be closed|is closed|are closed|closure|reopens?|re-?opening|hours? (?:change|update|will|are changing)|holiday hours|under (?:maintenance|construction))\b/i
// Youth camps are registration-based internal youth programs, not public events.
const CAMP_RE    = /\bcamps?\b/i
// Cancelled/postponed posts name it in the title ("CANCELED: Open Swim").
// Same title convention lib/civicplus.js uses — drop rather than publish.
const CANCELLED_RE = /\bcancell?ed\b|\bpostponed\b/i

/**
 * Decide whether a post is worth ingesting. Returns { skip:boolean, reason }.
 * (Date/time viability is checked separately in resolveEventTiming.)
 */
export function classifyPost(title = '', bodyText = '') {
  const hay = `${title}\n${bodyText}`
  if (CANCELLED_RE.test(title)) return { skip: true, reason: 'cancelled / postponed' }
  if (CAMP_RE.test(title))    return { skip: true, reason: 'youth camp (internal program)' }
  if (PROMO_RE.test(hay))     return { skip: true, reason: 'membership promo / deal (non-event)' }
  if (CLOSURE_RE.test(hay))   return { skip: true, reason: 'closure / hours notice (non-event)' }
  return { skip: false, reason: null }
}

// ── Date parsing ────────────────────────────────────────────────────────────

/** Infer a full year for a bare month/day, rolling forward if it is well past. */
function inferYear(month, day, refMs, refYear) {
  let year = refYear
  if (Date.UTC(year, month - 1, day) < refMs - 45 * DAY_MS) year += 1
  return year
}

/**
 * Collect every calendar date referenced in `text` as sorted unique
 * 'YYYY-MM-DD' strings. Handles:
 *   • month-name dates: "August 2", "March 8th - May 3rd, 2026"
 *   • same-month enumerations/ranges: "May 21 & 28", "16-18"
 *   • numeric dates: "7/19", "7/12/2026"
 * An explicit 4-digit year in the same clause wins; otherwise the year is
 * inferred from `refYmd` (today, America/New_York). The publish date is never
 * consulted — these posts do not expose one.
 */
export function parseDates(text = '', refYmd = '') {
  const [ry, rm, rd] = String(refYmd).split('-').map(Number)
  const refMs   = Date.UTC(ry, rm - 1, rd)
  const refYear = ry
  const found = new Set()

  // A single "phrase year" governs a post: in "March 8th - May 3rd, 2026" the
  // trailing year belongs to BOTH months even though it only touches the
  // second. Use the first plausible 20xx in the text as the default year for
  // any date that has no nearer explicit year. (Guarded to a sane window so a
  // stray "2026 membership" cannot warp dates by years.)
  const phraseYearRaw = text.match(/\b(20\d{2})\b/)?.[1]
  const phraseYear = phraseYearRaw && Math.abs(parseInt(phraseYearRaw, 10) - refYear) <= 1
    ? parseInt(phraseYearRaw, 10)
    : null

  const add = (month, day, year) => {
    if (!month || month < 1 || month > 12 || day < 1 || day > 31) return
    const y = year || phraseYear || inferYear(month, day, refMs, refYear)
    // Reject impossible calendar dates (e.g. Feb 30).
    const dt = new Date(Date.UTC(y, month - 1, day))
    if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return
    found.add(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }

  // Month-name dates, with same-month day continuations and a trailing year.
  const nameRe = new RegExp(String.raw`(${MONTH_ALT})\s+(\d{1,2})(?:st|nd|rd|th)?`, 'gi')
  let m
  while ((m = nameRe.exec(text))) {
    const month = MONTHS[m[1].toLowerCase()]
    const days = [parseInt(m[2], 10)]

    // Trailing "& 28", "-18", ", 30" chained day numbers in the SAME month.
    // The (?!\d) guard stops "28, 2026" from reading the year's "20" as a day;
    // a following letter (a new month/word) also ends the chain.
    let rest = text.slice(nameRe.lastIndex)
    let cont
    const contRe = /^\s*(?:[-–&,]|and|to)\s*(\d{1,2})(?:st|nd|rd|th)?(?!\d)/i
    while ((cont = rest.match(contRe))) {
      days.push(parseInt(cont[1], 10))
      rest = rest.slice(cont[0].length)
    }

    // Explicit year immediately trailing this clause (nearer than phraseYear).
    const year = rest.match(/^[\s,]*?(?:[-–&]|and|to)?[\s,]*?(20\d{2})\b/)?.[1]
    const y = year ? parseInt(year, 10) : null
    for (const d of days) add(month, d, y)
  }

  // Numeric m/d[/yyyy] dates.
  const numRe = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g
  while ((m = numRe.exec(text))) {
    const month = parseInt(m[1], 10)
    const day   = parseInt(m[2], 10)
    let year = null
    if (m[3]) year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)
    add(month, day, year)
  }

  return [...found].sort()
}

// ── Time parsing ────────────────────────────────────────────────────────────

const TIME_TOKEN_RE = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)|\b(noon|midnight)\b/i
const RANGE_END_RE  = /^\s*(?:–|—|-|to|until)\s*((?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))|noon|midnight)/i
// The trailing "Kids Castle open from 9 a.m. to Noon" child-watch note carries
// its own meridiem time. When the actual class times are written without a
// meridiem, that facility note would otherwise be mistaken for the event time,
// so strip it (to end of its line) BEFORE scanning. A body whose only
// meridiem-qualified time was the Kids Castle note then correctly yields no
// usable time and is skipped rather than timed to the child-watch window.
const FACILITY_NOTE_RE = /kids?\s*castle[^\n]*/gi

/** "4pm" / "10:30 a.m." / "noon" → "H:MM am|pm", or null. Requires meridiem. */
function normalizeClock(tok) {
  if (!tok) return null
  const t = tok.trim().toLowerCase()
  if (t === 'noon') return '12:00 pm'
  if (t === 'midnight') return '12:00 am'
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)$/)
  if (!m) return null
  const hour = parseInt(m[1], 10)
  if (hour < 1 || hour > 12) return null
  const minute = m[2] ?? '00'
  const mer = /^p/.test(m[3]) ? 'pm' : 'am'
  return `${hour}:${minute} ${mer}`
}

/**
 * The FIRST explicit-meridiem clock time in the body (the first class start),
 * with an optional range end. Only meridiem-qualified tokens count — a bare
 * "9:15" is ambiguous and never guessed. Returns { timeStr, endTimeStr } or
 * null when the post states no usable time.
 */
export function parseFirstTime(text = '') {
  const scan = String(text).replace(FACILITY_NOTE_RE, ' ')
  const m = scan.match(TIME_TOKEN_RE)
  if (!m) return null
  const startTok = m[4] ?? m[0]
  const timeStr = normalizeClock(startTok)
  if (!timeStr) return null

  const after = scan.slice(m.index + m[0].length)
  const end = after.match(RANGE_END_RE)
  const endTimeStr = end ? normalizeClock(end[1]) : null
  return { timeStr, endTimeStr }
}

// ── Timing resolution (pure, testable) ──────────────────────────────────────

/** America/New_York calendar date ('YYYY-MM-DD') for a UTC millisecond value. */
export function easternYmd(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/**
 * Resolve a post to a concrete upcoming start/end, or explain why it is
 * skipped. Returns either { skip:true, reason } or
 * { skip:false, dateStr, startAt, endAt, timeStr, endTimeStr }.
 */
export function resolveEventTiming(title = '', bodyText = '', nowMs = Date.now()) {
  const cls = classifyPost(title, bodyText)
  if (cls.skip) return { skip: true, reason: cls.reason }

  const text = `${title}. ${bodyText}`
  const refYmd = easternYmd(nowMs)
  const [ry, rm, rd] = refYmd.split('-').map(Number)
  const refMs   = Date.UTC(ry, rm - 1, rd)
  const cutoff  = refMs - DAY_MS               // keep today + anything not yet ended
  const horizon = refMs + DAYS_AHEAD * DAY_MS

  const dates = parseDates(text, refYmd)
  const upcoming = dates
    .map(d => {
      const [y, mo, da] = d.split('-').map(Number)
      return { d, ms: Date.UTC(y, mo - 1, da) }
    })
    .filter(x => x.ms >= cutoff && x.ms <= horizon)
    .sort((a, b) => a.ms - b.ms)

  if (!upcoming.length) return { skip: true, reason: 'no upcoming date in window' }
  const dateStr = upcoming[0].d

  const time = parseFirstTime(bodyText) ?? parseFirstTime(text)
  if (!time) return { skip: true, reason: 'no explicit time (not guessed)' }

  const startAt = easternToIso(dateStr, time.timeStr)
  if (!startAt) return { skip: true, reason: 'unparseable start' }

  let endAt = null
  if (time.endTimeStr) {
    endAt = easternToIso(dateStr, time.endTimeStr)
    if (endAt && endAt <= startAt) endAt = new Date(new Date(endAt).getTime() + DAY_MS).toISOString()
  }
  return { skip: false, dateStr, startAt, endAt, timeStr: time.timeStr, endTimeStr: time.endTimeStr }
}

/** First "$N" fee stated in the body → price_min (never assume free). */
export function parsePrice(bodyText = '') {
  const m = bodyText.match(/\$\s?(\d+(?:\.\d{2})?)/)
  if (!m) return { price_min: null, price_max: null }
  return { price_min: parseFloat(m[1]), price_max: null }
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return res.text()
}

// ── Venue / Organizer ───────────────────────────────────────────────────────

async function ensureNatVenue() {
  return ensureVenue('The Natatorium', {
    address:      '2345 4th St',
    city:         'Cuyahoga Falls',
    state:        'OH',
    zip:          '44221',
    lat:          41.1358,   // approximate (2345 Fourth St, Cuyahoga Falls)
    lng:          -81.4793,
    website:      BASE,
    description:  'The Natatorium — the City of Cuyahoga Falls municipal fitness and aquatic center (Summit County, OH).',
  })
}

async function ensureNatOrganizer() {
  return ensureOrganization('The Natatorium', {
    website:     BASE,
    description: 'Municipal fitness and aquatic center operated by the City of Cuyahoga Falls, OH.',
  })
}

// ── Process ─────────────────────────────────────────────────────────────────

async function processPosts(posts, venueId, organizerId) {
  const now = Date.now()
  let inserted = 0, skipped = 0
  const updated = 0

  for (const post of posts) {
    try {
      const detailHtml = await fetchText(post.url)
      const { bodyText, registrationUrl } = extractArticleParts(detailHtml)

      const timing = resolveEventTiming(post.title, bodyText, now)
      if (timing.skip) {
        console.log(`  ⏭  "${post.title}" — ${timing.reason}`)
        skipped++
        await new Promise(r => setTimeout(r, 120))
        continue
      }

      const description = bodyText.replace(/\s+/g, ' ').trim() || null
      const category = (() => {
        const c = inferCategory(post.title, bodyText)
        return c && c !== 'other' ? c : 'fitness'
      })()
      const tags = [...new Set([category, 'wellness', 'natatorium', 'cuyahoga falls'])]
      const { price_min, price_max } = parsePrice(bodyText)

      const row = {
        title:           post.title,
        description,
        start_at:        timing.startAt,
        end_at:          timing.endAt,
        category,
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       null, // site posts carry no images; fallback handled downstream
        ticket_url:      registrationUrl ?? post.url,
        source:          SOURCE_KEY,
        source_id:       post.slug,
        status:          'published',
        featured:        false,
      }

      const enriched = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enriched)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${post.title}": ${error.message}`)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        console.log(`  ✓ "${post.title}" — ${timing.dateStr} ${timing.timeStr}`)
        inserted++
      }
      await new Promise(r => setTimeout(r, 120))
    } catch (err) {
      console.warn(`  ⚠ Error on "${post.title}" (${post.url}): ${err.message}`)
      skipped++
    }
  }

  return { inserted, updated, skipped }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🏊  Starting The Natatorium (Cuyahoga Falls) ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId, listHtml] = await Promise.all([
      ensureNatVenue(),
      ensureNatOrganizer(),
      fetchText(NEWS_URL),
    ])

    const posts = parseNewsList(listHtml)
    console.log(`📥  Found ${posts.length} news posts: ${posts.map(p => p.slug).join(', ') || '(none)'}`)

    const { inserted, updated, skipped } = await processPosts(posts, venueId, organizerId)
    await logUpsertResult(SOURCE_KEY, inserted, updated, skipped, {
      eventsFound: posts.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
