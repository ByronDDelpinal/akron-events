/**
 * scrape-akron-public-schools.js
 *
 * Fetches district-wide calendar events from Akron Public Schools.
 *
 * Caveat: the district calendar mixes public-facing events (music
 * performances, sports, open houses, community meetings) with internal
 * administrative dates (PTO meetings, staff training, building closures).
 * We apply a keyword filter to surface only public-facing items.
 *
 * Per the config memory, final filter tuning should be reviewed with the
 * user — this is a conservative starting pass.
 *
 * Usage:
 *   node scripts/scrape-akron-public-schools.js
 *
 * Environment overrides:
 *   AKRON_PUBLIC_SCHOOLS_ICS_URL — direct ICS feed URL(s), comma-separated.
 *     Optional — falls back to DEFAULT_FEED_URLS (the district's public
 *     Finalsite iCal feeds) when unset, same as its sibling scrapers. If the
 *     resolved feeds together parse to 0 VEVENTs, the scraper makes one
 *     last-resort attempt to discover a feed URL from CALENDAR_PAGE and,
 *     if that yields a URL not already tried, fetches and parses it too.
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  enrichWithImageDimensions,
  ensureOrganization,
  ensureVenue,
  inferCategory,
  linkEventOrganization,
  linkEventVenue,
  logScraperError,
  logUpsertResult,
  stripHtml,
  upsertEventSafe,
  easternToIso,
} from './lib/normalize.js'
import {
  fetchIcsFeed, parseIcs, normaliseIcsEvent, discoverIcsFeed,
  isDateOnlyIcsEvent, applyNeedsReviewHook, DATE_ONLY_TIME_NOTE,
} from './lib/ics.js'

const SOURCE_KEY = 'akron_public_schools'
const CALENDAR_PAGE = 'https://www.akronschools.com/district/district-information/calendar'

// The district (Finalsite) publishes one iCal feed per calendar; these are the
// public District Calendar + Fine Arts Calendar feeds, verified serving
// text/calendar. calendar_397 (Fine Arts) is currently a valid but EMPTY
// calendar (0 VEVENTs) — kept here for when the district starts populating it.
// AKRON_PUBLIC_SCHOOLS_ICS_URL overrides this list when set.
const DEFAULT_FEED_URLS = [
  'https://www.akronschools.com/calendar/calendar_349.ics',
  'https://www.akronschools.com/calendar/calendar_397.ics',
]

// Pure — exported for tests. Returns the configured feed URL(s): env var
// (comma-separated, trimmed, blanks dropped) when non-empty, else the
// hardcoded default feeds.
export function resolveFeedUrls(env = process.env) {
  const fromEnv = (env.AKRON_PUBLIC_SCHOOLS_ICS_URL || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  return fromEnv.length > 0 ? fromEnv : DEFAULT_FEED_URLS
}

// ── Public-facing event filter ────────────────────────────────────────────
//
// Rather than ingest every VEVENT, only include items that look like public
// gatherings. Tune these keyword lists as patterns emerge from real data.

const PUBLIC_KEYWORDS = [
  'concert', 'recital', 'performance', 'show', 'play', 'musical', 'band', 'choir', 'orchestra',
  'game', 'match', 'meet', 'tournament', 'scrimmage',   // athletics
  'open house', 'family night', 'community', 'fair', 'festival',
  'graduation', 'commencement', 'ceremony',
  'board meeting', 'school board', 'public hearing',
  'fundraiser', 'bake sale', 'book fair',
]

const EXCLUDE_KEYWORDS = [
  'staff', 'pd day', 'professional development', 'in-service', 'teacher workday',
  'no school', 'early dismissal', 'late start', 'closed',
  'report cards', 'progress reports', 'conferences only',
]

function isPublicFacing(ev) {
  const hay = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''} ${ev.CATEGORIES || ''}`.toLowerCase()
  if (EXCLUDE_KEYWORDS.some(k => hay.includes(k))) return false
  return PUBLIC_KEYWORDS.some(k => hay.includes(k))
}

// Category: infer from event text; school events default to 'learning'.
function mapCategory(ev) {
  const cat = inferCategory(ev.SUMMARY || '', ev.DESCRIPTION || '')
  return cat === 'other' ? 'learning' : cat
}

function mapTags(ev) {
  const tags = ['schools', 'education']
  const text = (ev.SUMMARY || '').toLowerCase()
  if (/\b(game|match|tournament)\b/.test(text)) tags.push('athletics')
  if (/\b(concert|recital|band|choir|orchestra)\b/.test(text)) tags.push('music')
  return [...new Set(tags)]
}

// ── Date-only twins + explicit times ──────────────────────────────────────
//
// The district feeds list many events twice under different UIDs: one timed
// VEVENT and one bare-date (VALUE=DATE) twin. Left alone the twin is
// noon-defaulted and published beside the timed row.

function squashTitle(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Pure — exported for tests. Groups VEVENTs by squashed SUMMARY + DTSTART
 * calendar day. When a group has at least one timed member, every date-only
 * member is dropped; groups with no timed member pass through untouched.
 * "Date-only" means a bare 8-digit DTSTART (hasBareDateStart), so a
 * VALUE=DATE VEVENT carrying a real clock counts as timed and is never dropped.
 * Survivors keep their original order. Returns { events, dropped }.
 */
export function collapseDateOnlyTwins(events) {
  const timedByKey = new Map()
  // Raw DTSTART slice: a UTC-suffixed value ("20261013T020000Z") keys on its
  // UTC day, which can differ from the Eastern day of a bare-date twin; the
  // district feeds emit TZID/floating values so this is left as is.
  const keyOf = (ev) => `${squashTitle(ev.SUMMARY)}|${String(ev.DTSTART?.value || '').slice(0, 8)}`
  for (const ev of events) {
    if (!hasBareDateStart(ev)) {
      const key = keyOf(ev)
      if (!timedByKey.has(key)) timedByKey.set(key, ev)
    }
  }
  const out = []
  let dropped = 0
  for (const ev of events) {
    const timed = timedByKey.get(keyOf(ev))
    if (timed && hasBareDateStart(ev)) {
      dropped++
      console.log(`  ↳ date-only twin ${ev.UID} of ${timed.UID}: "${ev.SUMMARY}"`)
      continue
    }
    out.push(ev)
  }
  return { events: out, dropped }
}

/**
 * True for a bare 8-digit DTSTART value ("20261012") — the only shape for
 * which normaliseIcsEvent synthesizes noon. Mirrors ics.js isBareIcsDate:
 * isDateOnlyIcsEvent is also true for VALUE=DATE carrying a real clock
 * ("20261012T180000"), and that time must never be overwritten.
 */
function hasBareDateStart(ev) {
  return /^\d{8}$/.test(String(ev?.DTSTART?.value || '').trim())
}

// Words that introduce a deadline, an end, or a bound rather than a start
// ("RSVP by 5 pm", "ends at 3 p.m.", "until 4 pm", "through 6 pm").
const NON_START_LEAD = /\b(?:by|until|ends?|before|through)(?:\s+at)?\s*$/i
// A range dash immediately before the token ("9-12 pm", "3pm-5pm"): the token
// after the dash is an end, not a start.
const RANGE_DASH_LEAD = /\d\s*[-\u2013]\s*$/

/**
 * Pure — exported for tests. First 12-hour clock token in the DESCRIPTION
 * ("5:30 p.m.", "7 PM", "10:00am") as a normalised string easternToIso can
 * parse ("5:30 pm"), or null when none qualifies. Hour must be 1-12, minute
 * 0-59. A token preceded by a range dash or by by/until/ends/end/before/
 * through (optionally "at") is rejected as a non-start time, and no later
 * token is considered: a description whose first clock mention is a deadline
 * or an end is not a reliable statement of the start.
 */
export function explicitTimeFromDescription(ev) {
  const text = stripHtml(ev?.DESCRIPTION || '')
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\b/i)
  if (!m) return null
  const lead = text.slice(Math.max(0, m.index - 12), m.index)
  if (RANGE_DASH_LEAD.test(lead) || NON_START_LEAD.test(lead)) return null
  const hour   = parseInt(m[1], 10)
  const minute = m[2] != null ? parseInt(m[2], 10) : 0
  if (hour < 1 || hour > 12 || minute > 59) return null
  return `${hour}:${String(minute).padStart(2, '0')} ${m[3].toLowerCase()}m`
}

/**
 * Pure — exported for tests. For a bare-date VEVENT whose DESCRIPTION states
 * a clock time, replace the noon placeholder with that time, drop the
 * synthetic end only when it would now precede the start (mirrors
 * normaliseIcsEvent), and strip DATE_ONLY_TIME_NOTE. Returns true when the
 * row was re-timed. needs_review is left to the caller's hook so the review
 * queue still audits the substituted time.
 */
export function applyExplicitTime(row, ev) {
  if (!row || !hasBareDateStart(ev)) return false
  const time = explicitTimeFromDescription(ev)
  if (!time) return false
  const v = String(ev.DTSTART.value).trim()
  const iso = easternToIso(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, time)
  if (!iso) return false
  row.start_at = iso
  if (row.end_at && Date.parse(row.end_at) <= Date.parse(iso)) row.end_at = null
  if (row.description) {
    const stripped = row.description.replace(DATE_ONLY_TIME_NOTE, '').trim()
    row.description = stripped || null
  }
  return true
}

async function main() {
  console.log('🚀  Starting Akron Public Schools scrape…')
  const start = Date.now()

  try {
    const feedUrls = resolveFeedUrls()

    // Fetch and merge every configured feed before filtering.
    const allEvents = []
    for (const url of feedUrls) {
      const icsText = await fetchIcsFeed(url)
      const events  = parseIcs(icsText)
      console.log(`  Parsed ${events.length} VEVENTs from ${url}`)
      allEvents.push(...events)
    }

    // Last resort: if the resolved feeds together produced no VEVENTs at all,
    // try discovering a feed URL from the calendar page and fetch it too.
    if (allEvents.length === 0) {
      console.log('  🔎  0 VEVENTs from resolved feeds — discovering ICS feed from district calendar page…')
      const discovered = await discoverIcsFeed(CALENDAR_PAGE)
      if (discovered && !feedUrls.includes(discovered)) {
        console.log(`  ✓ Discovered feed: ${discovered}`)
        const icsText = await fetchIcsFeed(discovered)
        const events  = parseIcs(icsText)
        console.log(`  Parsed ${events.length} VEVENTs from ${discovered}`)
        allEvents.push(...events)
      }
      if (allEvents.length === 0) {
        throw new Error(
          'No VEVENTs from resolved feeds and discovery found nothing new on the APS calendar page. ' +
          'Visit the district calendar in a browser, find the "Subscribe" or RSS/iCal link, ' +
          'and set AKRON_PUBLIC_SCHOOLS_ICS_URL in .env.'
        )
      }
    }

    const filtered = allEvents.filter(isPublicFacing)
    console.log(`  Filtered to ${filtered.length} public-facing events (dropped ${allEvents.length - filtered.length})`)
    const { events: publicEvents, dropped: twinsDropped } = collapseDateOnlyTwins(filtered)
    console.log(`  Collapsed ${twinsDropped} date-only twins of timed events`)

    if (publicEvents.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: 'error',
        errorMessage: 'Feed parsed but contained 0 public-facing events after filter',
        durationMs: Date.now() - start,
        eventsFound: allEvents.length,
      })
      process.exit(0)
    }

    const organizationId = await ensureOrganization('Akron Public Schools', {
      website:     'https://www.akronschools.com',
      description: 'Akron Public Schools is the public school district serving Akron, Ohio.',
    })

    console.log(`\n📥  Processing ${publicEvents.length} events…`)
    let inserted = 0, skipped = 0, retimed = 0
    const venueCache = new Map()

    for (const ev of publicEvents) {
      try {
        const row = normaliseIcsEvent(ev, {
          source: SOURCE_KEY,
          mapCategory,
          mapTags,
          defaultPriceMin: null,
          defaultPriceMax: null,
          ageRestriction:  'all_ages',
        })
        if (!row || !row.start_at || !row.source_id) { skipped++; continue }
        // Date-only VEVENT: honour a time stated in the description. Either
        // way the row is flagged for review, exactly as runIcsScraper feeds
        // do: noon is invented, and a description-derived time is inferred.
        if (applyExplicitTime(row, ev)) retimed++
        applyNeedsReviewHook(row, ev, isDateOnlyIcsEvent)

        const locName = (ev.LOCATION || '').trim()
        let venueId = null
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
        if (error) { console.warn(`  ⚠ Upsert failed: ${error.message}`); skipped++; continue }

        if (venueId)        await linkEventVenue(upserted.id, venueId)
        if (organizationId) await linkEventOrganization(upserted.id, organizationId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${ev.SUMMARY}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: allEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`  Date-only twins dropped: ${twinsDropped}; date-only rows re-timed from description: ${retimed}`)
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-akron-public-schools.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
