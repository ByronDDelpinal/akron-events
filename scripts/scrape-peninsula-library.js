/**
 * scrape-peninsula-library.js
 *
 * Peninsula Library & Historical Society public program calendar.
 *
 * Platform: WordPress running the "All-in-One Event Calendar" (Timely / ai1ec)
 * plugin. There is NO working machine feed — the Tribe REST route 404s, the
 * ai1ec iCal exporter is disabled (returns the page shell), and detail pages
 * carry no JSON-LD. The one clean, complete source of per-occurrence data is
 * the server-rendered AGENDA view:
 *
 *   /calendar/action~agenda/page_offset~N/request_format~html/
 *
 * Each agenda page renders ~10 upcoming event instances starting from "today".
 * We walk pages 0,1,2,… until a page returns zero events. Each event block
 * gives us: event id + instance id (stable per occurrence), the title, a
 * human-readable time range, a `data-end` ISO datetime WITH offset, category
 * chips (Adult Events / Children's Events), an inline description, image, and a
 * detail-page link. Recurring series (book clubs) render one block per
 * occurrence, each with its own instance id — so recurrence needs no special
 * expansion.
 *
 * Date/time quirk: the agenda exposes `data-end` as a full ISO datetime but NOT
 * a `data-start`. The START clock only appears in the human time text
 * ("Jul 21 @ 10:30 am – 11:30 am"). Every timed program at this library is
 * single-day, so we take the local date from `data-end` and pair it with the
 * start clock parsed from that text. All-day entries are, at this source,
 * exclusively "Library Closed" holiday blocks — they carry no start clock and
 * are skipped alongside internal "Friends of the Library" meetings.
 *
 * Server quirk: the host intermittently answers with "507 Insufficient Storage"
 * under load, so every fetch retries with backoff.
 *
 * Fixed venue: Peninsula Library & Historical Society, 6105 Riverview Rd,
 * Peninsula OH 44264 — squarely inside Summit County, so every event publishes
 * (no geo classification needed).
 *
 * Usage:
 *   node scripts/scrape-peninsula-library.js
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
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'

const SOURCE = 'peninsula_library'
const AGENDA_URL = (offset) =>
  `https://peninsulalibrary.org/calendar/action~agenda/page_offset~${offset}/request_format~html/`
const MAX_PAGES = 12 // safety cap; real data ends well before this
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

// ── Fixed venue / organizer ───────────────────────────────────────────────
const VENUE = {
  name: 'Peninsula Library & Historical Society',
  address: '6105 Riverview Rd',
  city: 'Peninsula',
  state: 'OH',
  zip: '44264',
  lat: 41.2434,
  lng: -81.5514,
  website: 'https://peninsulalibrary.org',
  description:
    'A small community library and local-history society in the village of Peninsula, in the Cuyahoga Valley.',
}

// ── Filtering ──────────────────────────────────────────────────────────────
// The agenda mixes real public programs with two kinds of non-events:
//   • "Library Closed …" — all-day holiday closure blocks
//   • "Friends of the Library Meetings" — internal support-group meetings
// Both are skipped. All-day entries are, in practice, always closures.
const SKIP_TITLE_PATTERNS = [
  /library\s+closed/i,
  /\bfriends of the library\b.*\bmeeting/i,
  /\bboard meeting\b/i,
  /\bstaff meeting\b/i,
]

export function shouldSkipTitle(title = '') {
  return SKIP_TITLE_PATTERNS.some((re) => re.test(title))
}

// ── Category mapping ───────────────────────────────────────────────────────
// Library programming is overwhelmingly educational/cultural, so 'learning' is
// the fallback. Specific keywords promote the clearly non-learning cases
// (author concerts, film nights, craft workshops). First match wins.
const CATEGORY_KEYWORDS = [
  [/\b(concert|live music|recital|singer|choir)\b/i, 'music'],
  [/\b(film|movie|cinema|screening)\b/i, 'film'],
  [/\b(craft|crafts|knit|paint|painting|drawing|quilt|collage)\b/i, 'visual-art'],
  [/\b(talent show|talent|open mic|theater|theatre|puppet)\b/i, 'theater'],
  [/\b(yoga|tai chi|fitness|exercise|zumba)\b/i, 'fitness'],
  [/\b(cooking|bake|baking|recipe|tasting)\b/i, 'food'],
  [/\b(book club|author|reading|writing|history|lecture|talk|presentation|genealogy|social security|finance|financial|workshop|storytime|story time)\b/i, 'learning'],
]

export function resolveCategory(title = '', description = '') {
  const hay = `${title} ${description}`
  for (const [re, cat] of CATEGORY_KEYWORDS) {
    if (re.test(hay)) return cat
  }
  return 'learning'
}

// ── Audience / tags ────────────────────────────────────────────────────────
// The ai1ec "Children's Events" category is the authoritative kid signal.
// Returns true or undefined (never false) so text inference can still catch a
// family program the category chip misses.
export function isFamilyEvent(categoryLabels = [], title = '') {
  const labels = categoryLabels.map((l) => l.toLowerCase())
  if (labels.some((l) => l.includes('child') || l.includes('kids') || l.includes('teen') || l.includes('youth') || l.includes('family'))) {
    return true
  }
  if (/\b(kids?|child(ren)?|family|families|storytime|story time|teens?)\b/i.test(title)) return true
  return undefined
}

export function buildTags(categoryLabels = []) {
  const tags = ['library']
  for (const l of categoryLabels) {
    const low = l.toLowerCase()
    if (low.includes('child')) tags.push('kids')
    if (low.includes('adult')) tags.push('adults')
    if (low.includes('teen')) tags.push('teens')
  }
  return [...new Set(tags)]
}

// ── Date / time ────────────────────────────────────────────────────────────

/**
 * Derive start_at / end_at (both UTC ISO) from an agenda block's `data-end`
 * ISO string plus the human time text. Returns null when the event has no
 * parseable start clock (all-day closures), so the caller can skip it rather
 * than silently landing on midnight.
 *
 * `dataEnd` is a full offset-aware ISO ("2026-07-21T11:30:00-04:00"); its
 * date portion is the event's local (Eastern) date. `timeText` looks like
 * "Jul 21 @ 10:30 am – 11:30 am" — we take the clock before the en dash.
 */
export function parseEventDateTime(dataEnd, timeText = '') {
  if (!dataEnd) return null
  const endDate = new Date(dataEnd)
  if (Number.isNaN(endDate.getTime())) return null

  // Local Eastern date from the offset-aware end timestamp.
  const localDate = String(dataEnd).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return null

  // Start clock: the "H[:MM] am/pm" token before the range separator. ai1ec
  // renders minutes only when the WordPress time format includes them, so
  // on-the-hour programs can appear as "6 pm" / "10 am" with no ":MM" — the
  // minutes group is optional or such events would be silently skipped.
  const startPart = String(timeText).split(/[–—-]/)[0]
  const clock = startPart.match(/(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i)
  if (!clock) return null // all-day / no time → skip

  const start_at = easternToIso(localDate, clock[1])
  if (!start_at) return null
  const end_at = endDate.toISOString()
  return { start_at, end_at: end_at > start_at ? end_at : null }
}

// ── Agenda HTML parsing ────────────────────────────────────────────────────

/** Decode the entity-escaped hrefs ai1ec emits (&#x2F; etc.). */
function decodeUrl(s = '') {
  return s
    .replace(/&#x3A;/g, ':')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x3D;/g, '=')
    .replace(/&#x3F;/g, '?')
    .replace(/&#x7E;/g, '~')
    .replace(/&amp;/g, '&')
}

/**
 * Parse an ai1ec agenda-view HTML page into an array of raw event records.
 * Pure — exported for tests. Returns [] when the page has no events.
 */
export function parseAgendaEvents(html = '') {
  const start = html.indexOf('ai1ec-agenda-view')
  if (start === -1) return []
  const agenda = html.slice(start)

  // Split on each event div. The class list wraps across newlines in the
  // markup, so match the id token loosely.
  const blocks = agenda.split(/(?=<div class="ai1ec-event\s+ai1ec-event-id-)/)
  const events = []

  for (const block of blocks) {
    const idMatch = block.match(/ai1ec-event-id-(\d+)/)
    const instanceMatch = block.match(/ai1ec-event-instance-id-(\d+)/)
    if (!idMatch || !instanceMatch) continue

    const endMatch = block.match(/data-end="([^"]+)"/)
    const titleMatch = block.match(/ai1ec-event-title">([\s\S]*?)<\/span>/)
    const timeMatch = block.match(/ai1ec-event-time">([\s\S]*?)<\/div>/)
    const urlMatch = block.match(/ai1ec-load-event"\s*href="([^"]+)"/)
    const imgMatch = block.match(/ai1ec-event-avatar[^>]*>\s*<img[^>]*src="([^"]+)"/)
    // Category chips: term id + swatch title label.
    const cats = [...block.matchAll(/ai1ec-category ai1ec-term-id-(\d+)[^>]*>[\s\S]*?title="([^"]*)"/g)]
    // Description: everything inside ai1ec-event-description (drop the avatar link).
    const descMatch = block.match(/ai1ec-event-description"\s*>([\s\S]*?)<div class="ai1ec-event-summary-footer"/)

    const title = titleMatch ? stripHtml(titleMatch[1]) : ''
    if (!title) continue

    let descHtml = descMatch ? descMatch[1] : ''
    // Strip the leading avatar <a>…</a> image wrapper so it isn't in the text.
    descHtml = descHtml.replace(/<a class="ai1ec-load-event"[\s\S]*?<\/a>/, '')

    events.push({
      eventId: idMatch[1],
      instanceId: instanceMatch[1],
      title,
      timeText: timeMatch ? stripHtml(timeMatch[1]) : '',
      dataEnd: endMatch ? endMatch[1] : null,
      allDay: /ai1ec-allday/.test(block),
      categoryLabels: cats.map((c) => stripHtml(c[2])),
      detailUrl: urlMatch ? decodeUrl(urlMatch[1]) : null,
      imageUrl: imgMatch ? imgMatch[1] : null,
      description: descHtml ? htmlToText(descHtml) : '',
    })
  }
  return events
}

// ── Fetch with retry (server intermittently 507s) ──────────────────────────

async function fetchWithRetry(url, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        redirect: 'follow',
      })
      if (res.ok) {
        const text = await res.text()
        if (text.length > 2000 && !text.includes('507 Insufficient Storage')) return text
      }
    } catch { /* transient — retry */ }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2500 * (i + 1)))
  }
  return null
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Peninsula Library ingestion…')
  const startMs = Date.now()

  try {
    const organizerId = await ensureOrganization(VENUE.name, {
      website: VENUE.website,
      description: VENUE.description,
    })
    const venueId = await ensureVenue(VENUE.name, {
      address: VENUE.address,
      city: VENUE.city,
      state: VENUE.state,
      zip: VENUE.zip,
      lat: VENUE.lat,
      lng: VENUE.lng,
      website: VENUE.website,
      description: VENUE.description,
    })
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    // Collect events across agenda pages until an empty page.
    const seen = new Set()
    const rawEvents = []
    for (let offset = 0; offset < MAX_PAGES; offset++) {
      const html = await fetchWithRetry(AGENDA_URL(offset))
      if (!html) {
        console.warn(`  ⚠ page_offset ${offset} failed after retries — stopping pagination`)
        break
      }
      const pageEvents = parseAgendaEvents(html)
      console.log(`  page ${offset}: ${pageEvents.length} event block(s)`)
      if (pageEvents.length === 0) break
      for (const ev of pageEvents) {
        const key = `${ev.eventId}-${ev.instanceId}`
        if (seen.has(key)) continue
        seen.add(key)
        rawEvents.push(ev)
      }
    }

    console.log(`\n📥  Processing ${rawEvents.length} event instance(s)…`)
    let inserted = 0
    let skipped = 0

    for (const ev of rawEvents) {
      try {
        if (shouldSkipTitle(ev.title) || ev.allDay) {
          skipped++
          continue
        }

        const times = parseEventDateTime(ev.dataEnd, ev.timeText)
        if (!times) {
          console.warn(`  ⚠ no parseable time for "${ev.title}" (${ev.timeText}) — skipped`)
          skipped++
          continue
        }

        const row = {
          title: ev.title,
          description: ev.description || null,
          start_at: times.start_at,
          end_at: times.end_at,
          category: resolveCategory(ev.title, ev.description),
          is_family: isFamilyEvent(ev.categoryLabels, ev.title),
          tags: buildTags(ev.categoryLabels),
          // Prices are not stated in the source; library programs are typically
          // free but we do not assert it (per ingestion contract).
          price_min: null,
          price_max: null,
          age_restriction: 'not_specified',
          image_url: ev.imageUrl || null,
          ticket_url: ev.detailUrl,
          source: SOURCE,
          source_id: `${ev.eventId}-${ev.instanceId}`,
          status: 'published',
          featured: false,
        }

        const enriched = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enriched)
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
        } else {
          await linkEventVenue(upserted.id, venueId)
          await linkEventOrganization(upserted.id, organizerId)
          inserted++
        }
      } catch (err) {
        console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs: Date.now() - startMs,
    })
    console.log(`\n✅  Done in ${((Date.now() - startMs) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE, err, startMs)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
