/**
 * Shared iCalendar (RFC 5545) module.
 *
 * Parses `.ics` feeds into structured event objects and runs the shared
 * fetch → parse → normalise → upsert pipeline so per-source ICS scrapers
 * only need to supply configuration (feed URL, venue/org details, category
 * and tag logic).
 *
 * RFC 5545 features supported:
 *   • VCALENDAR / VEVENT block parsing
 *   • Line unfolding (continuation lines start with space/tab)
 *   • Property parameters (e.g. DTSTART;TZID=America/New_York:20260101T190000)
 *   • Date-time formats: floating local, UTC (suffixed "Z"), TZID, and all-day
 *   • TEXT escape sequences (\n \, \; \\)
 *
 * NOT supported (yet — keep scope tight):
 *   • RRULE recurrence expansion — we assume published feeds materialise
 *     each occurrence as its own VEVENT. If a feed only emits a single
 *     event with RRULE, we ingest the series "start" date only and log a
 *     warning.
 *   • VTIMEZONE definitions — we map common TZIDs (America/New_York etc.)
 *     via native Intl and fall back to treating TZID as Eastern.
 *
 * Usage:
 *   import { fetchIcsFeed, parseIcs, runIcsScraper } from './lib/ics.js'
 *
 *   await runIcsScraper({
 *     source: 'akron_symphony',
 *     feedUrl: 'https://akronsymphony.org/?ical=1',
 *     organizationName: 'Akron Symphony Orchestra',
 *     mapCategory: () => 'music',
 *     ...
 *   })
 */

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
  linkOrganizationVenue,
} from './normalize.js'

// ════════════════════════════════════════════════════════════════════════════
// LOW-LEVEL PARSER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Unfold ICS content lines per RFC 5545 §3.1:
 *   Long logical lines are split by CRLF followed by a single whitespace.
 *   We also accept LF-only line endings for forgiving input.
 */
function unfoldLines(text) {
  // Normalise line endings then unfold
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '')
}

/** Unescape text values per RFC 5545 §3.3.11. */
function unescapeText(value = '') {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g,  ',')
    .replace(/\\;/g,  ';')
    .replace(/\\\\/g, '\\')
}

/**
 * Split a content line into { name, params, value }.
 * Example: `DTSTART;TZID=America/New_York:20260101T190000`
 *       →  { name: 'DTSTART', params: { TZID: 'America/New_York' }, value: '20260101T190000' }
 */
function parseLine(line) {
  const colonIdx = findUnquoted(line, ':')
  if (colonIdx === -1) return null

  const left  = line.slice(0, colonIdx)
  const value = line.slice(colonIdx + 1)

  const parts = splitUnquoted(left, ';')
  const name  = parts[0].toUpperCase()
  const params = {}
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=')
    if (eq === -1) continue
    const pName  = parts[i].slice(0, eq).toUpperCase()
    const pValue = parts[i].slice(eq + 1).replace(/^"|"$/g, '')
    params[pName] = pValue
  }

  return { name, params, value }
}

/** Find the first unquoted occurrence of `char` in `str`. */
function findUnquoted(str, char) {
  let inQuote = false
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '"') { inQuote = !inQuote; continue }
    if (!inQuote && ch === char) return i
  }
  return -1
}

/** Split on `sep` ignoring occurrences inside double-quoted strings. */
function splitUnquoted(str, sep) {
  const out = []
  let buf = '', inQuote = false
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '"') { inQuote = !inQuote; buf += ch; continue }
    if (!inQuote && ch === sep) { out.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf.length) out.push(buf)
  return out
}

// ── Date/time conversion ───────────────────────────────────────────────────

/**
 * Convert an ICS date-time value to ISO 8601 UTC.
 *
 * Accepts:
 *   20260101T190000Z                 → UTC
 *   20260101T190000                  → floating — we treat as Eastern local
 *   20260101T190000  + TZID param    → convert from named TZ via Intl
 *   20260101                         → all-day — midnight Eastern
 */
export function icsDateToIso(rawValue, params = {}) {
  if (!rawValue) return null

  // All-day (VALUE=DATE or 8-char)
  if (rawValue.length === 8 && !rawValue.includes('T')) {
    const y = rawValue.slice(0, 4)
    const m = rawValue.slice(4, 6)
    const d = rawValue.slice(6, 8)
    return easternWallTimeToUtc(`${y}-${m}-${d}T00:00:00`)
  }

  const match = rawValue.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/)
  if (!match) return null
  const [, y, mo, d, h, mi, s, z] = match
  const wallClock = `${y}-${mo}-${d}T${h}:${mi}:${s}`

  if (z === 'Z') {
    return new Date(`${wallClock}Z`).toISOString()
  }

  const tzid = params.TZID
  if (tzid) {
    return namedTzWallTimeToUtc(wallClock, tzid)
  }

  // Floating — per RFC 5545 §3.3.5, floating times take on the local
  // timezone of the observer. For Akron, that's Eastern.
  return easternWallTimeToUtc(wallClock)
}

/**
 * Convert a wall-clock time in America/New_York (Eastern) to ISO 8601 UTC.
 * Delegates to the Intl-based converter so the EST↔EDT boundary is
 * resolved correctly at 2:00 AM local on DST transition days (which a
 * purely arithmetic "2nd Sunday of March" approximation mishandles when
 * the wall-clock evening of the preceding day rounds up to the boundary).
 */
function easternWallTimeToUtc(wallClock) {
  return namedTzWallTimeToUtc(wallClock, 'America/New_York')
}

/**
 * Convert a wall-clock time in a named IANA timezone to ISO 8601 UTC.
 * Uses Intl DateTimeFormat to compute the target-zone UTC offset.
 */
function namedTzWallTimeToUtc(wallClock, tzid) {
  try {
    const [datePart, timePart = '00:00:00'] = wallClock.split('T')
    const [year, month, day] = datePart.split('-').map(Number)
    const [hour, minute, second = 0] = timePart.split(':').map(Number)
    if (!year || !month || !day) return null

    // Convert wall time in tzid to UTC by asking Intl what that same moment
    // looks like if we assume it's UTC, then compute the offset difference.
    const asIfUtcMs = Date.UTC(year, month - 1, day, hour, minute, second)
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    })
    const parts = fmt.formatToParts(new Date(asIfUtcMs))
    const get = (t) => parts.find(p => p.type === t)?.value ?? '00'
    const asTzMs = Date.UTC(
      parseInt(get('year'), 10),
      parseInt(get('month'), 10) - 1,
      parseInt(get('day'), 10),
      parseInt(get('hour'), 10) % 24,
      parseInt(get('minute'), 10),
      parseInt(get('second'), 10),
    )
    const offsetMs = asIfUtcMs - asTzMs
    return new Date(asIfUtcMs + offsetMs).toISOString()
  } catch {
    // Unknown/unsupported TZID — Intl threw. Return null so the caller can
    // decide how to handle it (typically skip the event). Falling back to a
    // different timezone would silently corrupt data.
    return null
  }
}

// ── VEVENT extraction ──────────────────────────────────────────────────────

/**
 * Parse an ICS feed body into an array of raw event objects.
 * Each event is an object keyed by RFC 5545 property names (upper case).
 *
 * Example returned event:
 *   {
 *     UID: '123@example.com',
 *     SUMMARY: 'Concert',
 *     DTSTART: { value: '20260101T190000', params: { TZID: 'America/New_York' } },
 *     DTEND:   { value: '20260101T210000', params: { TZID: 'America/New_York' } },
 *     LOCATION: 'E.J. Thomas Hall',
 *     DESCRIPTION: 'An evening with…',
 *     URL: 'https://akronsymphony.org/event/123',
 *   }
 */
export function parseIcs(icsText) {
  if (!icsText || typeof icsText !== 'string') return []
  if (!icsText.includes('BEGIN:VCALENDAR')) return []

  const unfolded = unfoldLines(icsText)
  const lines = unfolded.split('\n')

  const events = []
  let current = null
  let depth = 0   // track nested blocks (VALARM inside VEVENT)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // Only treat BEGIN/END with known block names as block boundaries
    if (line.startsWith('BEGIN:VEVENT')) {
      current = {}
      depth = 0
      continue
    }
    if (line.startsWith('END:VEVENT')) {
      if (current) events.push(current)
      current = null
      continue
    }
    if (!current) continue

    // Ignore nested alarm/audio blocks
    if (line.startsWith('BEGIN:')) { depth++; continue }
    if (line.startsWith('END:'))   { depth = Math.max(0, depth - 1); continue }
    if (depth > 0) continue

    const parsed = parseLine(line)
    if (!parsed) continue

    const { name, params, value } = parsed
    const isDateProp = ['DTSTART', 'DTEND', 'DTSTAMP', 'LAST-MODIFIED', 'CREATED', 'EXDATE', 'RDATE'].includes(name)

    if (isDateProp) {
      current[name] = { value, params }
    } else {
      current[name] = unescapeText(value)
    }
  }

  return events
}

// ── Normalisation ──────────────────────────────────────────────────────────

/**
 * Convert a raw parsed VEVENT into the common event row shape.
 *
 * @param {object} ev      — Raw VEVENT from parseIcs()
 * @param {object} config  — Per-source configuration:
 *   @param {string}   config.source             — scraper source key (e.g. 'akron_symphony')
 *   @param {Function} [config.mapCategory]      — (ev) → category string (default 'community')
 *   @param {Function} [config.mapTags]          — (ev) → string[] (default [])
 *   @param {number}   [config.defaultPriceMin]  — default price_min (default 0)
 *   @param {number|null} [config.defaultPriceMax] — default price_max (default null)
 *   @param {string}   [config.ageRestriction]   — default age_restriction (default 'not_specified')
 *   @param {string}   [config.defaultImageUrl]  — fallback image if feed omits one
 * @returns {object|null}  — Event row ready for upsertEventSafe(); null if invalid
 */
export function normaliseIcsEvent(ev, config = {}) {
  const {
    source,
    mapCategory      = () => 'community',
    mapTags          = () => [],
    defaultPriceMin  = null,
    defaultPriceMax  = null,
    ageRestriction   = 'not_specified',
    defaultImageUrl  = null,
  } = config

  const title = stripHtml((ev.SUMMARY ?? '').trim())
  if (!title) return null

  const startAt = ev.DTSTART ? icsDateToIso(ev.DTSTART.value, ev.DTSTART.params) : null
  const endAt   = ev.DTEND   ? icsDateToIso(ev.DTEND.value,   ev.DTEND.params)   : null
  if (!startAt) return null

  const rawDesc = ev.DESCRIPTION ?? ''
  const description = rawDesc ? stripHtml(rawDesc).slice(0, 5000) || null : null

  // Some feeds embed the image in a custom X-… property or an ATTACH
  const imageUrl =
    ev['X-ALT-IMAGE'] ??
    ev['X-IMAGE']     ??
    ev['X-APPLE-STRUCTURED-LOCATION'] ? null :  // ignore structured location
    null

  const attachImage = typeof ev.ATTACH === 'string' && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(ev.ATTACH)
    ? ev.ATTACH
    : null

  const image_url = imageUrl || attachImage || defaultImageUrl || null

  return {
    title,
    description,
    start_at:        startAt,
    end_at:          endAt,
    category:        mapCategory(ev),
    tags:            mapTags(ev),
    price_min:       defaultPriceMin,
    price_max:       defaultPriceMax,
    age_restriction: ageRestriction,
    image_url,
    ticket_url:      ev.URL || null,
    source,
    source_id:       (ev.UID || '').trim() || null,
    status:          'published',
    featured:        false,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FEED FETCH + DISCOVERY
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

/**
 * Fetch an ICS feed URL. Throws on HTTP error or obviously wrong content.
 */
export async function fetchIcsFeed(url, opts = {}) {
  const { userAgent = DEFAULT_USER_AGENT, timeoutMs = 20_000 } = opts

  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: {
        Accept:       'text/calendar, text/plain, */*',
        'User-Agent': userAgent,
      },
      redirect: 'follow',
      signal:   controller.signal,
    })
    if (!res.ok) throw new Error(`ICS feed HTTP ${res.status} at ${url}`)

    const body = await res.text()
    if (!body.includes('BEGIN:VCALENDAR')) {
      throw new Error(
        `Feed at ${url} did not return iCalendar content (no BEGIN:VCALENDAR marker). ` +
        `The URL may serve HTML instead of .ics — verify in a browser and update the scraper config.`
      )
    }
    return body
  } finally {
    clearTimeout(tid)
  }
}

/**
 * Auto-discover an ICS feed from a page URL.
 *
 * Strategy:
 *   1. Fetch the page HTML
 *   2. Look for <link rel="alternate" type="text/calendar" href="…">
 *   3. Also try common patterns: ?ical=1, /events.ics, /feed.ics,
 *      /events/feed/?ical=1 (WordPress Tribe Events pattern)
 *
 * Returns the first URL that responds with a valid ICS body, or null.
 */
export async function discoverIcsFeed(pageUrl, opts = {}) {
  const { userAgent = DEFAULT_USER_AGENT } = opts
  const tryUrl = async (u) => {
    try {
      await fetchIcsFeed(u, { userAgent, timeoutMs: 10_000 })
      return u
    } catch { return null }
  }

  // 1. Parse the page HTML for <link rel=alternate>
  try {
    const res = await fetch(pageUrl, {
      headers: { Accept: 'text/html', 'User-Agent': userAgent },
      redirect: 'follow',
    })
    if (res.ok) {
      const html = await res.text()
      const re = /<link[^>]+rel=["']alternate["'][^>]*type=["']text\/(calendar|ics)["'][^>]*>/gi
      let m
      while ((m = re.exec(html)) !== null) {
        const hrefMatch = m[0].match(/href=["']([^"']+)["']/i)
        if (hrefMatch?.[1]) {
          const resolved = new URL(hrefMatch[1], pageUrl).toString()
          const found = await tryUrl(resolved)
          if (found) return found
        }
      }
    }
  } catch { /* ignore — fall through to URL pattern probing */ }

  // 2. Probe common feed URL patterns
  const origin = new URL(pageUrl).origin
  const pagePath = new URL(pageUrl).pathname.replace(/\/$/, '')
  const CANDIDATES = [
    `${pageUrl.replace(/\/$/, '')}?ical=1`,                // WordPress Tribe Events
    `${pageUrl.replace(/\/$/, '')}/?ical=1`,
    `${pageUrl.replace(/\/$/, '')}/feed.ics`,
    `${origin}${pagePath}.ics`,
    `${origin}/events.ics`,
    `${origin}/events/feed/?ical=1`,
    `${origin}/calendar.ics`,
    `${origin}/?ical=1`,
  ]
  for (const candidate of CANDIDATES) {
    const found = await tryUrl(candidate)
    if (found) return found
  }
  return null
}

// ════════════════════════════════════════════════════════════════════════════
// FULL PIPELINE RUNNER
// ════════════════════════════════════════════════════════════════════════════

/**
 * End-to-end pipeline for an ICS-sourced scraper.
 *
 * Fetches the feed, parses + normalises events, ensures venue + organization,
 * upserts each event, and logs a scraper_runs row. Returns a summary.
 *
 * @param {object} config
 *   @param {string}   config.source            — scraper source key (required)
 *   @param {string}   [config.feedUrl]         — direct ICS feed URL
 *   @param {string}   [config.discoveryUrl]    — page URL to auto-discover a feed
 *   @param {string}   [config.organizationName]— default organization for all events
 *   @param {object}   [config.organizationDetails] — passed to ensureOrganization
 *   @param {string}   [config.defaultVenueName]— fallback venue if VEVENT has no LOCATION
 *   @param {object}   [config.defaultVenueDetails] — passed to ensureVenue
 *   @param {Function} [config.mapCategory]     — (ev) → category
 *   @param {Function} [config.mapTags]         — (ev) → string[]
 *   @param {number}   [config.defaultPriceMin]
 *   @param {number|null} [config.defaultPriceMax]
 *   @param {string}   [config.ageRestriction]
 *   @param {string}   [config.defaultImageUrl]
 */
export async function runIcsScraper(config) {
  const { source } = config
  if (!source) throw new Error('runIcsScraper: config.source is required')

  console.log(`🚀  Starting ICS scrape: ${source}`)
  const start = Date.now()

  try {
    // Resolve ICS text. Custom scrapers can supply `getIcsText` to inject their
    // own fetch/fallback logic (e.g. snapshot files for bot-protected sites).
    // Default path: discover/fetch a feed URL over HTTP.
    let icsText
    if (typeof config.getIcsText === 'function') {
      console.log(`\n🔍  Fetching ICS text via custom getIcsText()…`)
      icsText = await config.getIcsText()
    } else {
      let feedUrl = config.feedUrl
      if (!feedUrl && config.discoveryUrl) {
        console.log(`  🔎  Discovering ICS feed from ${config.discoveryUrl}…`)
        feedUrl = await discoverIcsFeed(config.discoveryUrl)
        if (!feedUrl) {
          throw new Error(
            `No ICS feed found on ${config.discoveryUrl}. ` +
            `Open the page in a browser, find the calendar subscription link, and set config.feedUrl explicitly.`
          )
        }
        console.log(`  ✓ Discovered feed: ${feedUrl}`)
      }
      if (!feedUrl) throw new Error('runIcsScraper: either feedUrl, discoveryUrl, or getIcsText must be provided')

      // Fetch + parse
      console.log(`\n🔍  Fetching ICS feed: ${feedUrl}`)
      icsText = await fetchIcsFeed(feedUrl)
    }
    const rawEvents = parseIcs(icsText)
    console.log(`  Parsed ${rawEvents.length} VEVENT blocks`)

    if (rawEvents.length === 0) {
      await logUpsertResult(source, 0, 0, 0, {
        status: 'error',
        errorMessage: 'Feed parsed but contained 0 VEVENTs',
        durationMs: Date.now() - start,
        eventsFound: 0,
      })
      process.exit(0)
    }

    // Ensure organization + default venue (once, outside the loop)
    let organizationId = null
    if (config.organizationName) {
      organizationId = await ensureOrganization(config.organizationName, config.organizationDetails || {})
    }

    let defaultVenueId = null
    if (config.defaultVenueName) {
      defaultVenueId = await ensureVenue(config.defaultVenueName, config.defaultVenueDetails || {})
      if (organizationId && defaultVenueId) {
        await linkOrganizationVenue(organizationId, defaultVenueId)
      }
    }

    // Process each event
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    let inserted = 0, skipped = 0
    const venueCache = new Map()

    for (const ev of rawEvents) {
      try {
        const row = normaliseIcsEvent(ev, {
          source,
          mapCategory:      config.mapCategory,
          mapTags:          config.mapTags,
          defaultPriceMin:  config.defaultPriceMin,
          defaultPriceMax:  config.defaultPriceMax,
          ageRestriction:   config.ageRestriction,
          defaultImageUrl:  config.defaultImageUrl,
        })
        if (!row || !row.start_at || !row.source_id) { skipped++; continue }

        // Per-event venue: prefer VEVENT LOCATION, fall back to default
        let venueId = defaultVenueId
        const locName = (ev.LOCATION || '').trim()
        if (locName) {
          if (venueCache.has(locName)) {
            venueId = venueCache.get(locName)
          } else {
            venueId = await ensureVenue(locName, { city: 'Akron', state: 'OH' })
            venueCache.set(locName, venueId)
          }
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)

        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
        } else {
          if (venueId)        await linkEventVenue(upserted.id, venueId)
          if (organizationId) await linkEventOrganization(upserted.id, organizationId)
          inserted++
        }
      } catch (err) {
        console.warn(`  ⚠ Error processing event "${ev.SUMMARY}":`, err.message)
        skipped++
      }
    }

    const durationMs = Date.now() - start
    await logUpsertResult(source, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs,
    })
    console.log(`\n✅  ${source} done in ${(durationMs / 1000).toFixed(1)}s`)
    return { inserted, skipped, eventsFound: rawEvents.length }

  } catch (err) {
    await logScraperError(source, err, start)
    process.exit(1)
  }
}
