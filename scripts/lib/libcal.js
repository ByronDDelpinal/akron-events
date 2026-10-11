/**
 * Shared LibCal (Springshare) module.
 *
 * LibCal is the event-calendar product most public libraries run. Its public
 * calendar page is a client-side FullCalendar widget fed by an
 * un-authenticated, paginated JSON endpoint on the library's own LibCal
 * origin (the same one the widget's jQuery.ajax call hits):
 *
 *   GET /ajax/calendar/list?c=<calendarId>&date=0000-00-00&perpage=100&page=<n>
 *       &audience=&cats=&camps=&inc=0
 *     → { total_results, perpage, status, results: [...] }
 *
 * `date=0000-00-00` is the widget's "Upcoming Events" mode: rows that are
 * ongoing (a multi-day entry that began earlier and has not ended) or
 * upcoming, in date order. It is NOT the whole calendar: see the count cap
 * below. `perpage` is clamped to 100 server-side and `total_results` says how
 * many rows the list will serve, which is what the page count is derived from.
 * A page past the end is NOT an error: it answers HTTP 200 with
 * { status: 1, results: [] }.
 *
 * Each result is already parsed by the platform: `startdt`/`enddt` are
 * Eastern-local "YYYY-MM-DD HH:MM:SS" strings, `all_day` is the authoritative
 * no-clock-time flag, `audiences[]` and `categories_arr[]` are controlled
 * vocabularies of { name }, `featured_image` is an absolute CDN URL and
 * `registration_cost` is the explicit price signal. LibCal ids are 1:1 with
 * occurrences (a recurring program gets a new id per date).
 *
 * The feed is LIVE: `total_results` moves while we paginate, so a row can
 * shift across a page boundary and show up twice. fetchLibCalEvents dedupes
 * by id for that reason.
 *
 * The list is also COUNT-CAPPED server-side. Verified live 2026-10-08 on the
 * Barberton calendar (c=14558), the only calendar this was checked on: the
 * unfiltered list stopped at about 240 rows (240, then 241 with the same last
 * row a few minutes later, so the rule is not a plain fixed count). Events
 * dated after the last listed row still existed (the single-day view,
 * `date=YYYY-MM-DD`, returned them, and a `cats=<id>` filtered list of 15 rows
 * reached eight months further) but the unfiltered list omitted them, and
 * `total_results` reported the number of rows served, not the real count.
 * Three consequences:
 *   - A caller's effective lookahead is the SHORTER of its own horizon and
 *     however far the cap happens to reach that day. The reach shrinks when
 *     staff add nearer programs, and it is not a fixed number of days.
 *   - `truncated` below can only report OUR page cap, never the server's.
 *   - A row that drops off the tail of the list has NOT been removed by the
 *     library, and comes back as the dates approach. Callers must never treat
 *     absence from this feed as a cancellation.
 *
 * This module is origin-parameterized (every fetcher takes `origin` and
 * `calendarId`) and has no side effects and no DB calls: pure fetch + shape
 * helpers, importable by tests with no env. Per-library specifics (skip
 * rules, venues, category vocabulary, audiences) stay in the calling scraper,
 * because every library configures its own vocabulary.
 *
 * Usage:
 *   import { fetchLibCalEvents, libCalTimes } from './lib/libcal.js'
 *   const { events, total, truncated } = await fetchLibCalEvents({
 *     origin: 'https://events.barbertonlibrary.org', calendarId: 14558,
 *   })
 */

import { htmlToText, easternToIso, clampChars } from './normalize.js'
// The stored-description cap lives with the inferred-time disclosure, which
// has to reserve room for its note under the same cap.
import { MAX_DESCRIPTION } from './inferred-time.js'
import { fetchWithRetry } from './http.js'

/** Server-side cap on `perpage`; larger requests are clamped to 100. */
export const LIBCAL_PER_PAGE = 100

/** Safety bound (~800 events) against a pagination bug or a runaway total. */
export const LIBCAL_MAX_PAGES = 8

// Deliberately self-identifying, and the same string the Stow-Munroe Falls
// LibCal scraper sends. The Barberton and Stow origins both answered it
// without a challenge when checked by hand on 2026-10-08 (not from a CI
// runner, so that egress is unproven), and until one does challenge it there
// is nothing to gain from fetchWithRetry's rotating browser pool. An honest UA
// is the better default wherever it works.
const LIBCAL_USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

// ── Fetch ────────────────────────────────────────────────────────────────

/**
 * Build the calendar list URL for one page.
 *
 * @param {object} p
 * @param {string} p.origin        LibCal origin, no trailing slash needed
 * @param {number|string} p.calendarId  the `c=` calendar id
 * @param {number} [p.page=1]      1-based page number
 * @param {number} [p.perPage=LIBCAL_PER_PAGE]
 * @returns {string}
 */
export function buildLibCalListUrl({ origin, calendarId, page = 1, perPage = LIBCAL_PER_PAGE }) {
  const base = String(origin || '').replace(/\/+$/, '')
  return `${base}/ajax/calendar/list?c=${encodeURIComponent(calendarId)}&date=0000-00-00` +
    `&perpage=${encodeURIComponent(perPage)}&page=${encodeURIComponent(page)}&audience=&cats=&camps=&inc=0`
}

/**
 * Fetch one page of the calendar list. Throws on a non-OK response or a body
 * without a `results` array, so a broken feed can never read as an empty one.
 *
 * @param {object} p
 * @param {string} p.origin
 * @param {number|string} p.calendarId
 * @param {number} [p.page=1]
 * @param {number} [p.perPage=LIBCAL_PER_PAGE]
 * @param {function} [p.fetchImpl]  injectable fetch (tests)
 * @param {function} [p.sleep]      injectable backoff sleep (tests)
 * @returns {Promise<object>} the raw envelope { total_results, perpage, status, results }
 */
export async function fetchLibCalPage({ origin, calendarId, page = 1, perPage = LIBCAL_PER_PAGE, fetchImpl, sleep }) {
  if (!origin) throw new Error('fetchLibCalPage: origin is required')
  if (calendarId == null || calendarId === '') throw new Error('fetchLibCalPage: calendarId is required')
  const url = buildLibCalListUrl({ origin, calendarId, page, perPage })
  const res = await fetchWithRetry(url, {
    // X-Requested-With is what the widget's own jQuery.ajax call sends.
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    userAgent: LIBCAL_USER_AGENT,
    retries: 2,
    timeoutMs: 20_000,
    // Only forwarded when given, so fetchWithRetry keeps its own defaults.
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(sleep ? { sleep } : {}),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching LibCal list page ${page}`)
  const data = await res.json()
  if (!data || !Array.isArray(data.results)) throw new Error(`LibCal list page ${page} is missing its results array`)
  return data
}

/**
 * Pull every page the list serves: paginate on total_results / perpage, stop
 * on an empty page, dedupe by id, and cap at `maxPages`.
 *
 * @param {object} p
 * @param {string} p.origin
 * @param {number|string} p.calendarId
 * @param {number} [p.maxPages=LIBCAL_MAX_PAGES]
 * @param {function} [p.fetchImpl]  injectable fetch (tests)
 * @param {function} [p.sleep]      injectable backoff sleep (tests)
 * @returns {Promise<{events: object[], total: number, truncated: boolean}>}
 *   `truncated` is true only when `maxPages` cut the pagination short, i.e.
 *   the feed claimed more pages than we were willing to read. It cannot see
 *   the server-side count cap described in the module header.
 */
export async function fetchLibCalEvents({ origin, calendarId, maxPages = LIBCAL_MAX_PAGES, fetchImpl, sleep }) {
  const first = await fetchLibCalPage({ origin, calendarId, page: 1, fetchImpl, sleep })
  const total = Number(first.total_results) || first.results.length
  const perPage = Number(first.perpage) || LIBCAL_PER_PAGE
  const wanted = Math.max(1, Math.ceil(total / perPage))
  const pages = Math.min(Math.max(1, maxPages), wanted)

  const events = []
  const startById = new Map()
  const add = (results) => {
    for (const e of results) {
      const id = e?.id
      // A row without an id cannot be deduped here; the scraper rejects it.
      if (id == null || id === '') { events.push(e); continue }
      const key = String(id)
      if (startById.has(key)) {
        // Same id twice is the live feed shifting a row across a page
        // boundary. Same id with a DIFFERENT start would break the "one id is
        // one occurrence" assumption source_ids rest on, so say so loudly.
        if (startById.get(key) !== e.startdt) {
          console.warn(`  ⚠ LibCal id ${key} appears with two start times (${startById.get(key)} and ${e.startdt}); keeping the first`)
        }
        continue
      }
      startById.set(key, e.startdt)
      events.push(e)
    }
  }

  add(first.results)
  let sawEmptyPage = false
  for (let page = 2; page <= pages; page++) {
    const data = await fetchLibCalPage({ origin, calendarId, page, fetchImpl, sleep })
    if (!data.results.length) { sawEmptyPage = true; break }
    add(data.results)
  }
  return { events, total, truncated: wanted > pages && !sawEmptyPage }
}

// ── Shape helpers (pure) ─────────────────────────────────────────────────

/**
 * Names out of a LibCal `[{ name }]` list (`audiences`, `categories_arr`).
 * Tolerates a missing list and malformed members.
 *
 * @param {Array<{name?: string}>} list
 * @returns {string[]}
 */
export function libCalNames(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => (item && typeof item.name === 'string' ? item.name.trim() : ''))
    .filter(Boolean)
}

/**
 * True when the library has canceled the event. LibCal has no status field
 * for this: staff keep the entry and prefix the title, in whatever style that
 * library uses ("CANCELED- Author Visit", "CANCELLED- Job & Family Services",
 * "(Canceled) Job Seeker Station", "[CANCELED]: The AMP").
 *
 * Anchored at the start and requiring the bracket or the trailing separator,
 * so a title that merely begins with the word ("Canceled Stamps Club",
 * "Cancel Culture: A Discussion") or mentions it later ("Story Time
 * (canceled)") is not a cancellation.
 */
export function isLibCalCanceledTitle(title) {
  return /^\s*(?:[([]\s*cancell?ed\s*[)\]]:?|cancell?ed\s*[-–—:])/i.test(String(title ?? ''))
}

/**
 * Start/end for one feed object, or null when it is undatable.
 *
 * `startdt`/`enddt` are Eastern-local strings the platform already parsed, so
 * easternToIso converts them directly. The single exception is an `all_day`
 * row, whose clock time the feed does not supply at all. Detection keys off
 * the `all_day` flag, never the "00:00:00" in the string: a literal midnight
 * is indistinguishable from a genuine (if unlikely) midnight event, and the
 * flag is the source's own answer.
 *
 * @param {object} e  raw feed object
 * @returns {{startAt: string, endAt: string|null, isAllDay: boolean}|null}
 *   `isAllDay` true means startAt is the invented noon default: the caller
 *   must set `time_inferred: true` on the row it builds.
 */
export function libCalTimes(e) {
  const isAllDay = e?.all_day === true

  // SANCTIONED-DEFAULT-TIME: same product decision as scripts/lib/ics.js and
  // the non-ICS scrapers that carry the marker. A row stored at midnight falls
  // out of every feed at 00:00:01 on the morning it happens, because the feeds
  // filter `start_at >= now()` with no grace window. Noon keeps it visible.
  // The default is never silent: the calling scraper passes `isAllDay` on as
  // `row.time_inferred = true`, and upsertEventSafe (scripts/lib/
  // inferred-time.js) appends the placeholder-time note and sets needs_review,
  // unless a human has already locked start_at. Two-arg easternToIso: the date
  // comes from `startdt`, the time from us. Do not "fix" this back to midnight.
  const startAt = isAllDay ? easternToIso(e?.startdt, '12:00:00') : easternToIso(e?.startdt)
  if (!startAt) return null
  let endAt = e.enddt ? easternToIso(e.enddt) : null

  // Pushing the start to noon can invert the interval: a same-day all-day row
  // may end at midnight on its own date. An unknown end is honest, a backwards
  // one is not. (NaN <= n is false, so a malformed end is left alone.)
  if (isAllDay && endAt && Date.parse(endAt) <= Date.parse(startAt)) endAt = null

  return { startAt, endAt, isAllDay }
}

/**
 * Parse the LibCal `registration_cost` string. An empty or absent value means
 * free (library programs are free unless the field says otherwise); a
 * populated value (a rare materials fee) is parsed as a number or a range.
 *
 * @param {string} cost
 * @returns {{price_min: number, price_max: number|null}}
 */
export function parseLibCalPrice(cost = '') {
  const nums = String(cost || '').match(/\d+(\.\d+)?/g)?.map(Number).filter((n) => !Number.isNaN(n))
  if (!nums || !nums.length) return { price_min: 0, price_max: null }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  return { price_min: min, price_max: max > min ? max : null }
}

/** `featured_image` when it is an absolute http(s) URL, else null. */
export function libCalImageUrl(e) {
  const url = typeof e?.featured_image === 'string' ? e.featured_image.trim() : ''
  return /^https?:\/\//i.test(url) ? url : null
}

/**
 * Listing-ready description for one feed object, or null when it has none.
 *
 * Reads `description` ONLY. `more_info` is the library's standing newsletter
 * sign-up boilerplate and `shortdesc` is a truncated copy of `description`,
 * so neither adds anything a reader wants.
 *
 * The placeholder-time note for an all-day row is deliberately NOT appended
 * here. upsertEventSafe owns that disclosure (off `row.time_inferred`), because
 * only it can see whether a human has locked start_at, in which case the time
 * is settled and the note would be wrong.
 *
 * @param {object} e  raw feed object
 * @returns {string|null}
 */
export function libCalDescription(e) {
  const text = e?.description ? htmlToText(String(e.description)) : ''
  // clampChars, not slice: a bare slice can cut through a surrogate pair.
  return text ? clampChars(text, MAX_DESCRIPTION) : null
}
