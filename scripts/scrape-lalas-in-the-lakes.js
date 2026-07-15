/**
 * scrape-lalas-in-the-lakes.js
 *
 * Lala's in the Lakes — restaurant in the Portage Lakes area of Akron
 * (4315 Manchester Road, Akron, OH 44319, Summit County). The /events page is
 * a Popmenu "calendar" custom-page section listing the venue's live-music
 * lineup (a standing weekly piano night plus dated guest performers).
 *
 * Platform: Popmenu (NOT Squarespace, despite the /items/ menu URLs and
 * sitemap.xml — the site runs on popmenu.com's React front end). The public
 * pages sit behind a Cloudflare "Just a moment" managed challenge that blocks
 * plain document GETs, but the Popmenu GraphQL endpoint (POST /graphql) is NOT
 * challenged and answers server-side. We therefore skip the HTML entirely and
 * query the calendar section directly.
 *
 * Feed quirks:
 *   • Events come from customPageSection(sectionId).upcomingCalendarEvents.
 *     SECTION_ID is the events-page section id (2032762), embedded in the page;
 *     it is stable but a hard dependency — if the site is rebuilt and the id
 *     changes, the query returns an empty section (main() warns on 0 events).
 *   • The endpoint rejects the request with "unauthorized" unless Origin +
 *     Referer headers name the site — so both are sent on every call.
 *   • We send a self-contained GraphQL query (not Popmenu's persisted-operation
 *     hash) so a client-bundle redeploy that rotates the hash can't break us.
 *   • upcomingCalendarEvents returns event DEFINITIONS, not per-date instances:
 *     a recurring event (isRecurring + weekday booleans) is one row that the
 *     calendar UI expands client-side. We expand the standing weekly night into
 *     the next WEEKLY_OCCURRENCE_COUNT dated occurrences (Eastern-anchored via
 *     lib/weekly-occurrences.js) and emit dated one-offs as single events.
 *   • startTime/endTime are seconds-since-midnight in the venue's local
 *     (Eastern) day; paired with the date via easternToIso(ymd, 'HH:MM:SS').
 *   • calendarEventRecurringExceptions (skipped weeks) is a related object type
 *     that introspection blocks and the only recurring event carries none, so
 *     it is intentionally not queried; a rare cancelled week would still show.
 *
 * Single fixed venue — every event is at Lala's; VENUE_DETAILS is verified by
 * hand and main() warns if the API location drifts.
 *
 * Usage:   node scripts/scrape-lalas-in-the-lakes.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso, stripHtml, inferCategory,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { nextWeeklyOccurrences } from './lib/weekly-occurrences.js'

export const SOURCE_KEY = 'lalas_in_the_lakes'

const SITE_BASE_URL = 'https://www.lalasinthelakes.com'
const GRAPHQL_URL   = `${SITE_BASE_URL}/graphql`
const EVENTS_URL    = `${SITE_BASE_URL}/events`
const SECTION_ID    = 2032762
const USER_AGENT    =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

// How far out to ask the API for events (one-offs are ingested across the whole
// window) and how many occurrences to project for a standing weekly series
// (~12 weeks keeps a recurring restaurant gig from flooding the calendar a
// half-year out while still filling the near-term view).
const QUERY_HORIZON_DAYS      = 180
const WEEKLY_OCCURRENCE_COUNT = 12

// Start of the past-event grace window: an occurrence whose start is more than
// 3 hours old is dropped (a gig that began earlier tonight is still "on").
const PAST_GRACE_MS = 3 * 3600_000

const ORG_NAME   = "Lala's in the Lakes"
const VENUE_NAME = "Lala's in the Lakes"
const VENUE_DETAILS = {
  address: '4315 Manchester Road',
  city: 'Akron', state: 'OH', zip: '44319',
  website: SITE_BASE_URL,
  description:
    "Scratch-kitchen restaurant and bar in the Portage Lakes area of Akron, " +
    "with live music several nights a week.",
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** JS Date weekday index (0=Sun … 6=Sat) for each true day flag on an event. */
export function activeWeekdays(ev) {
  const flags = [
    ev.isSunday, ev.isMonday, ev.isTuesday, ev.isWednesday,
    ev.isThursday, ev.isFriday, ev.isSaturday,
  ]
  return flags.map((on, i) => (on ? i : -1)).filter((i) => i >= 0)
}

/**
 * Seconds-since-midnight → 'HH:MM:SS' clock token for easternToIso.
 * Returns null for null/undefined (a time-less event), so callers can decide
 * whether to skip rather than silently pin the event to midnight.
 */
export function secondsToClock(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return null
  const s = Number(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(ss)}`
}

/** UTC-midnight ms of a 'YYYY-MM-DD' string (whole-day calendar arithmetic). */
function ymdToUtcMs(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  if (!y || !m || !d) return NaN
  return Date.UTC(y, m - 1, d)
}

/**
 * Content category for a calendar event. Lala's calendar is a live-music
 * lineup, so a performer name that text-inference can't place ('other'/'civic')
 * defaults to 'music'; explicit trivia/bingo or themed-dinner language routes
 * to games / food so a non-music night is never mislabelled.
 */
export function mapCategory(ev) {
  const text = `${ev.name || ''} ${ev.description || ''}`
  const cat = inferCategory(ev.name || '', ev.description || '')
  if (cat && cat !== 'other' && cat !== 'civic') return cat
  if (/\b(trivia|bingo|quiz|game night)\b/i.test(text)) return 'games'
  if (/\b(dinner|tasting|brunch|prix[\s-]?fixe|wine\s+pairing|beer\s+dinner)\b/i.test(text)) return 'food'
  return 'music'
}

/** A small, deterministic tag set keyed off the venue and resolved category. */
export function mapTags(ev, category) {
  const tags = ['portage-lakes', 'akron', 'lalas']
  if (category === 'music') tags.unshift('live-music')
  if (category === 'games') tags.push('trivia')
  if (category === 'food')  tags.push('dining')
  if (/\bpiano\b/i.test(ev.description || '')) tags.push('piano')
  return [...new Set(tags)]
}

/**
 * Upcoming 'YYYY-MM-DD' occurrence dates for a recurring event, bounded by the
 * series' own startAt/endAt window. Multiple weekday flags are merged.
 */
export function recurringOccurrences(ev, now, count = WEEKLY_OCCURRENCE_COUNT) {
  const startMs = ev.startAt ? ymdToUtcMs(ev.startAt) : -Infinity
  const endMs   = ev.endAt   ? ymdToUtcMs(ev.endAt)   : Infinity
  const out = new Set()
  for (const wd of activeWeekdays(ev)) {
    for (const ymd of nextWeeklyOccurrences(wd, { count, now })) {
      const ms = ymdToUtcMs(ymd)
      if (ms < startMs || ms > endMs) continue
      out.add(ymd)
    }
  }
  return [...out].sort()
}

/**
 * Turn the raw upcomingCalendarEvents array into flat, dated event descriptors
 * ready for upsert. Recurring events fan out to WEEKLY_OCCURRENCE_COUNT dated
 * occurrences; one-offs pass through on their startAt. Events with no clock
 * time (and not all-day) are skipped rather than pinned to midnight, and
 * anything already past (server flag or computed start) is dropped.
 */
export function buildEvents(rawEvents = [], now = new Date(), opts = {}) {
  const { weeklyCount = WEEKLY_OCCURRENCE_COUNT } = opts
  const cutoff = now.getTime() - PAST_GRACE_MS
  const seen = new Set()
  const events = []

  for (const ev of rawEvents) {
    const title = (ev.name || '').trim()
    if (!title) continue
    // Cancelled/postponed events surface via the event status or a title marker
    // (the recurring-exceptions object is not queried, so a scratched week can
    // still arrive). Title-scoped (never description) per the shared convention.
    if (/\bcancel?led\b|\bpostponed\b/i.test(title)) continue
    if (typeof ev.status === 'string' && /cancel/i.test(ev.status)) continue

    const startClock = secondsToClock(ev.startTime)
    const endClock   = secondsToClock(ev.endTime)
    // A timed event with no start time would land at midnight — skip it.
    if (!startClock && !ev.isAllDay) continue

    const category    = mapCategory(ev)
    const tags        = mapTags(ev, category)
    const description = ev.description ? (stripHtml(ev.description).trim() || null) : null
    const imageUrl    = ev.photoUrl || null

    const makeRow = (ymd, kind) => {
      const startIso = startClock ? easternToIso(ymd, startClock) : easternToIso(ymd, '')
      let endIso = null
      if (startClock && endClock && endClock > startClock) endIso = easternToIso(ymd, endClock)
      return {
        kind, title, description, category, tags,
        imageUrl, ymd, startIso, endIso,
        ticketUrl: EVENTS_URL,
        sourceId: `${ev.slug || ev.id}-${ymd}`,
      }
    }

    let rows = []
    if (ev.isRecurring) {
      rows = recurringOccurrences(ev, now, weeklyCount).map((ymd) => makeRow(ymd, 'recurring'))
    } else {
      if (ev.isPastEvent || !ev.startAt) continue
      rows = [makeRow(ev.startAt, 'single')]
    }

    for (const row of rows) {
      if (!row.startIso || Date.parse(row.startIso) < cutoff) continue
      if (seen.has(row.sourceId)) continue
      seen.add(row.sourceId)
      events.push(row)
    }
  }

  return events.sort((a, b) => a.startIso.localeCompare(b.startIso))
}

// ── Fetch ────────────────────────────────────────────────────────────────────

const CALENDAR_QUERY = `
query customPageCalendarSection($sectionId: Int!, $rangeStartAt: DateTime, $rangeEndAt: DateTime, $limit: Int) {
  customPageSection(sectionId: $sectionId) {
    id
    upcomingCalendarEvents(rangeStartAt: $rangeStartAt, rangeEndAt: $rangeEndAt, limit: $limit) {
      id name slug description startAt endAt startTime endTime isAllDay isRecurring recurringType
      isSunday isMonday isTuesday isWednesday isThursday isFriday isSaturday
      isPastEvent status eventTimeDescription photoUrl calendarEventPageUrl
      calendarEventSelectedLocations { isEnabled location { streetAddress city state postalCode country name } }
    }
  }
}`.trim()

/**
 * Fetch upcoming calendar events from the Popmenu GraphQL endpoint. Returns the
 * raw upcomingCalendarEvents array. `now` is injectable for symmetry (the range
 * is anchored to it); network, so not exercised by the unit tests.
 */
export async function fetchCalendarEvents(now = new Date(), horizonDays = QUERY_HORIZON_DAYS) {
  const rangeStartAt = new Date(now.getTime() - PAST_GRACE_MS).toISOString()
  const rangeEndAt   = new Date(now.getTime() + horizonDays * 86_400_000).toISOString()

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Origin: SITE_BASE_URL,
      Referer: EVENTS_URL,
    },
    body: JSON.stringify({
      operationName: 'customPageCalendarSection',
      query: CALENDAR_QUERY,
      variables: { sectionId: SECTION_ID, rangeStartAt, rangeEndAt, limit: null },
    }),
  })

  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status} fetching calendar section`)
  const json = await res.json()
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`)
  }
  return json.data?.customPageSection?.upcomingCalendarEvents ?? []
}

/**
 * The venue address as the API reports it for the first enabled location — a
 * drift guard, not the source of truth (VENUE_DETAILS is verified by hand).
 */
export function apiLocation(rawEvents = []) {
  for (const ev of rawEvents) {
    for (const sel of ev.calendarEventSelectedLocations ?? []) {
      if (sel.isEnabled && sel.location?.streetAddress) return sel.location
    }
  }
  return null
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log("🎹  Starting Lala's in the Lakes ingestion…")
  const start = Date.now()
  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, {
        website: VENUE_DETAILS.website,
        description: VENUE_DETAILS.description,
      }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const now = new Date()
    const raw = await fetchCalendarEvents(now)
    console.log(`  ${EVENTS_URL} → ${raw.length} calendar event definitions`)
    // A 0-length section is the signature of the pinned SECTION_ID going stale
    // (site rebuild rotates the id → empty section). Warn loudly rather than
    // silently posting nothing.
    if (raw.length === 0) {
      console.warn(`  ⚠ 0 calendar events — SECTION_ID ${SECTION_ID} may be stale (site rebuilt?)`)
    }

    const loc = apiLocation(raw)
    if (loc && (loc.state !== VENUE_DETAILS.state || loc.streetAddress !== VENUE_DETAILS.address)) {
      console.warn('  ⚠ API location drifted from VENUE_DETAILS:', JSON.stringify(loc))
    }

    const events = buildEvents(raw, now)
    console.log(`  → ${events.length} dated events (` +
      `${events.filter((e) => e.kind === 'recurring').length} recurring, ` +
      `${events.filter((e) => e.kind === 'single').length} one-off)`)

    let inserted = 0, skipped = 0
    for (const ev of events) {
      const row = {
        title:           ev.title,
        description:     ev.description,
        start_at:        ev.startIso,
        end_at:          ev.endIso,
        category:        ev.category,
        tags:            ev.tags,
        price_min:       null,   // live music at the restaurant states no cover either way
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       ev.imageUrl,
        ticket_url:      ev.ticketUrl,
        source:          SOURCE_KEY,
        source_id:       ev.sourceId,
        status:          'published',
        featured:        false,
      }
      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed "${row.title}" (${ev.ymd}):`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: events.length, durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
