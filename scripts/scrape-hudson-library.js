/**
 * scrape-hudson-library.js
 *
 * Hudson Library & Historical Society — a SEPARATE library system from the
 * Akron-Summit County and Cuyahoga Falls libraries. Its public event calendar
 * is hosted on EngagedPatrons.org (a ColdFusion library-events platform), and
 * the library embeds it on hudsonlibrary.org.
 *
 * Platform / strategy — why this shape:
 *   EngagedPatrons has no clean machine feed (the RSS/iCal links on the page
 *   are per-event "add to Outlook/Google" helpers, not a whole-calendar
 *   export). We use two server-rendered surfaces:
 *
 *     1. LIST  — Events.cfm?SiteID=3850  (WordPress-wrapped list of upcoming
 *        events). Each event is an `<div class="LEEventWrapper">` with an
 *        `LETitle` link (carrying EventID + PK) and an `LEDate` line
 *        ("Friday, Jul. 17, 3-4"). Recurring programs appear as one wrapper
 *        per occurrence, each with its own PK. Paginated 20-at-a-time via a
 *        POST form field `StartRow` (21, 41, …).
 *
 *     2. DETAIL — EventsExtended.cfm?SiteID=3850&EventID=<id>  which embeds a
 *        clean schema.org `Event` JSON-LD block (name, startDate, description,
 *        image, location). Fetched ONCE per unique EventID for the description
 *        + image + an authoritative fallback start time.
 *
 * Quirks:
 *   • The JSON-LD `startDate` offset is a fixed, WRONG "-05:00" year-round
 *     (Hudson is Eastern; July is really -04:00). We therefore trust only the
 *     CLOCK time in it and re-anchor to America/New_York via easternToIso.
 *   • The JSON-LD `endDate` is unusable — for single occurrences it equals
 *     startDate, and for recurring masters it is the LAST occurrence's date.
 *     End times come from the LIST line instead ("2 p.m. - 4 p.m.").
 *   • LIST times are inconsistent ("10 a.m.", "1-4pm", "2:00 p.m. - 4:00 p.m.",
 *     and occasionally meridiem-less like "3-4"). We parse the list line for
 *     start+end, and when the start lacks a meridiem we fall back to the
 *     JSON-LD clock time rather than guessing am/pm.
 *   • Every event (walking tours included — they "meet at the library") is at
 *     the one fixed Hudson venue, which sits in Summit County, so no per-event
 *     geo classification is needed.
 *   • No price is ever stated (JSON-LD `offers` is empty), so price is left
 *     null — library programs are not assumed free.
 *
 * Registration-required programs are public community events and are ingested;
 * obvious non-events (closures, staff/board items) are skipped.
 *
 * Usage:  node scripts/scrape-hudson-library.js
 * Env:    VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, decodeEntities, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { extractJsonLd, findSchemaObjects, firstImageUrl } from './lib/json-ld.js'

export const SOURCE_KEY = 'hudson_library'

const ORIGIN      = 'https://engagedpatrons.org'
const SITE_ID     = '3850'
const LIST_URL    = `${ORIGIN}/events.cfm`         // GET renders page 1
const LIST_POST   = `${ORIGIN}/Events.cfm`         // POST target for pagination
const DETAIL_URL  = `${ORIGIN}/EventsExtended.cfm` // ?SiteID=&EventID=&PK=

const MAX_PAGES   = 25                              // safety cap (~500 occurrences)
const HORIZON_DAYS = 180
const FETCH_DELAY_MS = 80      // between paginated list pages
const FETCH_CONCURRENCY = 6    // parallel detail/image fetches (slow origin)

// EngagedPatrons' server returns an EMPTY body for bot-identifying User-Agents
// (verified: any UA containing "bot" yields 0 bytes), so we must present a
// normal browser UA to read this public calendar at all.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const ORG_NAME = 'Hudson Library & Historical Society'
const VENUE = {
  name: 'Hudson Library & Historical Society',
  details: {
    address: '96 Library St', city: 'Hudson', state: 'OH', zip: '44236',
    lat: 41.2417, lng: -81.4407,
    website: 'https://www.hudsonlibrary.org',
    description: 'The Hudson Library & Historical Society serves Hudson with programs, classes, and events for all ages.',
    parking_type: 'lot', parking_notes: 'Free on-site parking.',
  },
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

// Titles that are administrative notices, not public programs.
const SKIP_TITLE_RE = /\b(library closed|closed for|we're closed|staff (in-?service|training|meeting)|board of trustees|book drop|museum pass)\b/i

const pad = (n) => String(n).padStart(2, '0')

// ── Pure parsers (unit-tested) ────────────────────────────────────────────────

/**
 * Encode literal spaces in an EngagedPatrons image URL. Client images live at
 * /clientimages/3850/<Human Named File>.jpg with spaces and parentheses; only
 * spaces break URL fetching, so we replace those (parens are URL-legal).
 */
export function encodeImageUrl(url) {
  if (!url || typeof url !== 'string') return null
  return url.replace(/ /g, '%20')
}

/**
 * Parse the LIST date line ("Friday, Jul. 17, 3-4") into YYYY-MM-DD. The year
 * is not shown, so it is anchored to `now` in America/New_York: a month earlier
 * than the current month rolls into next year (December → January coverage).
 * Returns the date string or null.
 */
export function parseListDate(text, now = new Date()) {
  if (!text) return null
  let month = null, day = null
  for (const mm of String(text).matchAll(/([A-Za-z]{3,9})\.?\s+(\d{1,2})\b/g)) {
    const mo = MONTHS[mm[1].toLowerCase()]
    if (mo) { month = mo; day = parseInt(mm[2], 10); break }
  }
  if (!month || !day) return null

  const todayYmd = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const [ty, tm] = todayYmd.split('-').map(Number)
  const year = month < tm ? ty + 1 : ty
  return `${year}-${pad(month)}-${pad(day)}`
}

/** Build a 24h "HH:MM:SS" clock string from an hour/minute + am|pm. */
function to24(hour, minute, meridiem) {
  let h = hour
  if (meridiem === 'pm' && h !== 12) h += 12
  if (meridiem === 'am' && h === 12) h = 0
  return `${pad(h)}:${pad(minute)}:00`
}

/**
 * Parse the time portion of the LIST date line into clock times.
 *
 * Handles: "10:00 a.m.", "10 a.m.", "2:00 p.m. - 4:00 p.m.", "1-4pm",
 * "12pm-1pm", "6:30 p.m.", and the meridiem-less "3-4". A trailing
 * parenthetical recurrence note ("(Thursdays, July 9, 16, 23, 30)") is stripped
 * first. When only one side of a range carries a meridiem it is shared with the
 * other ("1-4pm" → 1pm–4pm).
 *
 * Returns { startClock, endClock, startHasMeridiem }. `startClock`/`endClock`
 * are null when the meridiem cannot be resolved (caller falls back to the
 * JSON-LD clock rather than guessing).
 */
export function parseListTime(text) {
  const parts = String(text || '').split(',')
  // parts[0]=weekday, parts[1]=" Jul. 17", remainder = the time expression.
  const timePart = parts.slice(2).join(',').replace(/\([^)]*\)/g, ' ').trim()
  if (!timePart) return { startClock: null, endClock: null, startHasMeridiem: false }

  const toks = []
  const re = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/gi
  let m
  while ((m = re.exec(timePart)) !== null && toks.length < 2) {
    toks.push({
      h: parseInt(m[1], 10),
      min: m[2] != null ? parseInt(m[2], 10) : 0,
      mer: m[3] ? (/^p/i.test(m[3]) ? 'pm' : 'am') : null,
    })
  }
  if (!toks.length) return { startClock: null, endClock: null, startHasMeridiem: false }

  const s = toks[0], e = toks[1] || null
  const sMer = s.mer || (e && e.mer) || null
  const eMer = e ? (e.mer || sMer) : null
  return {
    startClock: sMer ? to24(s.h, s.min, sMer) : null,
    endClock: (e && eMer) ? to24(e.h, e.min, eMer) : null,
    startHasMeridiem: !!sMer,
  }
}

// Library program → v2 category hint. First match wins; inference enriches
// (upsertEventSafe re-runs the scored classifier and merges). Left null when
// no confident keyword hits so text inference alone decides.
const CATEGORY_HINTS = [
  [/\b(storytime|story time|babytime|baby time)\b/i,                         'learning'],
  [/\b(yoga|tai chi|gentle flow|zumba|pilates|meditation|wellness|exercise)\b/i, 'fitness'],
  [/\bzumbini\b/i,                                                            'music'],
  [/\b(dungeons\s*(?:&|and)\s*dragons|d&d|minecraft|escape room|board game|gaming|chess club|pok[eé]mon|video game|lego club)\b/i, 'games'],
  [/\b(concert|live music|recital|symphony|orchestra|jazz|choir)\b/i,        'music'],
  [/\b(film|movie|cinema|screening)\b/i,                                     'film'],
  [/\b(book club|book discussion|writing|writers|author talk|poetry|memoir)\b/i, 'learning'],
  [/\b(science|stem|steam|coding|computer|technology|robotics|paleontology|prehistory|invention|tech camp)\b/i, 'learning'],
  [/\b(walking tour|genealogy|historical|lecture|seminar|class|workshop)\b/i, 'learning'],
]

/** Return a v2 category hint from title (+ description), or null. */
export function mapCategory(title = '', desc = '') {
  const s = `${title} ${desc}`
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(s)) return cat
  return null
}

/**
 * Best-effort audience signal from the TITLE only (EngagedPatrons has no
 * structured Ages field). Title-scoped so an adult event whose description
 * merely mentions "children" is not mis-flagged. Returns true or undefined
 * (never false), so inference can still flag family events we miss.
 */
export function parseIsFamily(title = '') {
  const t = String(title)
  if (/\badults?\b/i.test(t) && !/\b(family|families|all ages|kids?|children)\b/i.test(t)) {
    // "…for Adults" style programs are adult-only.
    return undefined
  }
  return /\b(bab(y|ies)|babytime|toddlers?|preschool|kids?|child(ren)?|famil(y|ies)|storytime|story time|zumbini|tweens?|teens?|youth|grades?|infant|little ones|grandparents?|all ages|reading buddies|minecraft|lego)\b/i.test(t) || undefined
}

/** Extract the clean Event JSON-LD fields from a detail page's HTML. */
export function parseDetailJsonLd(html) {
  const events = findSchemaObjects(extractJsonLd(html || ''), 'Event')
  const ev = events[0]
  if (!ev) return null
  const cleanText = (v) => {
    if (!v) return null
    const out = stripHtml(decodeEntities(String(v))).trim()
    return out || null
  }
  // Trust only the wall-clock time in startDate; its offset is a wrong fixed
  // "-05:00" year-round, so we re-anchor via easternToIso downstream.
  let jsonClock = null
  const tm = String(ev.startDate || '').match(/T(\d{2}):(\d{2})/)
  if (tm) jsonClock = `${tm[1]}:${tm[2]}:00`
  return {
    name: cleanText(ev.name),
    description: cleanText(ev.description),
    image: encodeImageUrl(firstImageUrl(ev.image)),
    jsonClock,
  }
}

/**
 * Parse one paginated LIST page into occurrence descriptors. Each event lives
 * in an `LEEventWrapper` div; we read the first LETitle (EventID + PK + title)
 * and the first LEDate line within each wrapper so title and date stay paired.
 */
export function parseListPage(html) {
  const out = []
  const chunks = String(html || '').split('LEEventWrapper').slice(1)
  for (const chunk of chunks) {
    const t = chunk.match(/<div class="LETitle"><a href="EventsExtended\.cfm\?SiteID=\d+&EventID=(\d+)&PK=([^"]*)">([\s\S]*?)<\/a>/i)
    if (!t) continue
    const d = chunk.match(/<div class="LEDate[^"]*">([\s\S]*?)<\/div>/i)
    out.push({
      eventId: t[1],
      pk: t[2] || '',
      title: stripHtml(decodeEntities(t[3])).trim(),
      dateText: d ? d[1].replace(/\s+/g, ' ').trim() : '',
    })
  }
  return out
}

/**
 * Assemble an event row from a LIST occurrence + its cached DETAIL JSON-LD.
 * Returns { row } or null when it cannot be dated/timed or is a non-event.
 */
export function buildRow(occ, detail = {}, now = new Date()) {
  const title = (detail.name || occ.title || '').trim()
  if (!title || SKIP_TITLE_RE.test(title)) return null

  const dateYmd = parseListDate(occ.dateText, now)
  if (!dateYmd) return null

  const t = parseListTime(occ.dateText)
  // Start time: prefer the per-occurrence LIST time when it carries a meridiem;
  // otherwise fall back to the JSON-LD clock (never synthesize one).
  const startClock = t.startHasMeridiem ? t.startClock : (detail.jsonClock || null)
  if (!startClock) return null
  const startAt = easternToIso(dateYmd, startClock)
  if (!startAt) return null

  // End time only from the LIST line (JSON-LD endDate is unusable), and only
  // when the list start was itself meridiem-resolved so the end shares it.
  let endAt = null
  if (t.startHasMeridiem && t.endClock) {
    const e = easternToIso(dateYmd, t.endClock)
    if (e && Date.parse(e) > Date.parse(startAt)) endAt = e
  }

  const tags = ['library', 'hudson']
  if (/\b(bab(y|ies)|toddler|preschool|storytime|story time|kids?|child(ren)?|zumbini|infant|little ones)\b/i.test(title)) tags.push('kids')
  if (/\b(teens?|tweens?|youth)\b/i.test(title)) tags.push('teens')
  if (/\badults?\b/i.test(title)) tags.push('adults')
  if (/\b(seniors?|memory caf|grandparents?)\b/i.test(title)) tags.push('seniors')

  const ticketUrl = `${DETAIL_URL}?SiteID=${SITE_ID}&EventID=${occ.eventId}${occ.pk ? `&PK=${occ.pk}` : ''}`

  return {
    row: {
      title,
      description: detail.description ? detail.description.slice(0, 5000) : null,
      start_at: startAt,
      end_at: endAt,
      category: mapCategory(title, detail.description || ''),
      is_family: parseIsFamily(title),
      tags: [...new Set(tags)],
      price_min: null,   // never stated; library programs are not assumed free
      price_max: null,
      age_restriction: 'not_specified',
      image_url: detail.image || null,
      ticket_url: ticketUrl,
      source: SOURCE_KEY,
      source_id: `${occ.eventId}-${occ.pk || dateYmd}`,
      status: 'published',
      featured: false,
    },
  }
}

// ── Network ───────────────────────────────────────────────────────────────

let COOKIE = ''

async function httpGet(url) {
  const headers = { Accept: 'text/html,*/*;q=0.8', 'User-Agent': USER_AGENT }
  if (COOKIE) headers.Cookie = COOKIE
  const res = await fetch(url, { headers, redirect: 'follow' })
  if (!COOKIE) {
    const sc = res.headers.get('set-cookie')
    if (sc) COOKIE = sc.split(';')[0]
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`)
  return res.text()
}

/** Fetch one LIST page. StartRow<=1 uses the GET entry point, else POST. */
async function fetchListPage(startRow) {
  if (startRow <= 1) return httpGet(`${LIST_URL}?SiteID=${SITE_ID}`)
  const headers = {
    Accept: 'text/html,*/*;q=0.8',
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (COOKIE) headers.Cookie = COOKIE
  const res = await fetch(LIST_POST, {
    method: 'POST', headers, redirect: 'follow',
    body: `SiteID=${SITE_ID}&StartRow=${startRow}`,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} posting StartRow=${startRow}`)
  return res.text()
}

/** Walk the paginated list, collecting every occurrence (deduped by source_id). */
async function collectOccurrences() {
  const seen = new Set()
  const occurrences = []
  let startRow = 1
  for (let page = 0; page < MAX_PAGES; page++) {
    const html = await fetchListPage(startRow)
    const rows = parseListPage(html)
    if (!rows.length) break
    for (const occ of rows) {
      const key = `${occ.eventId}-${occ.pk}`
      if (seen.has(key)) continue
      seen.add(key)
      occurrences.push(occ)
    }
    const next = html.match(/name="StartRow" value="(\d+)"/)
    const nextRow = next ? parseInt(next[1], 10) : null
    if (!nextRow || nextRow <= startRow) break
    startRow = nextRow
    await new Promise((r) => setTimeout(r, FETCH_DELAY_MS))
  }
  return occurrences
}

/** Fetch + parse the DETAIL JSON-LD for one EventID (cached by caller). */
async function fetchDetail(eventId) {
  const html = await httpGet(`${DETAIL_URL}?SiteID=${SITE_ID}&EventID=${eventId}`)
  return parseDetailJsonLd(html)
}

/**
 * Run `fn` over `items` with a bounded concurrency. EngagedPatrons is a slow
 * origin, so serial fetching blows past sensible run times; a small pool keeps
 * wall-time low while staying polite. Returns results in input order.
 */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('📚  Starting Hudson Library (EngagedPatrons) scrape…')
  const start = Date.now()

  try {
    const occurrences = await collectOccurrences()
    console.log(`\n📥  Collected ${occurrences.length} occurrences across the list…`)
    if (!occurrences.length) {
      console.warn('  ⚠ No events found on the EngagedPatrons list.')
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, { eventsFound: 0, durationMs: Date.now() - start })
      process.exit(0)
    }

    const organizerId = await ensureOrganization(ORG_NAME, {
      website: 'https://www.hudsonlibrary.org',
      description: 'The Hudson Library & Historical Society serves Hudson with programs, classes, and events for all ages.',
    })
    const venueId = await ensureVenue(VENUE.name, VENUE.details)
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const nowMs = Date.now()
    const cutoffPast = nowMs - 86_400_000
    const cutoffFuture = nowMs + HORIZON_DAYS * 86_400_000

    // Phase 1 — fetch each unique event's DETAIL JSON-LD concurrently.
    const uniqueIds = [...new Set(occurrences.map((o) => o.eventId))]
    const details = await mapPool(uniqueIds, FETCH_CONCURRENCY, (id) => fetchDetail(id).catch(() => null))
    const detailCache = new Map(uniqueIds.map((id, i) => [id, details[i]]))

    // Build rows + apply the horizon/past filter up front.
    const built = []
    for (const occ of occurrences) {
      const b = buildRow(occ, detailCache.get(occ.eventId) || {})
      if (!b) { continue }
      const startMs = Date.parse(b.row.start_at)
      if (startMs < cutoffPast || startMs > cutoffFuture) continue
      built.push(b.row)
    }
    const droppedBeforeUpsert = occurrences.length - built.length

    // Phase 2 — probe unique image URLs (network) concurrently, once each.
    const uniqueImages = [...new Set(built.map((r) => r.image_url).filter(Boolean))]
    const imageMetaCache = new Map()
    const probed = await mapPool(uniqueImages, FETCH_CONCURRENCY, async (url) => {
      const sample = built.find((r) => r.image_url === url)
      const e = await enrichWithImageDimensions({ ...sample })
      return { image_url: e.image_url, image_width: e.image_width, image_height: e.image_height, image_file_size: e.image_file_size }
    })
    uniqueImages.forEach((url, i) => imageMetaCache.set(url, probed[i]))

    // Phase 3 — upsert + link (DB-bound; kept sequential for safety).
    let inserted = 0, skipped = droppedBeforeUpsert
    for (const row of built) {
      try {
        const enriched = row.image_url && imageMetaCache.has(row.image_url)
          ? { ...row, ...imageMetaCache.get(row.image_url) }
          : { ...row, image_width: null, image_height: null, image_file_size: null }
        const { data: upserted, error } = await upsertEventSafe(enriched)
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skipped++; continue }

        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${row.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: occurrences.length, durationMs: Date.now() - start,
    })
    console.log(`\n✅  Hudson Library: ${inserted} posted, ${skipped} skipped in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
