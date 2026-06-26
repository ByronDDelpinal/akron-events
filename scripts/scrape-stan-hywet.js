/**
 * scrape-stan-hywet.js
 *
 * Scrapes upcoming public events from Stan Hywet Hall & Gardens.
 * Platform: Drupal 7. The /public-events listing renders a static, stable
 * markup of `<div class="event-item clearfix">` cards containing:
 *   - `<div class="left"><a><img/></a></div>` — thumbnail (Drupal image style)
 *   - `<div class="alert">…</div>` — optional one-line teaser
 *   - `<div><h2><a href="/events/SLUG">Title</a></h2></div>` — title + canonical link
 *   - `<p class="date">…</p>` — human-formatted date (many shapes)
 *
 * Why a dedicated scraper: Stan Hywet sells tickets through their own
 * platform (stanhywet.ticketapp.org), not Eventbrite or Ticketmaster, so the
 * citywide geo-aggregators don't catch their events. The estate runs ~10–15
 * public events per month April–December (Ohio Mart, Father's Day Car Show,
 * Murder Mystery weekends, Coffee with the Curator, etc.) and a much sparser
 * winter cadence. Zero-event runs in Jan–Feb are normal, not alerting.
 *
 * Date-format heterogeneity is the main parsing risk. Examples in the wild:
 *   - "May 28 | 6pm-7:30pm"               → specific date + time
 *   - "May 23–September 13, 2026"          → date range (use start)
 *   - "Sundays through 10/25/26"           → recurring (use today)
 *   - "Continues until the End of May"     → open-ended (skip)
 *   - "April 21, 2026"                     → full date
 * We parse what we can and skip events with no resolvable start date rather
 * than synthesise a date that might be wrong.
 *
 * Usage:
 *   node scripts/scrape-stan-hywet.js
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

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY   = 'stan_hywet'
const SOURCE_URL   = 'https://stanhywet.org/public-events'
const BASE_DOMAIN  = 'https://stanhywet.org'

// Drupal image-style prefix we strip when normalising thumbnail → full image
const DRUPAL_STYLE_RE = /\/files\/styles\/[^/]+\/public\//

const DEFAULT_TIME = '09:00:00'   // when only a date is given

// ── Date parsing ───────────────────────────────────────────────────────────

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

/**
 * Build a 24h "HH:MM:SS" string from an hour, optional minutes and a meridiem.
 * Returns null when the meridiem is missing (we never guess am vs pm).
 */
function buildTime(hour, minute, meridiem) {
  if (!meridiem) return null
  let hr = parseInt(hour, 10)
  if (Number.isNaN(hr) || hr < 1 || hr > 12) return null
  const min = minute ?? '00'
  const mer = meridiem.toLowerCase()
  if (mer === 'pm' && hr !== 12) hr += 12
  if (mer === 'am' && hr === 12) hr = 0
  return `${String(hr).padStart(2, '0')}:${min}:00`
}

// Meridiem fragment that tolerates the periods/spaces Stan Hywet uses in the
// wild — "a.m.", "p.m.", "A.M." all collapse to "am"/"pm" before matching.
function normalizeMeridiems(raw) {
  return raw.replace(/\b([ap])\.?\s*m\.?/gi, '$1m')
}

/**
 * Extract the START time from a Stan Hywet date string → "HH:MM:SS" or null.
 *
 * Two real-world quirks drove this:
 *   1) Ranges quote the meridiem only once: "11:00-11:30am", "5:30-8:30pm",
 *      "12:00–1:00pm". We must take the START and let it INHERIT the end's
 *      am/pm — the old code grabbed the first am/pm-qualified token, which was
 *      the END (stored 11:30 for an 11:00 start, 8:30pm for a 5:30 start).
 *   2) Times are written "10:30 a.m." with periods, which the old regex missed
 *      entirely and silently fell back to the 09:00 default.
 * Requiring the END of a range to carry a meridiem also keeps day ranges like
 * "July 9-26 | 7:30pm" from being misread as a time range.
 */
export function extractStartTime(raw) {
  if (!raw) return null
  const s = normalizeMeridiems(raw)

  // Range: START[meridiem?] - END meridiem  → take START, inherit END's am/pm.
  const range = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–—]\s*\d{1,2}(?::(\d{2}))?\s*(am|pm)/i)
  if (range) {
    const startMeridiem = range[3] || range[5]
    const t = buildTime(range[1], range[2], startMeridiem)
    if (t) return t
  }

  // Single time: "6pm", "7:30pm", "10:30am".
  const single = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (single) {
    const t = buildTime(single[1], single[2], single[3])
    if (t) return t
  }

  return null
}

/**
 * Resolve an event's START time, preferring the listing's `.date` line but
 * falling back to the description prose before settling for the 09:00 default.
 *
 * Why: several Stan Hywet programs keep the date in the `.date` line yet state
 * the time only in the body copy — e.g. Nature Sprouts lists "July 7, and
 * August 4" in `.date` but "All sessions run 10:30 - 11:30 a.m." in the
 * description. The old code only looked at the date line, so these silently
 * stored 09:00 (off by 1.5h for Nature Sprouts; caught by the nightly audit).
 * The prose is parsed with the same extractStartTime rules (ranges inherit the
 * end's meridiem; phone numbers and other dash-joined digits never match
 * because a clock time requires an am/pm token), so a misread is unlikely and,
 * when it happens, is still strictly better than the blind 09:00 default.
 */
export function resolveStartTime(dateText, descriptionText) {
  return (
    extractStartTime(dateText) ??
    extractStartTime(descriptionText) ??
    DEFAULT_TIME
  )
}

// Month names (longest-first so "sept"/"june" win over "sep"/"jun").
const MONTH_ALTERNATION = Object.keys(MONTH_MAP)
  .sort((a, b) => b.length - a.length)
  .join('|')
const DATE_TOKEN_RE = new RegExp(
  `\\b(${MONTH_ALTERNATION})\\b\\.?\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?`,
  'gi',
)

function toYmd(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(parseInt(day, 10)).padStart(2, '0')}`
}

/**
 * Many Stan Hywet programs run on several discrete dates listed together,
 * e.g. "August 9, October 25, & December 6 | 11am" or "July 7, and August 4".
 * Surface the next UPCOMING occurrence rather than blindly the first one — the
 * old code took the first token, and when that date had already passed its
 * year-rollover heuristic pushed it a full year into the future (a Photography
 * Walk listed as "May 31, … October 25" was stored as next-year May 31).
 * Returns a { dateStr } for the soonest date >= today, or null when the string
 * holds fewer than two dates (single-date events keep their existing handling).
 */
function pickUpcomingFromList(s, nowYear) {
  const tokens = [...s.matchAll(DATE_TOKEN_RE)]
    .map((m) => {
      const month = MONTH_MAP[m[1].toLowerCase()]
      if (!month) return null
      const year = m[3] ? parseInt(m[3], 10) : nowYear
      return { dateStr: toYmd(year, month, m[2]), ms: Date.UTC(year, month - 1, parseInt(m[2], 10)) }
    })
    .filter(Boolean)

  if (tokens.length < 2) return null

  const todayMs = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime() })()
  const upcoming = tokens.filter((t) => t.ms >= todayMs).sort((a, b) => a.ms - b.ms)
  const chosen = upcoming[0] ?? tokens.sort((a, b) => a.ms - b.ms)[0]
  return { dateStr: chosen.dateStr }
}

/**
 * Parse Stan Hywet's `<p class="date">` text into { dateStr, timeStr,
 * endDateStr }.  Strategies, in order:
 *   1) Numeric range with year:   "9/13/26", "10/25/26"  (recurring marker)
 *   2) Month-range with year:     "May 23–September 13, 2026"
 *   3) Same-month range:          "October 9-11, 2026"
 *   4) Multi-date list:           "August 9, October 25, & December 6" → next
 *   5) Full date:                 "April 21, 2026"
 *   6) Short date (no year):      "October 30" → infer current/next year
 * Returns nulls when nothing parses; the caller skips the event in that case.
 */
export function parseStanHywetDate(raw) {
  if (!raw) return { dateStr: null, timeStr: DEFAULT_TIME, endDateStr: null }
  const s = raw.replace(/–|—/g, '-').trim()
  const nowYear = new Date().getFullYear()

  // Inline start time (handles ranges, inherited meridiems and "a.m."/"p.m.").
  const timeStr = extractStartTime(s) ?? DEFAULT_TIME

  // 1) Numeric M/D/YY-range fragment ("Sundays through 10/25/26")
  const numericRange = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  const recurringMarker = /sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|weekly|every/i.test(s)
  if (numericRange && recurringMarker) {
    // Recurring event with an end date — start "today" so it surfaces immediately.
    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const [, mm, dd, yy] = numericRange
    const year = yy.length === 2 ? 2000 + parseInt(yy, 10) : parseInt(yy, 10)
    const endDateStr = `${year}-${String(parseInt(mm, 10)).padStart(2, '0')}-${String(parseInt(dd, 10)).padStart(2, '0')}`
    return { dateStr, timeStr, endDateStr }
  }

  // 2) Month-range with year — "May 23–September 13, 2026"
  const monthRange = s.match(/([A-Za-z]+)\s+(\d{1,2})\s*-\s*([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})/)
  if (monthRange) {
    const [, m1, d1, m2, d2, year] = monthRange
    const startMonth = MONTH_MAP[m1.toLowerCase()]
    const endMonth   = MONTH_MAP[m2.toLowerCase()]
    if (startMonth && endMonth) {
      const dateStr    = `${year}-${String(startMonth).padStart(2, '0')}-${String(parseInt(d1, 10)).padStart(2, '0')}`
      const endDateStr = `${year}-${String(endMonth).padStart(2, '0')}-${String(parseInt(d2, 10)).padStart(2, '0')}`
      return { dateStr, timeStr, endDateStr }
    }
  }

  // 3) Same-month range — "October 9-11, 2026"
  const sameMonthRange = s.match(/([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2}),?\s*(\d{4})/)
  if (sameMonthRange) {
    const [, mon, d1, d2, year] = sameMonthRange
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      const dateStr    = `${year}-${String(m).padStart(2, '0')}-${String(parseInt(d1, 10)).padStart(2, '0')}`
      const endDateStr = `${year}-${String(m).padStart(2, '0')}-${String(parseInt(d2, 10)).padStart(2, '0')}`
      return { dateStr, timeStr, endDateStr }
    }
  }

  // 4) Multi-date list — "August 9, October 25, & December 6" → next upcoming.
  //    Runs after the range strategies so true ranges keep their start+end.
  const upcoming = pickUpcomingFromList(s, nowYear)
  if (upcoming) {
    return { dateStr: upcoming.dateStr, timeStr, endDateStr: null }
  }

  // 5) Full date — "April 21, 2026"
  const fullDate = s.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/)
  if (fullDate) {
    const [, mon, day, year] = fullDate
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      return {
        dateStr: `${year}-${String(m).padStart(2, '0')}-${String(parseInt(day, 10)).padStart(2, '0')}`,
        timeStr,
        endDateStr: null,
      }
    }
  }

  // 6) Short date — "May 28 | 6pm" or "May 28"
  const shortDate = s.match(/([A-Za-z]+)\s+(\d{1,2})\b/)
  if (shortDate) {
    const [, mon, day] = shortDate
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      // Infer year: if the resulting date is in the past, roll to next year.
      // This handles Dec listings in November.
      let year = nowYear
      const candidate = new Date(Date.UTC(year, m - 1, parseInt(day, 10)))
      const today     = new Date(); today.setUTCHours(0, 0, 0, 0)
      if (candidate < today) year += 1
      return {
        dateStr: `${year}-${String(m).padStart(2, '0')}-${String(parseInt(day, 10)).padStart(2, '0')}`,
        timeStr,
        endDateStr: null,
      }
    }
  }

  return { dateStr: null, timeStr, endDateStr: null }
}

// ── HTML fetch + parse ─────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0; +https://akronpulse.com)',
      'Accept':     'text/html,application/xhtml+xml',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

function resolveUrl(href) {
  if (!href) return null
  if (/^https?:/.test(href)) return href
  return BASE_DOMAIN + (href.startsWith('/') ? '' : '/') + href
}

/**
 * Strip Drupal's `/files/styles/<name>/public/` prefix so we store the
 * full-resolution image rather than the listing-page thumbnail.
 */
function normalizeImage(src) {
  if (!src) return null
  const full = resolveUrl(src)
  if (!full) return null
  return full.replace(DRUPAL_STYLE_RE, '/files/')
}

/**
 * Fetch the full event description from a Stan Hywet detail page.
 *
 * The /public-events listing only exposes an optional one-line `.alert`
 * teaser; the real, multi-paragraph description lives on the per-event
 * Drupal node at /events/{slug} inside `<div class="field-body">`. We
 * pull that on the second pass so the event detail page has the full
 * write-up rather than a blank "About this event" section.
 *
 * Failures here are non-fatal — we fall back to the listing teaser
 * (which may itself be empty). Returning null lets the caller decide.
 */
async function fetchEventDescription(href) {
  if (!href) return null
  try {
    const html = await fetchHtml(href)
    // Match the .field-body div and its inner HTML. Drupal nests this
    // inside the event node; the regex is non-greedy to stop at the
    // first closing tag, which is enough because field-body never
    // contains its own block-level wrapper.
    const m = html.match(/<div[^>]*class="[^"]*field-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|<\/div>|<footer|<aside)/i)
    if (!m) return null
    const text = htmlToText(m[1] || '').trim()
    return text || null
  } catch (err) {
    console.warn(`  ⚠ Could not fetch description for ${href}: ${err.message}`)
    return null
  }
}

/**
 * Parse the `.event-item` cards out of the listing HTML.  Returns an array
 * of raw event records {title, dateText, alertText, href, imageUrl, slug}.
 */
function parseEventCards(html) {
  const cards = []
  const seen  = new Set()

  // Capture each card.  The closing `</div>` for `.event-item` is followed
  // by another `.event-item` opener OR the listing wrapper close — we use a
  // lookahead so cards stay independent.
  const cardRe = /<div[^>]*class="[^"]*event-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*event-item|<\/div>\s*<div[^>]*class="(?:view-footer|item-list)|<\/div>\s*<\/div>)/gi

  for (const match of html.matchAll(cardRe)) {
    const inner = match[1]

    // Title + slug
    const titleMatch = inner.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i)
    if (!titleMatch) continue
    const href  = resolveUrl(titleMatch[1])
    const title = stripHtml(titleMatch[2])
    if (!title || title.length < 3) continue

    // Slug from href becomes the source_id (stable per event regardless of
    // listing position).  Falls back to slugified title.
    const slugMatch = (titleMatch[1] || '').match(/\/events\/([^/?#]+)/)
    const slug = slugMatch
      ? slugMatch[1]
      : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

    if (seen.has(slug)) continue
    seen.add(slug)

    // Date
    const dateMatch = inner.match(/<p[^>]*class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    const dateText  = dateMatch ? stripHtml(dateMatch[1]) : null

    // Optional teaser
    const alertMatch = inner.match(/<div[^>]*class="[^"]*alert[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    const alertText  = alertMatch ? stripHtml(alertMatch[1]) : null

    // Image
    const imgMatch = inner.match(/<img[^>]*src="([^"]+)"/i)
    const imageUrl = imgMatch ? normalizeImage(imgMatch[1]) : null

    cards.push({ title, slug, href, dateText, alertText, imageUrl })
  }

  return cards
}

// ── Venue / Organizer ──────────────────────────────────────────────────────

async function ensureStanHywetVenue() {
  return ensureVenue('Stan Hywet Hall & Gardens', {
    address:       '714 N Portage Path',
    city:          'Akron',
    state:         'OH',
    zip:           '44303',
    lat:           41.1206,
    lng:           -81.5605,
    parking_type:  'lot',
    parking_notes: 'Free on-site parking; overflow on Portage Path during major events.',
    website:       'https://stanhywet.org',
    description:   "Tudor Revival country estate built by Goodyear Tire & Rubber co-founder F.A. Seiberling, on the National Register of Historic Places. Public programming includes Ohio Mart, the Father's Day Car Show, Murder Mystery weekends, and Coffee with the Curator.",
  })
}

async function ensureStanHywetOrganizer() {
  return ensureOrganization('Stan Hywet Hall & Gardens', {
    website:     'https://stanhywet.org',
    description: 'Historic estate and gardens museum operating the former F.A. Seiberling residence as a public-events venue.',
  })
}

// ── Tag mapping ────────────────────────────────────────────────────────────

function parseTags(title = '', alert = '') {
  const text = `${title} ${alert}`.toLowerCase()
  const tags = ['historic-estate']
  if (/garden|plant|bloom|flower/.test(text)) tags.push('gardens')
  if (/family|kids|children|junior/.test(text))  tags.push('family')
  if (/holiday|christmas|halloween|murder mystery/.test(text)) tags.push('seasonal')
  if (/car show|cars/.test(text)) tags.push('cars')
  if (/lecture|talk|history|curator/.test(text)) tags.push('lecture')
  return [...new Set(tags)]
}

// ── Process ────────────────────────────────────────────────────────────────

async function processEvents(cards, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const card of cards) {
    try {
      const { dateStr, timeStr, endDateStr } = parseStanHywetDate(card.dateText)
      if (!dateStr) {
        console.warn(`  ⚠ Skipping "${card.title}" — unparseable date: "${card.dateText}"`)
        skipped++
        continue
      }

      // Provisional start, used only for the past-event filter below. The
      // final start time may be refined once the description prose is in hand
      // (see resolveStartTime) — the refinement only shifts the clock time
      // within the same day, so it never changes the past/future decision.
      const provisionalStart = easternToIso(`${dateStr} ${timeStr}`)
      const endAt   = endDateStr ? easternToIso(`${endDateStr} 23:59:59`) : null
      if (!provisionalStart) { skipped++; continue }

      // Filter past events.  Range events whose end is still in the future
      // count as upcoming.
      const startMs = new Date(provisionalStart).getTime()
      const endMs   = endAt ? new Date(endAt).getTime() : startMs
      if (endMs < Date.now() - 86_400_000) { skipped++; continue }

      // Prefer the full description from the event's detail page;
      // fall back to the listing teaser only if the detail fetch
      // failed or the field-body was empty. This keeps the event
      // detail page from rendering a bare "No description available."
      // for events the source obviously has copy for.
      const detailDescription = await fetchEventDescription(card.href)
      const description = detailDescription
        ?? (card.alertText && card.alertText.length > 0 ? card.alertText : null)

      // Recover the time from the description when the `.date` line had none.
      const effectiveTime = resolveStartTime(card.dateText, description ?? '')
      const startAt = effectiveTime === timeStr
        ? provisionalStart
        : easternToIso(`${dateStr} ${effectiveTime}`)
      if (!startAt) { skipped++; continue }

      const row = {
        title:           card.title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        category:        inferCategory(card.title, description ?? ''),
        tags:            parseTags(card.title, card.alertText ?? ''),
        price_min:       null,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       card.imageUrl,
        ticket_url:      card.href ?? 'https://stanhywet.org/public-events',
        source:          SOURCE_KEY,
        source_id:       card.slug,
        status:          'published',
        featured:        false,
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${card.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Stan Hywet ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([
      ensureStanHywetVenue(),
      ensureStanHywetOrganizer(),
    ])
    if (venueId && organizerId) {
      await linkOrganizationVenue(organizerId, venueId)
    }

    console.log(`\n🔍  Fetching ${SOURCE_URL}…`)
    const html  = await fetchHtml(SOURCE_URL)
    const cards = parseEventCards(html)
    console.log(`  Found ${cards.length} event cards`)

    if (cards.length === 0) {
      console.warn('  ⚠ No event cards parsed. If unexpected, inspect /public-events — Drupal markup may have changed.')
    }

    console.log(`\n📥  Processing ${cards.length} events…`)
    const { inserted, skipped } = await processEvents(cards, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: cards.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-stan-hywet.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
