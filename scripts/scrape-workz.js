/**
 * scrape-workz.js
 *
 * The Workz (playattheworkz.com) — a family entertainment center on the
 * Cuyahoga Falls riverfront (Summit County): restaurant, bar, bowling, arcade,
 * VR, a hidden "speakeazy", party rooms, and a steady live-music/entertainment
 * calendar (bands, DJ nights, line dancing, salsa, paint & sip, board-game
 * nights, parties).
 *
 * PLATFORM: the site's "Music & Events" page embeds a third-party **Events
 * Calendar by eventscalendar.co** (built on the Inffuse platform), NOT Wix
 * Events — the leftover Wix Events app on the site only holds two stale 2023
 * rows. The real calendar is a client-rendered widget whose data comes from a
 * public JSON endpoint keyed by the venue's Inffuse project id:
 *
 *   https://inffuse.eventscalendar.co/api/v0.1/projects/<project>/data/public/events?app=calendar
 *   → { result: true, value: [ { title, description, start(ms), startDate,
 *       startHour, startMinutes, endHour, endMinutes, allday, timezone,
 *       location, links, id, image:{url}, ... }, ... ] }
 *
 * The widget also sends a `user=` param; it is provably IGNORED server-side
 * (dropping it returns the identical 583-row payload), so we don't send it.
 *
 * Each row is a concrete dated instance (recurring specials are pre-expanded, so
 * no RRULE handling). `start`/`end` are date-only UTC midnight; the real clock
 * time lives in startHour/startMinutes (America/New_York).
 *
 * SCOPE (per byron): publish the actual EVENTS and skip the recurring
 * food/play/bar specials, promos and closures that share the calendar — "All You
 * Can Eat Wings", "Kids/Kidz Eat & Play FREE", "Wing Wednesday/Night", "Happy
 * Hour", "Strikes-N-Slices", "Family Fun Fridays", "CLOSED …"/"… - Closed" days,
 * and hours/deal notices ("Extended Hours!", "DEAL FOR DAD"). See isNonEvent.
 *
 * GEO GATE: the calendar is MOSTLY but not entirely the venue's own room —
 * `location` is empty or "The Workz" on 582 of 583 rows, and "Cuyahoga Falls
 * Amphitheater" on one (Nightmare on Front Street, a downtown CF festival the
 * venue lists). So the venue is per-row, not hardcoded: home rows get the fixed
 * VENUE below, anything else is routed through classifySummitLocation() and
 * DROPPED unless it classifies 'in'. We never trust a source's own geography.
 * The Workz is credited as organizer only for events in its own building.
 *
 * The project id below is account-stable; it is baked into the widget config and
 * doesn't rotate. If the venue ever rebuilds the calendar, refresh it from the
 * widget request (plugin.eventscalendar.co/widget.html → the
 * inffuse.eventscalendar.co /data/public/events call).
 *
 * Usage:   node scripts/scrape-workz.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, enrichWithImageDimensions, upsertEventSafe,
  linkEventVenue, linkEventOrganization, ensureVenue, ensureOrganization,
  linkOrganizationVenue, easternToIso, easternTodayIso, titleCaseIfShouting,
  splitCommaLocation,
} from './lib/normalize.js'
import {
  classifySummitLocation, SUMMIT_COUNTY_CITIES, NOT_SUMMIT_COUNTY_CITIES,
} from './lib/summit-county.js'

export const SOURCE_KEY = 'workz'

const PROJECT = 'proj_Xg9tHnDTkG8hagUa4rHyz'
const DATA_URL = `https://inffuse.eventscalendar.co/api/v0.1/projects/${PROJECT}/data/public/events?app=calendar`
const SITE  = 'https://www.playattheworkz.com'
const PAGE  = `${SITE}/music-events`
const ORG_NAME = 'The Workz'
// name must match the live venues row EXACTLY ("THE WORKZ on the Riverfront",
// 2220 Front St) or ensureVenue's name lookup misses and the row is only found
// by the address fallback — which silently stops working the moment the feed
// stops carrying an address.
const VENUE = {
  name: 'THE WORKZ on the Riverfront', address: '2220 Front St', city: 'Cuyahoga Falls',
  state: 'OH', zip: '44221', website: SITE,
}

// ── Scope filter (exported for tests) ────────────────────────────────────────

// Closure notices. Position-INDEPENDENT on purpose: the venue writes them both
// as a prefix ("CLOSED-4TH OF JULY", "CLOSED: JULY 4TH") and as a suffix
// ("Thanksgiving - Closed", "Christmas Eve - Closed"), and the original
// `^closed|closed-|closed\s` form only caught the prefix, so every trailing
// form published as a real event. \b keeps "enclosed"/"disclosed" out.
const CLOSURE_RE = /(^|[\s\-–:(])closed\b|\bclosed\s*(for|until|at|-)|facility rental/i
// Hours / discount notices, which are store operations rather than events
// ("Extended Hours!", "SUPER BOWL DEAL (OPEN LATE)", "DEAL FOR DAD"). Anchored
// on `\bdeal for\b` rather than a bare "deal" so a band called "Big Deal" or a
// "Deal or No Deal" trivia night still publishes.
const PROMO_RE = /extended hours|open late|\bdeal for\b/i

/**
 * True when a calendar entry is one of the recurring food / play / bar specials,
 * an hours/deal notice, or a closure — i.e. NOT a real event to publish.
 * Denylist (not an allowlist) because the genuine events are open-ended (any
 * band, class, party) while the non-events are a small, stable set of recurring
 * promos plus closure notices. Every arm matches a SHAPE, never a specific
 * title, so a new spelling of the same notice is still caught.
 */
export function isNonEvent(title) {
  const t = String(title || '').trim()
  if (!t) return true
  return (
    /all you can eat/i.test(t) ||
    /kid[sz]\b.*(eat|play)|eat\s*&\s*play|eat and play/i.test(t) ||
    /wing (wednesday|night)/i.test(t) ||
    /happy hour/i.test(t) ||
    /strikes.?n.?slices/i.test(t) ||
    /family fun frida/i.test(t) ||
    CLOSURE_RE.test(t) ||
    PROMO_RE.test(t)
  )
}

/** 21+ programming (speakeasy shows, 21+ parties) → age_restriction flag. */
export function isTwentyOnePlus(title, description) {
  return /\b21\+|\b21 ?& ?(over|older)|\b21 and (over|older)|21\+ ?over/i
    .test(`${title || ''} ${description || ''}`)
}

// ── Per-row venue + Summit County gate (exported for tests) ──────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const cityAlternation = (set) => new RegExp(
  `\\b(${[...set].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})\\b`, 'i',
)
// Built once at module load from the shared city lists — pure data, no side
// effects, so the module stays import-safe.
const SUMMIT_CITY_RE     = cityAlternation(SUMMIT_COUNTY_CITIES)
const NON_SUMMIT_CITY_RE = cityAlternation(NOT_SUMMIT_COUNTY_CITIES)

/**
 * Pull a city out of an off-site `location` string. The feed's location is a
 * bare place NAME ("Cuyahoga Falls Amphitheater"), not an address — there is no
 * city field and no coordinates — so the only signal available is a city name
 * embedded in the name itself. Comma-shaped strings go through the shared
 * splitCommaLocation first; otherwise we scan for a known city, checking the
 * SUMMIT list first so "…on Cleveland-Massillon Rd, Akron" reads as Akron
 * rather than Cleveland. Returns null when nothing is recognisable, which the
 * caller treats as 'unknown' → dropped.
 */
export function workzCityFromLocation(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  const split = splitCommaLocation(s)
  if (split?.city) return split.city
  const m = SUMMIT_CITY_RE.exec(s) || NON_SUMMIT_CITY_RE.exec(s)
  return m ? m[1] : null
}

/** True for the venue's own room — an empty location, or any spelling of it. */
export function isHomeVenue(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim()
  return !s || /\bthe\s*workz\b/i.test(s) || /^workz$/i.test(s)
}

/**
 * Resolve one row's venue and its Summit County locality.
 *
 * → { venue, locality, home }. `locality` is classifySummitLocation()'s
 * three-way verdict; the caller publishes ONLY 'in'. Home rows are 'in' by
 * construction (2220 Front St, Cuyahoga Falls). Pure + exported for tests.
 */
export function resolveWorkzVenue(ev) {
  const raw = String(ev?.location || '').replace(/\s+/g, ' ').trim()
  if (isHomeVenue(raw)) return { venue: VENUE, locality: 'in', home: true }
  const city = workzCityFromLocation(raw)
  const locality = classifySummitLocation({ city })
  if (locality !== 'in') return { venue: null, locality, home: false }
  return { venue: { name: raw, city, state: 'OH' }, locality, home: false }
}

// ── Dates ────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * The row's calendar date (YYYY-MM-DD, America/New_York).
 *
 * Normally `startDate`. One live row (90 PROOF, 2026-08-15) carries no
 * startDate/endDate/timezone at all — only the date-only `start` epoch — and
 * was being dropped as undated. `start` is UTC MIDNIGHT of the event's date by
 * construction (every value in the feed is an exact multiple of 86,400,000), so
 * reading its UTC calendar parts is exact, not a timezone guess. This is NOT a
 * "today" derivation: the anchor is an explicit per-event epoch from the feed,
 * never the clock (see scripts/tests/test-no-utc-today.js).
 */
export function workzStartDate(ev) {
  if (ev?.startDate) return ev.startDate
  const ms = ev?.start
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/**
 * Build the ISO start timestamp (America/New_York) from an Events Calendar row.
 * The clock time lives in startHour/startMinutes; `start` (ms) is only a
 * date-only anchor. When a kept event has no explicit hour we fall back to a
 * SANCTIONED-DEFAULT-TIME of 7:00pm (evening programming) rather than midnight.
 *
 * The gate is `allday`, NOT a null hour: startHour is never null in this feed —
 * all-day rows carry startHour:0/startMinutes:0. Testing only for a finite hour
 * therefore published every all-day row (festivals, Prohibition Party, the
 * Halloween event) at midnight ET, where `.gte('start_at', now)` hides it from
 * every feed for the whole day it happens on.
 */
export function workzStartIso(ev) {
  const date = workzStartDate(ev)
  if (!date) return null
  const hasHour = !ev?.allday
    && Number.isFinite(ev?.startHour)
    && !(ev.startHour === 0 && ev.startMinutes === 0)
  let hour = 19, minute = 0 // SANCTIONED-DEFAULT-TIME: evening default when the feed omits a time
  if (hasHour) { hour = ev.startHour; minute = Number.isFinite(ev.startMinutes) ? ev.startMinutes : 0 }
  return easternToIso(date, `${pad2(hour)}:${pad2(minute)}`)
}

/**
 * Build the ISO end timestamp, or null when the feed doesn't carry a usable
 * one. All-day rows are excluded outright (their 0:00 end is a placeholder);
 * multi-day rows keep their real endDate, which is how a Friday-night show that
 * runs to 1am lands correctly. The caller drops any end that isn't strictly
 * after the start, so a same-day midnight placeholder can never invert the row.
 */
export function workzEndIso(ev) {
  if (!ev || ev.allday) return null
  const date = ev.endDate || workzStartDate(ev)
  if (!date || !Number.isFinite(ev.endHour)) return null
  const minute = Number.isFinite(ev.endMinutes) ? ev.endMinutes : 0
  return easternToIso(date, `${pad2(ev.endHour)}:${pad2(minute)}`)
}

/** First external link (Facebook event / ticket page) if the entry carries one. */
export function firstLink(ev) {
  const links = ev?.links
  if (!links || typeof links !== 'object') return null
  const first = Object.values(links)[0]
  return (first && typeof first === 'object' && first.url) ? first.url : null
}

/**
 * Display title. This feed is 100% ALL CAPS, and the pipeline's default
 * de-shouting only fires above 25 characters — which cased exactly one of the
 * twelve publishable titles and left the other eleven screaming. Casing is
 * therefore applied here with no length floor, reusing normalize.js's fold sets
 * so minor words and acronyms behave identically to every other source.
 * "DANNY CHRISTIAN (SPEAKEAZY)" → "Danny Christian (Speakeazy)" (the venue's
 * own spelling of their room is preserved, only its case changes).
 */
export function workzTitle(raw) {
  return titleCaseIfShouting(String(raw || '').trim(), { minLength: 0, keepShortInitialisms: true })
}

/**
 * Map one Events Calendar entry → an event row, or null to drop it (non-event,
 * undated, already past, or outside Summit County). `now` is injectable for
 * tests. Category is left to the pipeline (manifest defaultCategory 'music' +
 * text inference).
 */
export function normaliseWorkzEvent(ev, { now = new Date() } = {}) {
  const rawTitle = String(ev?.title || '').trim()
  if (isNonEvent(rawTitle)) return null

  const startIso = workzStartIso(ev)
  if (!startIso) return null

  // Upcoming only — anchored to Eastern "today", inclusive of the rest of today.
  const startDate = workzStartDate(ev)
  if ((startDate || '') < easternTodayIso(now)) return null

  // Never trust the source's geography: the calendar carries the occasional
  // off-site listing, so every row is classified before it can publish.
  if (resolveWorkzVenue(ev).locality !== 'in') return null

  const endIso = workzEndIso(ev)

  const row = {
    source: SOURCE_KEY,
    source_id: ev.id || `${rawTitle}-${startDate}`,
    title: workzTitle(rawTitle),
    description: String(ev.description || '').trim() || null,
    start_at: startIso,
    category: 'other',                 // pipeline reclassifies (defaultCategory 'music' + text)
    status: 'published',
    featured: false,                   // never human-featured by a scraper
    image_url: (ev.image && ev.image.url) || null,
    ticket_url: firstLink(ev) || PAGE,
    // NOT NULL in the DB with a default of 'not_specified'; an explicit null is
    // an error, not a fall-back to that default.
    age_restriction: isTwentyOnePlus(rawTitle, ev.description) ? '21_plus' : 'not_specified',
  }
  if (endIso && endIso > startIso) row.end_at = endIso
  return row
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export async function fetchWorkzEvents(url = DATA_URL) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)',
    },
  })
  if (!res.ok) throw new Error(`Events Calendar API ${res.status} ${res.statusText}`)
  const json = await res.json()
  // The API answers a rejected/unknown project with HTTP 200 and
  // { result: false }. Treating that as an empty list turns a broken feed into
  // a clean zero-row run that reads as "the venue posted nothing this month".
  if (json?.result !== true || !Array.isArray(json?.value)) {
    throw new Error(`Events Calendar API returned result=${JSON.stringify(json?.result)} (no event list)`)
  }
  return json.value
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎸  Starting The Workz (Events Calendar) ingestion…')
  const start = Date.now()
  try {
    const all = await fetchWorkzEvents()
    const kept = []
    let offsite = 0
    for (const ev of all) {
      const row = normaliseWorkzEvent(ev)
      if (!row) continue
      const { venue, home } = resolveWorkzVenue(ev)
      if (!home) offsite++
      kept.push({ row, venue, home, date: workzStartDate(ev) })
    }
    console.log(`  ${all.length} calendar entr(ies) → ${kept.length} upcoming event(s) to publish (${offsite} off-site)`)

    const organizerId = await ensureOrganization(ORG_NAME, {
      website: SITE,
      description: 'The Workz is a family entertainment center on the Cuyahoga Falls riverfront — restaurant, bar, bowling, arcade, VR, a speakeasy, and live music/entertainment.',
    })
    const homeVenueId = await ensureVenue(VENUE.name, {
      address: VENUE.address, city: VENUE.city, state: VENUE.state, zip: VENUE.zip, website: SITE,
    })
    if (organizerId && homeVenueId) await linkOrganizationVenue(organizerId, homeVenueId)

    // Off-site rows (already Summit-gated) get their own venue, resolved once
    // per distinct name. No website/address is passed: we only know the name,
    // and ensureVenue refuses to mint an address-named junk row.
    const venueIds = new Map([[VENUE.name, homeVenueId]])
    const venueIdFor = async (venue) => {
      if (!venue?.name) return null
      if (venueIds.has(venue.name)) return venueIds.get(venue.name)
      const id = await ensureVenue(venue.name, { city: venue.city, state: venue.state })
      venueIds.set(venue.name, id)
      return id
    }

    let inserted = 0, skipped = 0
    for (const { row, venue, home, date } of kept) {
      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skipped++; continue }
      const venueId = await venueIdFor(venue)
      if (venueId) await linkEventVenue(upserted.id, venueId)
      // Organizer credit only for events in The Workz's own building — an
      // off-site listing is somebody else's event that they happen to promote.
      if (organizerId && home) await linkEventOrganization(upserted.id, organizerId)
      inserted++
      console.log(`  ✓ ${row.title} (${date}${home ? '' : ` @ ${venue.name}`})`)
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: kept.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
