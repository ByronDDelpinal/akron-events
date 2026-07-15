/**
 * scrape-west-side-gymnastics.js
 *
 * West Side Gymnastics (westsidegymnastics.net) — a children's gymnastics gym
 * at 1347 Sunset Drive, Copley, Ohio 44321 (Summit County). Public special
 * events: multi-day summer/holiday day camps, Pre-K camps, Parents' Night Out,
 * open gyms, and kids clinics.
 *
 * Platform: the public site is a Duda website whose "Calendar" page renders a
 * Duda Google-Calendar widget (data-element-type="googlecalendar"). The widget's
 * data-public-calendar-id decodes (base64) to the gym's public Google Calendar
 * address, westsideoh@gmail.com. Rather than screen-scrape the server-rendered
 * month grid (which only exposes one month at a time and carries no year on the
 * per-day payloads), we consume that calendar's public iCal feed directly:
 *   https://calendar.google.com/calendar/ical/westsideoh%40gmail.com/public/basic.ics
 * This gives every upcoming event with real UTC start/end instants, stable
 * Google UIDs, and no year-inference guesswork.
 *
 * Feed quirks:
 *   • DTSTART/DTEND are UTC ("…Z"); icsDateToIso converts them 1:1 to ISO UTC
 *     (a 9:00am EDT camp is stored 13:00Z — the frontend renders in the viewer's
 *     local zone).
 *   • The calendar mixes real events with "Gym Closed (Holiday Break)" closure
 *     markers. Closures are NOT events — isPublicSpecialEvent() drops them.
 *   • Real events carry no per-event URL and no image; we attach a canonical
 *     registration link per event type and a default gym photo.
 *   • Every public program at this gym is kid/family programming, so is_family
 *     is set true for all rows (inference alone misses "Picasso Jr Camp",
 *     "Parents' Night Out", "Open Gym").
 *
 * Geography: single fixed venue in Copley (Summit County) — no per-event geo
 * classification needed.
 *
 * Usage:   node scripts/scrape-west-side-gymnastics.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { fetchIcsFeed, parseIcs, expandRecurrence, icsDateToIso } from './lib/ics.js'
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
} from './lib/normalize.js'

export const SOURCE_KEY = 'west_side_gymnastics'

const FEED_URL =
  'https://calendar.google.com/calendar/ical/westsideoh%40gmail.com/public/basic.ics'

const SITE_BASE = 'https://www.westsidegymnastics.net'

// The feed omits images; use the gym's own hero photo as a default so events
// render with a real picture rather than a category gradient.
const DEFAULT_IMAGE =
  'https://lirp.cdn-website.com/8f1aa023/dms3rep/multi/opt/Sweet-Peas-Pit-Jump-1-1920w.jpg'

const HORIZON_DAYS = 180
const DAY_MS = 86_400_000

// ── Filtering ───────────────────────────────────────────────────────────────

/**
 * True for a public special event we should ingest; false for calendar noise.
 *
 * The gym publishes its holiday/summer closures on the same calendar as real
 * programming ("Gym Closed (Holiday Break)"). Those are operational markers,
 * not events — drop them. Everything else on this children's-gym calendar
 * (camps, Pre-K camps, Parents' Night Out, open gyms, clinics) is a genuine
 * public special event. Exported for tests.
 */
export function isPublicSpecialEvent(ev) {
  const title = stripHtml((ev?.SUMMARY ?? '').trim())
  if (!title) return false
  // Closures / cancellations — not events. The gym publishes recurring
  // "CANCELED Preschool Open Gym" markers on this calendar (verified live
  // 2026-07-15); the cancel/postpone guard mirrors the shared CivicPlus filter.
  if (/\b(gym\s+)?closed\b|\bclosure\b|\bcancel?led\b|\bpostponed\b|\bno\s+(class|classes|school)\b/i.test(title)) return false
  return true
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Map an event title to descriptive tags. Base tags reflect the venue
 * (gymnastics, kids, copley); event-type tags are added from the title.
 * Exported for tests.
 */
export function mapTags(title = '') {
  const t = title.toLowerCase()
  const tags = ['gymnastics', 'kids', 'copley']
  if (/\bcamp\b/.test(t))                 tags.push('summer-camp')
  if (/parent'?s'?\s+night\s+out/.test(t)) tags.push('parents-night-out')
  if (/\bopen\s+gym\b/.test(t))           tags.push('open-gym')
  if (/\bclinic\b/.test(t))               tags.push('clinic')
  return [...new Set(tags)]
}

/**
 * Canonical registration/info link for an event. The feed has no per-event
 * URL; camps register on /summer-camps, Parents' Night Out on /special-events,
 * and everything else points at the public calendar. Exported for tests.
 */
export function ticketUrlFor(title = '') {
  const t = title.toLowerCase()
  if (/\bcamp\b/.test(t))                 return `${SITE_BASE}/summer-camps`
  if (/parent'?s'?\s+night\s+out/.test(t)) return `${SITE_BASE}/special-events`
  return `${SITE_BASE}/calendar`
}

// ── Normalisation ───────────────────────────────────────────────────────────

/**
 * Convert a parsed VEVENT into the common event-row shape, or null if it is
 * not a public special event / lacks a title or start time. Exported for tests.
 */
export function icsEventToRow(ev) {
  if (!isPublicSpecialEvent(ev)) return null

  const title = stripHtml((ev.SUMMARY ?? '').trim())
  if (!title) return null

  const startAt = ev.DTSTART ? icsDateToIso(ev.DTSTART.value, ev.DTSTART.params) : null
  if (!startAt) return null
  const endAt = ev.DTEND ? icsDateToIso(ev.DTEND.value, ev.DTEND.params) : null

  const rawDesc = ev.DESCRIPTION ?? ''
  const description = rawDesc ? stripHtml(rawDesc).slice(0, 5000) || null : null

  return {
    title,
    description,
    start_at: startAt,
    end_at:   endAt,
    // A children's gymnastics gym: every public program is fitness + family.
    category:  'fitness',
    is_family: true,
    tags:      mapTags(title),
    price_min: null,   // feed never states a price — never assume free
    price_max: null,
    age_restriction: 'not_specified',
    image_url:  DEFAULT_IMAGE,
    ticket_url: ticketUrlFor(title),
    source:     SOURCE_KEY,
    source_id:  (ev.UID || '').trim() || null,
    status:     'published',
    featured:   false,
  }
}

// ── Process ─────────────────────────────────────────────────────────────────

async function processEvents(events, venueId, organizationId, nowMs) {
  const pastCutoff   = nowMs - 1 * DAY_MS
  const futureCutoff = nowMs + HORIZON_DAYS * DAY_MS
  let inserted = 0, skipped = 0

  for (const ev of events) {
    try {
      const row = icsEventToRow(ev)
      if (!row || !row.start_at || !row.source_id) { skipped++; continue }

      const startMs = Date.parse(row.start_at)
      if (Number.isFinite(startMs) && (startMs < pastCutoff || startMs > futureCutoff)) {
        skipped++
        continue
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
      console.warn(`  ⚠ Error processing "${ev?.SUMMARY}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting West Side Gymnastics ingestion…')
  const start = Date.now()

  try {
    const venueId = await ensureVenue('West Side Gymnastics', {
      address: '1347 Sunset Drive',
      city:    'Copley',
      state:   'OH',
      zip:     '44321',
      website: SITE_BASE,
    })

    const organizationId = await ensureOrganization('West Side Gymnastics', {
      website: SITE_BASE,
      description:
        'West Side Gymnastics is a children\'s gymnastics gym in Copley offering ' +
        'classes, camps, open gyms, and special events for kids in the Akron area.',
    })
    if (organizationId && venueId) await linkOrganizationVenue(organizationId, venueId)

    console.log(`\n🔍  Fetching ICS feed: ${FEED_URL}`)
    const icsText = await fetchIcsFeed(FEED_URL)
    const rawEvents = parseIcs(icsText)
    console.log(`  Parsed ${rawEvents.length} VEVENT blocks`)

    // Materialise any recurring masters (none today, but future-proofs a
    // weekly Open Gym / monthly Parents' Night Out entered as an RRULE).
    // Non-recurring events pass through unchanged.
    const events = rawEvents.flatMap((ev) =>
      expandRecurrence(ev, { windowDays: HORIZON_DAYS }))

    console.log(`\n📥  Processing ${events.length} events…`)
    const { inserted, skipped } = await processEvents(
      events, venueId, organizationId, Date.now(),
    )

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: events.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
