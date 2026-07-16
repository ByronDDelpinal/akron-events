/**
 * scrape-jewish-akron.js
 *
 * Jewish Akron — the community calendar of the Jewish Community Board of Akron
 * (JCBA), the federation at 750 White Pond Drive, Akron (Summit County). The
 * calendar AGGREGATES events from the local Jewish community: the Shaw JCC, the
 * Lippman School, and area congregations (Temple Israel, Beth El, Anshe Sfard,
 * Chabad). Its feed is therefore a mix of internal congregational life (Shabbat
 * services, b'nai mitzvah, board meetings) and genuinely PUBLIC community &
 * cultural events (J-Fest, community BBQs, the JCC Golf Outing, author talks,
 * apple-picking outings, Purim/Hanukkah celebrations). Akron Pulse surfaces the
 * public events only.
 *
 * ── Platform ─────────────────────────────────────────────────────────────────
 * Hosted on the FedWeb platform (cdn.fedwebplatform.org) — a Jewish-federation
 * CMS, NOT WordPress. There is no Tribe REST API, no iCal export, and no JSON
 * feed (the WP endpoints 403; ?ical=1 just returns the HTML page). So we scrape
 * the server-rendered calendar:
 *   • Month LIST view  /calendar/month/list/YYYY/MM/DD  → one <a class="title">
 *     per real event (holiday markers use <span class="title"> and are ignored).
 *   • Event DETAIL page /calendar/<slug>  → the authoritative record.
 *
 * ── QUIRK 1: datetime from the Google Calendar "add" link ────────────────────
 * Each detail page embeds a Google-Calendar TEMPLATE link whose `dates=` param
 * carries the exact start/end in UTC (e.g. dates=20260810T160000Z/...). This is
 * unambiguous UTC (verified: a noon-EDT golf outing → 16:00:00Z), so we parse it
 * directly rather than re-deriving Eastern wall-clock from the display time. If
 * the link is ever missing we fall back to the on-page date box + display time
 * via easternToIso() (Eastern-anchored). We never synthesize a midnight.
 *
 * ── QUIRK 2: faith allowlist (mandatory) ─────────────────────────────────────
 * A synagogue-heavy calendar is dominated by worship. We gate every event
 * through isPublicJewishAkronEvent():
 *   • A WORSHIP / internal / lifecycle veto (Shabbat, minyan, Torah study,
 *     b'nai mitzvah, weddings, board meetings, …) is a hard skip — it wins even
 *     when a public keyword co-occurs (strict faith stance, mirroring ISAK).
 *   • Otherwise the event must carry a public-community signal: the shared
 *     church-oriented allowlist (lib/faith-events.js) OR a local Jewish-community
 *     supplement (EXTRA_PUBLIC_RE: bbq, author talk, klezmer, purim/hanukkah
 *     celebration, apple picking, raffle, J-Fest, …) the shared list misses.
 *   Expect to skip the majority of the feed — that's correct.
 *
 * ── QUIRK 3: placeholder venues + geography ──────────────────────────────────
 * The feed's default location is the site name "JewishAkron" at 750 White Pond
 * Drive — the federation building, which houses the Shaw JCC; we map that name to
 * the real venue "Shaw Jewish Community Center". Some events read "Off Campus" /
 * "TBD" with no address — those get no venue and, lacking a city, land in the
 * review queue. Congregation events carry their own venue+address (e.g. Temple
 * Israel Akron, Fairlawn). Each event is gated per-venue with
 * classifySummitLocation(): 'out' → skip; 'unknown' → pending_review; 'in' →
 * published. (NOTE: the golf outing / J-Fest inherit the 750 White Pond default
 * even though they're physically elsewhere — the source itself is imprecise.)
 *
 * Usage:   node scripts/scrape-jewish-akron.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, htmlToText,
  enrichWithImageDimensions, upsertEventSafe, setEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  easternToIso, inferCategory,
} from './lib/normalize.js'
import { isPublicFaithEvent } from './lib/faith-events.js'
import { classifySummitLocation, preloadSummitCountyBoundary } from './lib/summit-county.js'

export const SOURCE_KEY = 'jewish_akron'
const ORIGIN     = 'https://www.jewishakron.org'
const MONTHS_AHEAD = 7          // ~180-day horizon, month by month
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const ORG_NAME = 'Jewish Community Board of Akron'
const ORG_DETAILS = {
  website: ORIGIN,
  description: 'The federation of the Akron Jewish community, publishing a shared calendar for area ' +
    'congregations and Jewish organizations including the Shaw JCC and The Lippman School.',
}

// The federation building at 750 White Pond Drive (the calendar's default
// location, shown under the site name "JewishAkron") is the Shaw JCC.
const SHAW_JCC_NAME = 'Shaw Jewish Community Center'
const SHAW_JCC_DETAILS = {
  address: '750 White Pond Drive', city: 'Akron', state: 'OH', zip: '44320',
  website: ORIGIN,
  description: 'The Shaw Jewish Community Center campus in Akron, home of the Jewish Community Board of ' +
    'Akron and The Lippman School.',
}

const MONTH_ABBR = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

// ── Faith allowlist gate (exported for tests) ───────────────────────────────

// Worship / internal-congregational / lifecycle signals — a hard skip even when
// a public keyword co-occurs (strict faith stance). "shabbat" reliably marks a
// synagogue service on this federation calendar; a rare public "Shabbat concert"
// is an accepted miss. Deliberately excludes bare "service" so a community "day
// of service" (volunteering) can still qualify below.
const WORSHIP_INTERNAL_RE = new RegExp([
  // Shabbat / worship / liturgy
  '\\bshabb(?:at|os)\\b', 'friday night live', '\\bminyan\\b', '\\bdaven',
  'shacharit', '\\bmincha', '\\bmaariv\\b', 'kabbalat', 'havdalah',
  'selichot', "shabbat shuva", '\\bshuva\\b', '\\byizkor\\b', 'kol nidre',
  "ne['’]?ilah", 'megillah reading', '\\btefila', '\\bshiur\\b',
  // Study / religious education
  'torah study', 'daf yomi', '\\btalmud\\b', 'lunch and learn', 'lunch & learn',
  'religious school', 'hebrew school', 'sunday school',
  // Lifecycle (private)
  'bar mitzvah', 'bat mitzvah', "b['’]?nai mitzvah", 'bnai mitzvah',
  '\\bbris\\b', 'brit milah', 'baby naming', '\\baufruf\\b', '\\bwedding\\b',
  '\\bfuneral\\b', '\\bshiva\\b', '\\bunveiling\\b', '\\byahrzeit\\b',
  // Internal governance
  '\\bmeeting\\b',
].join('|'), 'i')

// Public Jewish-community / cultural terms the shared (church-oriented) allowlist
// misses. Reached only after the worship veto, so services filed with these
// words are already gone.
const EXTRA_PUBLIC_RE = new RegExp([
  '\\bbbq\\b', 'barbe?cue', '\\bcookout\\b',
  'apple pick', 'apple orchard',
  'author talk', 'book talk', 'book club', 'book (?:fair|festival)',
  '\\blecture\\b', 'speaker series', 'guest speaker',
  'film (?:screening|festival|series)', 'movie (?:screening|night)',
  '\\bklezmer\\b',
  'purim (?:carnival|party|celebration|bash|fest|festival|palooza)',
  'menorah lighting', '\\blatke', '(?:hanukk?ah|chanuk?ah) (?:party|celebration|festival|market|bazaar|carnival|fair)',
  'yom ha[- ]?atzmaut', 'israel(?:i)? (?:festival|fest|celebration|fair|expo|day)',
  '\\braffle\\b', 'trivia night', 'game night',
  'wine (?:tasting|and cheese|& cheese)', 'happy hour',
  'j-?fest', 'jewishfest', 'jewish (?:heritage|food|film|book|arts?) (?:festival|fair|fest)',
  '\\bpicnic\\b', 'community (?:day|celebration|fair)', 'mah ?jong',
].join('|'), 'i')

/**
 * True when a Jewish Akron event is a genuinely public community/cultural event
 * (allowlist). The worship/internal veto wins over any public keyword.
 * @param {string} title
 * @param {string} description
 */
export function isPublicJewishAkronEvent(title, description = '') {
  const text = `${title || ''} ${description || ''}`
  if (WORSHIP_INTERNAL_RE.test(text)) return false
  return isPublicFaithEvent(title, description) || EXTRA_PUBLIC_RE.test(text)
}

// ── Parsers (exported for tests) ────────────────────────────────────────────

/** Extract [{ title, url }] for each REAL event in a month LIST view.
 * Holiday markers render as <span class="title"> and are intentionally ignored. */
export function parseListEvents(html = '') {
  const out = []
  const re = /<a\s+class="title"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const url = m[1].trim()
    const title = stripHtml(m[2]).trim()
    if (url && title) out.push({ title, url })
  }
  return out
}

/** Convert a Google-Calendar UTC token (20260810T160000Z) to an ISO string. */
export function gcalTokenToIso(token = '') {
  const m = String(token).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`
}

/** Pull start/end ISO from the detail page's Google-Calendar template link. */
export function parseGcalDates(html = '') {
  const m = html.match(/dates=(\d{8}T\d{6}Z)(?:%2F|\/)(\d{8}T\d{6}Z)/i)
  if (!m) return { startAt: null, endAt: null }
  return { startAt: gcalTokenToIso(m[1]), endAt: gcalTokenToIso(m[2]) }
}

/** Parse the on-page date box + display time into an Eastern-anchored ISO
 * (fallback when the Google-Calendar link is absent). */
export function parseFallbackStart(html = '') {
  const mon = html.match(/<div class="month">\s*([A-Za-z]{3})/i)?.[1]?.toLowerCase()
  const day = html.match(/<span class="day">\s*(\d{1,2})/i)?.[1]
  const year = html.match(/<span class="year">\s*(\d{4})/i)?.[1]
  if (!mon || !day || !year || !MONTH_ABBR[mon]) return null
  const dateStr = `${year}-${MONTH_ABBR[mon]}-${String(day).padStart(2, '0')}`
  // Display time e.g. "6:15PM - 7:30PM" or "All Day"; take the start token.
  const timeBlock = html.match(/<p class="time">([\s\S]*?)<\/p>/i)?.[1] ?? ''
  const timeText = stripHtml(timeBlock).trim() // stripHtml already decodes nbsp to a space
  const startTok = timeText.match(/\d{1,2}(?::\d{2})?\s*[AP]M/i)?.[0]
  // No explicit time → do NOT synthesize a midnight; let the caller skip it.
  if (!startTok) return null
  return easternToIso(dateStr, startTok)
}

/**
 * Parse the detail-page <p class="location"> block → { name, address, city,
 * state, zip }. Two markups occur: congregation venues wrap the address in a
 * <span> (name comes before it), while the "JewishAkron" default separates every
 * line with <br> only (preceded by a location icon). We normalize both: drop the
 * icon, treat <span> boundaries AND <br> as line breaks, then take the first line
 * as the venue name, the "City, ST ZIP" line as the locality, and the rest as the
 * street address.
 */
export function parseLocation(locHtml = '') {
  if (!locHtml) return { name: null, address: null, city: null, state: null, zip: null }
  const normalized = locHtml
    .replace(/<i\b[^>]*>[\s\S]*?<\/i>/gi, '') // drop the ss-location icon
    .replace(/<\/?span[^>]*>/gi, '\n')        // span boundary → line break
  const lines = htmlToText(normalized)
    .split('\n').map((s) => s.trim()).filter(Boolean)

  let name = null, address = null, city = null, state = null, zip = null
  for (const line of lines) {
    const cs = line.match(/^(.+?),\s*([A-Za-z]{2})\.?\s+(\d{5})(?:-\d{4})?$/)
    if (cs) { city = cs[1].trim(); state = cs[2].toUpperCase(); zip = cs[3]; continue }
    if (name === null) { name = line; continue }
    address = address ? `${address} ${line}` : line
  }
  // Some listing markups glue a standalone city line onto the "City, ST ZIP"
  // line with no break between them, yielding a doubled city ("AkronAkron",
  // observed 2026-07: Anshe Sfard Synagogue). Fold an exact doubling back to
  // the single form — no real city name is its own duplicate.
  if (city) {
    const m = city.match(/^(.+?)\1$/)
    if (m) city = m[1]
  }
  return { name, address, city, state, zip }
}

const PLACEHOLDER_VENUE_RE =
  /^(jewish\s?akron|off[- ]?campus|tb[ad]|to be (?:announced|determined)|various|multiple locations|n\/?a)$/i

/**
 * Resolve a parsed location into { name, details, city } for the Summit gate.
 *   • "JewishAkron" (the site-name default at 750 White Pond) → Shaw JCC.
 *   • "Off Campus" / "TBD" / empty → no venue (name null); city may be null.
 *   • anything else → its own name + parsed address.
 */
export function resolveVenue(loc = {}) {
  const rawName = (loc.name || '').trim()
  if (/^jewish\s?akron$/i.test(rawName)) {
    return { name: SHAW_JCC_NAME, details: { ...SHAW_JCC_DETAILS }, city: SHAW_JCC_DETAILS.city }
  }
  if (!rawName || PLACEHOLDER_VENUE_RE.test(rawName)) {
    return { name: null, details: {}, city: loc.city || null }
  }
  const details = {
    address: loc.address || null,
    city: loc.city || null,
    state: loc.state || 'OH',
    zip: loc.zip || null,
  }
  return { name: rawName, details, city: loc.city || null }
}

/** Content category — festivals stay festivals; otherwise defer to inference. */
export function parseCategory(title = '', description = '') {
  const text = `${title} ${description}`
  if (/\bfest(?:ival)?\b|j-?fest/i.test(text)) return 'festival'
  return inferCategory(title, description) || 'other'
}

/** is_fundraiser facet — raffles, galas, benefit outings, auctions. */
export function parseIsFundraiser(title = '', description = '') {
  const text = `${title} ${description}`
  return /fundrais|\braffle\b|\bgala\b|auction|golf outing|\bbenefit\b/i.test(text) || undefined
}

/** Stable per-event source_id from the FedWeb numeric event id. */
export function buildSourceId(eventId, url = '') {
  if (eventId) return String(eventId)
  // Fall back to the URL slug (stable + unique) if the id is ever missing.
  return url.split('/').filter(Boolean).pop() || null
}

/** Parse a detail page into a normalized record (null on unusable). */
export function parseDetail(html = '', url = '') {
  const eventId = html.match(/id="calendar-\d+-event-(\d+)"/i)?.[1] ?? null
  const title = stripHtml(
    html.match(/class="page-title"[\s\S]*?<h2>([\s\S]*?)<\/h2>/i)?.[1] ?? '',
  ).trim()

  const { startAt: gcalStart, endAt } = parseGcalDates(html)
  const startAt = gcalStart || parseFallbackStart(html)

  const locHtml = html.match(/<p class="location">([\s\S]*?)<\/p>/i)?.[1] ?? ''
  const location = parseLocation(locHtml)

  const descRaw = html.match(/editor-copy">([\s\S]*?)<\/div>/i)?.[1] ?? ''
  const description = htmlToText(descRaw).trim() || null

  return {
    eventId, title, startAt, endAt, description, location,
    sourceUrl: url,
    sourceId: buildSourceId(eventId, url),
  }
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchText(url, { retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT }, redirect: 'follow',
    })
    if (res.ok) return res.text()
    // The FedWeb host throttles bursts with 403/429; back off once before failing.
    if ((res.status === 403 || res.status === 429) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      continue
    }
    throw new Error(`GET ${url} → ${res.status}`)
  }
}

/** Eastern-local {year, month} `offsetMonths` from now (anchored to America/New_York). */
function etYearMonth(offsetMonths = 0) {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
  }).formatToParts(now)
  const y = Number(parts.find((p) => p.type === 'year').value)
  const m = Number(parts.find((p) => p.type === 'month').value)
  const idx = (y * 12 + (m - 1)) + offsetMonths
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 }
}

async function fetchCandidateUrls() {
  const seen = new Set()
  const urls = []
  console.log('\n🔍  Fetching Jewish Akron month list views…')
  for (let i = 0; i < MONTHS_AHEAD; i++) {
    const { year, month } = etYearMonth(i)
    const mm = String(month).padStart(2, '0')
    const listUrl = `${ORIGIN}/calendar/month/list/${year}/${mm}/15`
    let html
    try {
      html = await fetchText(listUrl)
    } catch (err) {
      console.warn(`  ⚠ ${year}-${mm} list fetch failed: ${err.message}`)
      continue
    }
    const events = parseListEvents(html)
    console.log(`  ${year}-${mm}: ${events.length} listed`)
    for (const ev of events) {
      const abs = ev.url.startsWith('http') ? ev.url : `${ORIGIN}${ev.url}`
      if (seen.has(abs)) continue
      seen.add(abs)
      urls.push({ url: abs, title: ev.title })
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return urls
}

// ── Process ───────────────────────────────────────────────────────────────────

async function processCandidates(candidates, organizerId, shawVenueId) {
  let inserted = 0, skippedInternal = 0, skippedGeo = 0, skippedOther = 0
  const cutoffMs = Date.now() - 36 * 3600_000 // ~1 day grace on past events
  const venueCache = new Map([[SHAW_JCC_NAME, shawVenueId]])

  for (const cand of candidates) {
    try {
      // Cheap early veto on the list title — avoids fetching worship/meeting pages.
      if (WORSHIP_INTERNAL_RE.test(cand.title)) { skippedInternal++; continue }

      const html = await fetchText(cand.url)
      const rec = parseDetail(html, cand.url)

      // Full allowlist with the detail description in hand.
      if (!isPublicJewishAkronEvent(rec.title || cand.title, rec.description || '')) {
        skippedInternal++
        continue
      }
      if (!rec.startAt) { console.warn(`  ⚠ No date for "${rec.title}"`); skippedOther++; continue }
      if (new Date(rec.startAt).getTime() < cutoffMs) { skippedOther++; continue }

      const { name: venueName, details: venueDetails, city } = resolveVenue(rec.location)
      const locality = classifySummitLocation({ city })
      if (locality === 'out') {
        console.log(`  ⤫ Out of Summit ("${rec.title}" → ${city}) — skipped`)
        skippedGeo++
        continue
      }
      const status = locality === 'in' ? 'published' : 'pending_review'

      let venueId = null
      if (venueName) {
        venueId = venueCache.get(venueName)
        if (venueId === undefined) {
          venueId = await ensureVenue(venueName, venueDetails)
          venueCache.set(venueName, venueId)
        }
      }

      const title = rec.title || cand.title
      const row = {
        title,
        description: rec.description,
        start_at: rec.startAt,
        end_at: rec.endAt,
        category: parseCategory(title, rec.description || ''),
        is_fundraiser: parseIsFundraiser(title, rec.description || ''),
        tags: ['jewish-akron', 'faith', 'community'],
        price_min: null,
        price_max: null,
        age_restriction: 'not_specified',
        image_url: null,
        ticket_url: null,
        source_url: rec.sourceUrl,
        source: SOURCE_KEY,
        source_id: rec.sourceId,
        status,
        needs_review: locality !== 'in',
        featured: false,
      }

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}": ${error.message}`)
        skippedOther++
      } else {
        if (venueId) await setEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        console.log(`  ✓ ${status === 'published' ? '' : '[review] '}"${row.title}" — ${row.start_at}` +
          `${venueName ? ` @ ${venueName}` : ''}`)
        inserted++
      }
      await new Promise((r) => setTimeout(r, 150))
    } catch (err) {
      console.warn(`  ⚠ Error processing "${cand.title}": ${err.message}`)
      skippedOther++
    }
  }
  return { inserted, skippedInternal, skippedGeo, skippedOther }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('✡️  Starting Jewish Akron (JCBA) ingestion…')
  const start = Date.now()
  try {
    await preloadSummitCountyBoundary()

    const organizerId = await ensureOrganization(ORG_NAME, ORG_DETAILS)
    const shawVenueId = await ensureVenue(SHAW_JCC_NAME, SHAW_JCC_DETAILS)
    if (organizerId && shawVenueId) await linkOrganizationVenue(organizerId, shawVenueId)

    const candidates = await fetchCandidateUrls()
    console.log(`\n📥  ${candidates.length} unique event pages to evaluate…`)
    const { inserted, skippedInternal, skippedGeo, skippedOther } =
      await processCandidates(candidates, organizerId, shawVenueId)

    const skipped = skippedInternal + skippedGeo + skippedOther
    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: candidates.length,
      durationMs: Date.now() - start,
    })
    console.log(
      `\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ` +
      `${skipped} skipped (${skippedInternal} internal/worship, ${skippedGeo} out-of-county, ` +
      `${skippedOther} other).`,
    )
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
