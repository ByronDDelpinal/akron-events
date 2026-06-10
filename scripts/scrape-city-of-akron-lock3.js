/**
 * scrape-city-of-akron-lock3.js
 *
 * Ingests City of Akron events from the Revize Calendar JSON feed.
 * The feed exposes events across 7 city-managed calendars; we pull from the
 * four that publish public-facing event-shaped content:
 *
 *   1  = Events
 *   5  = Parks & Rec
 *   6  = Lock 3
 *   13 = Great Streets Akron
 *
 * Calendars 2 (Meetings), 7 (Citizens Police Oversight Board), and 9 (HR)
 * are city-government calendars and explicitly excluded.
 *
 * Endpoint:
 *   https://www.akronohio.gov/_assets_/plugins/revizeCalendar/calendar_data_handler.php
 *     ?webspace=akronoh&relative_revize_url=//cms2.revize.com&protocol=https:
 *
 * Wire format:
 *   The endpoint returns a JSON array of events.  Each event has:
 *     title, start, end, desc, url, location, image, rid, id,
 *     calendar_displays[], color, duration, options, [rrule]
 *   `start` / `end` are ISO-shaped local-Eastern strings WITHOUT a "Z"
 *   suffix (e.g. "2026-07-04T18:00:00").  We convert via easternToIso so
 *   storage is correct under both EST and EDT.
 *   `desc` and `image` are URL-encoded HTML fragments — decode + sanitise.
 *
 * Recurring events:
 *   The feed represents a recurring event as a single row with an iCal-style
 *   `rrule` field (DTSTART / RRULE / EXDATE block).  We ingest the next
 *   occurrence as one row and store the recurrence as a tag so the UI can
 *   surface it.  Full occurrence expansion is a future enhancement — see
 *   the lib/ics.js parser for a model implementation.
 *
 * Historical note (not load-bearing on the code):
 *   The feed went dormant ~July 2024 and stayed empty until May 2026, during
 *   which we shipped a Claude-extracted backup path.  When the feed came
 *   back online (with ~54 events in a 30-day window) the LLM fallback was
 *   retired; restore it from `lib/llm-extract.js` in git history if the feed
 *   ever goes dormant again.
 *
 * Usage:
 *   node scripts/scrape-city-of-akron-lock3.js
 *   node scripts/scrape-city-of-akron-lock3.js --dry-run     # fetch + parse only
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — Supabase service role key
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

const SOURCE_KEY = 'city_of_akron_lock3'
const DRY_RUN    = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

const FEED_URL =
  'https://www.akronohio.gov/_assets_/plugins/revizeCalendar/calendar_data_handler.php' +
  '?webspace=akronoh&relative_revize_url=//cms2.revize.com&protocol=https:'

// Calendar IDs we ingest.  Names mirror the city's `calendarProps` map.
const CALENDAR_NAMES = {
  '1':  'Events',
  '5':  'Parks & Rec',
  '6':  'Lock 3',
  '13': 'Great Streets Akron',
}
const ALLOWED_CALENDARS = new Set(Object.keys(CALENDAR_NAMES))

// Per-calendar default venue when an event's `location` field is empty.
const DEFAULT_VENUE_BY_CAL = {
  '1':  { name: 'City of Akron',         address: '166 S High St', lat: 41.0807, lng: -81.5181 },
  '5':  { name: 'City of Akron Parks',   address: null,            lat: null,    lng: null    },
  '6':  { name: 'Lock 3',                address: '200 S Main St', lat: 41.0795, lng: -81.5170 },
  '13': { name: 'Downtown Akron',        address: null,            lat: 41.0814, lng: -81.5190 },
}

// Per-calendar canonical landing page on akronohio.gov, used as a
// source_url fallback when the Revize feed doesn't supply an event-
// specific URL.  The city's calendar page is JS-rendered with no
// per-event detail route, so the best we can do is point users at the
// relevant department/calendar landing page — better than no link at
// all, which would leave the event detail page with zero outbound CTAs.
const CALENDAR_LANDING_URL_BY_CAL = {
  '1':  'https://www.akronohio.gov/calendar.php',
  '5':  'https://www.akronohio.gov/departments/recreation_and_parks/events.php',
  '6':  'https://www.akronohio.gov/departments/lock_3/calendar.php',
  '13': 'https://www.akronohio.gov/calendar.php',
}

// Per-calendar category fallback when text-based inferCategory returns 'other'.
//
// Why this exists:  the city's titles use band-lineup shorthand like
// "Nikki D & Sisters of Thunder w Jul Big Green" — no "concert" / "band" /
// "live music" keyword for inferCategory to latch onto, so every Lock 4 Blues
// night would otherwise be filed under 'other'.  We already know from the
// calendar ID that calendar 6 (Lock 3) is the concerts/music programming
// calendar; using that knowledge as a defaulting hint avoids polluting the
// project-wide inferCategory with source-specific patterns.
//
// Calendar 1 (Events) is intentionally NOT in this map — it spans community,
// holiday, civic, and miscellaneous content, so 'other' is a more honest
// answer than a guess.
const CATEGORY_FALLBACK_BY_CAL = {
  '5':  'community',  // Parks & Rec — community / nature programming
  '6':  'music',      // Lock 3 — concerts / Lock 4 Blues / Gospel Sundays
  '13': 'community',  // Great Streets Akron — neighborhood / street fests
}

// 1 day of grace so same-day events stay visible until midnight ET.
const PAST_GRACE_MS = 86_400_000

// 180-day forward horizon — matches the project's other ingestion windows
// (Ticketmaster, Akron Life, Summit Metro Parks).  The feed will happily
// hand us events 6+ months out (e.g. the city publishes the Holiday Parade
// in early summer); we hold those back so today's surface is consistent
// across sources.
const HORIZON_DAYS = 180

// ── HTTP ───────────────────────────────────────────────────────────────────

async function fetchFeed() {
  const res = await fetch(FEED_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0)',
      'Accept':     'application/json',
    },
  })
  if (!res.ok) throw new Error(`Revize feed HTTP ${res.status}`)
  const json = await res.json()
  if (!Array.isArray(json)) {
    // Some Revize installs wrap responses; be defensive.
    if (Array.isArray(json?.events)) return json.events
    throw new Error(`Unexpected feed shape: top-level=${typeof json}`)
  }
  return json
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert a Revize start/end value into a UTC ISO string.
 * Feed values look like "2026-07-04T18:00:00" — local Eastern, no zone.
 * easternToIso expects "YYYY-MM-DD HH:MM:SS", so we swap the T separator.
 */
function revizeIsoToUtc(raw) {
  if (!raw) return null
  const cleaned = String(raw).trim()
  // Drop any stray "Z" — we know the field is local Eastern, never UTC.
  const local = cleaned.replace(/Z$/, '').replace('T', ' ').slice(0, 19)
  return easternToIso(local)
}

/**
 * Decode `desc` and convert to readable plain text.
 * Feed encodes the HTML body with encodeURIComponent before serialising;
 * undo that, then strip tags but keep paragraph structure.
 */
function decodeDescription(rawDesc) {
  if (!rawDesc || typeof rawDesc !== 'string') return null
  let html
  try {
    html = decodeURIComponent(rawDesc)
  } catch {
    html = rawDesc
  }
  const text = htmlToText(html).trim()
  return text.length ? text : null
}

/**
 * Extract a usable image URL from the feed's `image` field.
 * The field is markup like `<img src="..." alt="..."/>`. We pull the src
 * and drop placeholder/noimage assets so the row stores `null` rather than
 * a phantom thumbnail.
 */
function extractImageUrl(rawImage) {
  if (!rawImage || typeof rawImage !== 'string') return null
  let html
  try {
    html = decodeURIComponent(rawImage)
  } catch {
    html = rawImage
  }
  const m = html.match(/<img[^>]*src="([^"]+)"/i)
  if (!m) return null
  const src = m[1]
  if (/placeholder\.png|noimage\.gif|noimage\.png/i.test(src)) return null
  // Resolve protocol-relative or root-relative URLs back to akronohio.gov.
  if (/^https?:/i.test(src))   return src
  if (/^\/\//.test(src))       return 'https:' + src
  if (src.startsWith('/'))     return 'https://www.akronohio.gov' + src
  return null
}

function buildTags(ev, calendarName) {
  const tags = ['akron']
  if (calendarName) tags.push(calendarName.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
  if (ev.rrule)     tags.push('recurring')
  return [...new Set(tags)]
}

// ── Venue / organizer ──────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureLockVenue(ev, primaryCalId, organizerId) {
  const explicit = (ev.location || '').trim()
  const key      = explicit || `default:${primaryCalId}`

  if (venueCache.has(key)) return venueCache.get(key)

  let venueId
  if (explicit) {
    venueId = await ensureVenue(explicit, {
      city:    'Akron',
      state:   'OH',
      website: 'https://www.akronohio.gov',
    })
  } else {
    const def = DEFAULT_VENUE_BY_CAL[primaryCalId] || DEFAULT_VENUE_BY_CAL['1']
    venueId = await ensureVenue(def.name, {
      address: def.address || undefined,
      city:    'Akron',
      state:   'OH',
      lat:     def.lat,
      lng:     def.lng,
      website: 'https://www.akronohio.gov',
    })
  }

  if (venueId && organizerId) {
    await linkOrganizationVenue(organizerId, venueId)
  }
  venueCache.set(key, venueId)
  return venueId
}

async function ensureCityOrg() {
  return ensureOrganization('City of Akron', {
    website:     'https://www.akronohio.gov',
    description: 'The City of Akron, Ohio. Operates Lock 3, Lock 4, Recreation & Parks programming, and downtown community events.',
  })
}

// ── Filter + transform ────────────────────────────────────────────────────

function isIngestable(ev) {
  if (!ev || typeof ev !== 'object') return false
  if (!ev.title || !ev.start)        return false
  const cals = ev.calendar_displays || []
  if (!cals.some(id => ALLOWED_CALENDARS.has(String(id)))) return false

  // Time-window guard. We trust the feed's start string interpreted as
  // Eastern local — `revizeIsoToUtc` converts it for the comparison.
  const startUtc = revizeIsoToUtc(ev.start)
  if (!startUtc) return false
  const endUtc   = revizeIsoToUtc(ev.end) || startUtc

  const now      = Date.now()
  const startMs  = new Date(startUtc).getTime()
  const endMs    = new Date(endUtc).getTime()
  if (endMs   < now - PAST_GRACE_MS)              return false   // already over
  if (startMs > now + HORIZON_DAYS * 86_400_000)  return false   // beyond horizon

  return true
}

function transform(ev) {
  // Pick the first allowed calendar as the primary; rrule already lives on
  // the event so we don't need to derive it here.
  const primaryCalId = (ev.calendar_displays || [])
    .map(String)
    .find(id => ALLOWED_CALENDARS.has(id)) || '1'
  const calendarName = CALENDAR_NAMES[primaryCalId]

  const title = stripHtml(ev.title || '').trim()
  const description = decodeDescription(ev.desc)
  const start_at = revizeIsoToUtc(ev.start)
  const end_at   = revizeIsoToUtc(ev.end)

  let category = inferCategory(title, description || '')
  if (category === 'other' && CATEGORY_FALLBACK_BY_CAL[primaryCalId]) {
    category = CATEGORY_FALLBACK_BY_CAL[primaryCalId]
  }

  const evUrl = (ev.url && ev.url.startsWith('http')) ? ev.url : null
  // source_url falls back to the calendar's landing page when the feed
  // doesn't include an event-specific link; ticket_url stays strict
  // (only set when the feed advertises a real outbound URL) so the
  // frontend's "Get Tickets" CTA never points users at a generic page.
  const sourceUrl = evUrl ?? CALENDAR_LANDING_URL_BY_CAL[primaryCalId] ?? 'https://www.akronohio.gov/calendar.php'

  return {
    primaryCalId,
    row: {
      title,
      description,
      start_at,
      end_at,
      category,
      tags:            buildTags(ev, calendarName),
      price_min:       null,
      price_max:       null,
      age_restriction: 'all_ages',
      image_url:       extractImageUrl(ev.image),
      ticket_url:      evUrl,
      source_url:      sourceUrl,
      source:          SOURCE_KEY,
      source_id:       `revize_${ev.rid || ev.id}`,
      status:          'published',
      featured:        false,
    },
  }
}

// ── Upsert pipeline ───────────────────────────────────────────────────────

async function processEvents(transformed, organizerId) {
  let inserted = 0, skipped = 0

  for (const { row, primaryCalId, raw } of transformed) {
    try {
      const venueId = await ensureLockVenue(raw, primaryCalId, organizerId)

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${row.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting City of Akron (Lock 3) ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    // Only create the organization when we're actually going to write.
    const organizerId = DRY_RUN ? null : await ensureCityOrg()

    console.log(`\n🔍  Fetching Revize Calendar feed…`)
    const all = await fetchFeed()
    console.log(`  Feed returned ${all.length} total event(s) across all city calendars.`)

    const ingestable = all.filter(isIngestable)
    console.log(`  ${ingestable.length} ingestable (calendars ${[...ALLOWED_CALENDARS].join(',')}, future-dated).`)

    const transformed = ingestable.map(ev => ({ ...transform(ev), raw: ev }))

    // Within-run dedup on source_id (defensive; the feed should already be unique).
    const seen = new Set()
    const unique = transformed.filter(t => {
      if (seen.has(t.row.source_id)) return false
      seen.add(t.row.source_id)
      return true
    })

    if (DRY_RUN) {
      console.log(`\n🧪  Dry-run: ${unique.length} event(s) prepared — would insert/update; nothing written.`)

      // Per-calendar breakdown so the caller can decide whether to narrow the
      // ingest scope (e.g. drop Parks & Rec if Summit Metro Parks already
      // covers the overlap).
      if (unique.length > 0) {
        const byCal = {}
        const byCategory = {}
        for (const { row, primaryCalId } of unique) {
          const name = CALENDAR_NAMES[primaryCalId] || `cal ${primaryCalId}`
          byCal[name]      = (byCal[name]      ?? 0) + 1
          byCategory[row.category] = (byCategory[row.category] ?? 0) + 1
        }
        console.log('   By calendar:')
        for (const [name, n] of Object.entries(byCal).sort((a, b) => b[1] - a[1])) {
          console.log(`     ${String(n).padStart(3)}  ${name}`)
        }
        console.log('   By category:')
        for (const [cat, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
          console.log(`     ${String(n).padStart(3)}  ${cat}`)
        }
        console.log('   Sample (first 3):')
        for (const { row } of unique.slice(0, 3)) {
          console.log(`     • ${row.title}  [${row.start_at}]  cat=${row.category}`)
        }
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      return
    }

    console.log(`\n📥  Processing ${unique.length} event(s)…`)
    const { inserted, skipped } = await processEvents(unique, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: unique.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-city-of-akron-lock3.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
