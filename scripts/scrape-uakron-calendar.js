/**
 * scrape-uakron-calendar.js
 *
 * Fetches upcoming events from the University of Akron's LiveWhale calendar API
 * and splits them into four distinct sources so each sub-calendar surfaces as
 * its own entity for filtering, display, and coverage tracking:
 *
 *   - 'ejthomas_hall'    — EJ Thomas Performing Arts Hall events
 *   - 'uakron_myers_art' — Myers School of Art (calendar.uakron.edu/art)
 *   - 'uakron_chp'       — Cummings Center for the History of Psychology
 *   - 'uakron_calendar'  — all other University of Akron events
 *
 * Matching is done on the event's LiveWhale `group_title` using substring
 * patterns — this is forgiving of capitalization / wording drift. Events
 * whose group doesn't match any specific sub-calendar fall through to
 * 'uakron_calendar' so we never drop data.
 *
 * Usage:
 *   node scripts/scrape-uakron-calendar.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue as ensureVenueGeneric,
  ensureOrganization,
} from './lib/normalize.js'

const API_URL = 'https://calendar.uakron.edu/live/json/events?days=365&user_tz=America/New_York'

// ── Sub-calendar classification ────────────────────────────────────────────
//
// Map an event's LiveWhale `group_title` to a specific source key. Each
// pattern is matched as a case-insensitive substring against the group
// field only — broader text (tags, description) is deliberately excluded
// to keep the split deterministic and fast.
//
// Order matters: the first matching entry wins, so put more-specific
// patterns ahead of broader ones.

const SUB_CALENDARS = [
  {
    source:   'ejthomas_hall',
    label:    'EJ Thomas Hall',
    patterns: [/ej thomas/i, /e\.?j\.? thomas/i, /performing arts hall/i],
  },
  {
    source:   'uakron_myers_art',
    label:    'Myers School of Art',
    patterns: [/myers school of art/i, /\bschool of art\b/i, /\bmyers\b/i],
  },
  {
    source:   'uakron_chp',
    label:    'Cummings Center',
    patterns: [/cummings center/i, /history of psychology/i, /\bchp\b/i],
  },
]
const DEFAULT_SOURCE = 'uakron_calendar'

function classifySource(groupTitle = '') {
  const g = String(groupTitle || '').trim()
  if (!g) return DEFAULT_SOURCE
  for (const sub of SUB_CALENDARS) {
    if (sub.patterns.some(re => re.test(g))) return sub.source
  }
  return DEFAULT_SOURCE
}

export { classifySource, SUB_CALENDARS, DEFAULT_SOURCE }

// ── Category mapping ───────────────────────────────────────────────────────

function parseCategory(ev) {
  const group  = (ev.group_title ?? '').toLowerCase()
  const types  = (ev.event_types ?? []).map(t => (t.name ?? '').toLowerCase())
  const tags   = ev.tags ? (Array.isArray(ev.tags) ? ev.tags.map(t => (t.name ?? '').toLowerCase()) : []) : []
  const all    = [...types, ...tags, group]
  const has = (kw) => all.some(s => s.includes(kw))
  const hasWord = (kw) => all.some(s => new RegExp(`\\b${kw}\\b`).test(s))

  // EJ Thomas Hall / School of Performing Arts host staged shows — theater,
  // not visual-art (the old v1 'art' slug conflated the two).
  if (group.includes('ej thomas') || group.includes('performing arts')) return 'theater'
  if (group.includes('music') || group.includes('school of music')) return 'music'
  if (group.includes('school of art') || group.includes('myers')) return 'visual-art'
  if (group.includes('art')) return 'visual-art'
  if (has('athletic') || hasWord('sport')) return 'sports'
  if (has('recreation')) return 'fitness'
  if (has('lecture') || has('seminar') || has('workshop') || hasWord('class')) return 'learning'
  if (has('performance') || has('recital') || has('concert')) {
    if (group.includes('music') || group.includes('school of music')) return 'music'
    return 'theater'
  }
  return 'learning' // University default: talks, info sessions, academic events
}

function parseTags(ev) {
  const group = ev.group_title?.toLowerCase()
  const tags  = ev.tags ? (Array.isArray(ev.tags) ? ev.tags.map(t => t.name?.toLowerCase()).filter(Boolean) : []) : []
  const all   = [...tags, 'university', 'uakron']
  if (group) all.push(group)
  return [...new Set(all)]
}

function parsePrice(costStr) {
  // LiveWhale's JSON API v2 serialises the `cost` field as whatever type
  // matches the admin's entry — string, number, or array (multiple tiers).
  // See: docs.livewhale.com — "response values will be formatted as various
  // types based on the field". Incident: 2026-04-17, "Dr. Frank L. Simonetti
  // Awards Ceremony" returned a non-string and crashed on .trim().
  if (costStr == null || costStr === '' || costStr === false) return 0

  if (typeof costStr === 'number') {
    return Number.isFinite(costStr) && costStr >= 0 ? costStr : 0
  }

  if (Array.isArray(costStr)) {
    // Tiered pricing (e.g. [35, 60] for alumni/non-alumni). Use the min.
    const nums = costStr
      .map(v => typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.]/g, '')))
      .filter(n => Number.isFinite(n) && n >= 0)
    return nums.length ? Math.min(...nums) : 0
  }

  if (typeof costStr !== 'string') return 0  // objects, booleans → treat as unknown

  const s = costStr.trim().toLowerCase()
  if (!s || s === 'free' || s === 'no charge') return 0
  const m = s.match(/\d+(\.\d+)?/)
  return m ? parseFloat(m[0]) : 0
}

// ── Venue cache ────────────────────────────────────────────────────────────

const venueCache = new Map()

const KNOWN_VENUES = {
  'E.J. Thomas Performing Arts Hall': {
    address: '198 Hill St', city: 'Akron', state: 'OH', zip: '44325', lat: 41.0756, lng: -81.5113,
    website: 'https://www.ejthomashall.com', parking_type: 'garage',
    parking_notes: 'Parking garages available on campus.',
  },
  'University of Akron': {
    address: '302 Buchtel Common', city: 'Akron', state: 'OH', zip: '44325', lat: 41.0756, lng: -81.5106,
    website: 'https://www.uakron.edu', parking_type: 'garage',
    parking_notes: 'Parking garages available on campus.',
  },
}

async function ensureVenue(locationTitle, lat, lng) {
  const name = locationTitle ?? 'University of Akron'
  if (venueCache.has(name)) return venueCache.get(name)

  const known = KNOWN_VENUES[name]

  let venueId
  if (known) {
    // Known campus venue — use its specific details
    venueId = await ensureVenueGeneric(name, {
      ...known,
      lat: lat ? parseFloat(lat) : known.lat,
      lng: lng ? parseFloat(lng) : known.lng,
    })
  } else {
    // Off-campus / external venue — only pass coords if available
    venueId = await ensureVenueGeneric(name, {
      city:  'Akron',
      state: 'OH',
      lat:   lat ? parseFloat(lat) : null,
      lng:   lng ? parseFloat(lng) : null,
    })
  }

  venueCache.set(name, venueId)
  return venueId
}

async function ensureUakronOrganizer() {
  return ensureOrganization('University of Akron', {
    website:     'https://www.uakron.edu',
    description: 'The University of Akron is a public research university in Akron, Ohio, offering diverse academic programs, performing arts events, and community programming.',
  })
}

// ── Fetch ──────────────────────────────────────────────────────────────────

/**
 * Fetch an event detail page and pull the description out of its
 * Schema.org Event JSON-LD. LiveWhale-rendered pages reliably include
 * `@type: "Event"` with a populated `description`, so this works for
 * essentially every UA event.
 *
 * Returns the trimmed description text, or null on any failure /
 * missing field — callers fall back to the empty source field.
 */
async function fetchEventDescription(href) {
  if (!href) return null
  try {
    const res = await fetch(href, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)' },
      redirect: 'follow',
    })
    if (!res.ok) return null
    const html = await res.text()
    const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    let m
    while ((m = scriptRe.exec(html)) !== null) {
      try {
        const parsed = JSON.parse(m[1].trim())
        const schemas = Array.isArray(parsed) ? parsed : [parsed]
        for (const s of schemas) {
          const entries = Array.isArray(s) ? s : [s]
          for (const e of entries) {
            if (e && e['@type'] === 'Event' && typeof e.description === 'string' && e.description.trim()) {
              return stripHtml(e.description).trim()
            }
          }
        }
      } catch { /* invalid JSON, skip */ }
    }
    return null
  } catch {
    return null
  }
}

async function fetchEvents() {
  console.log('\n🔍  Fetching University of Akron events via LiveWhale API…')

  const res = await fetch(API_URL, {
    headers: {
      Accept:       'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
    },
  })

  if (!res.ok) throw new Error(`UAkron LiveWhale API error ${res.status}: ${await res.text()}`)

  const data = await res.json()
  const events = Array.isArray(data) ? data : (data.events ?? [])
  console.log(`  Received ${events.length} events`)
  return events
}

// ── Process ────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  // One result bucket per source key — includes the default + each sub-calendar
  const resultsBySource = {
    [DEFAULT_SOURCE]: { inserted: 0, skipped: 0, total: 0 },
  }
  for (const sub of SUB_CALENDARS) resultsBySource[sub.source] = { inserted: 0, skipped: 0, total: 0 }

  for (const ev of rawEvents) {
    if (!ev.title || !ev.date_iso) continue

    const source  = classifySource(ev.group_title)
    const results = resultsBySource[source]
    results.total++

    try {
      // Use date_iso (already has timezone offset) — parse to UTC
      const startAt = ev.date_iso  ? new Date(ev.date_iso).toISOString()  : null
      const endAt   = ev.date2_iso ? new Date(ev.date2_iso).toISOString() : null

      if (!startAt) { results.skipped++; continue }

      const venueId = await ensureVenue(ev.location_title, ev.location_latitude, ev.location_longitude)
      const category = parseCategory(ev)
      const tags     = parseTags(ev)
      const price_min = parsePrice(ev.cost)
      let descText  = stripHtml(ev.description ?? '')
      // LiveWhale's `description` field is often empty even when the
      // event has a fully-written body on the detail page. Fall back to
      // the canonical Schema.org Event description embedded on the page
      // we already have a URL for — keeps the event detail surface from
      // rendering "No description available." for events whose source
      // clearly has copy.
      if (!descText && ev.url) {
        descText = await fetchEventDescription(ev.url) ?? ''
      }
      const imageUrl  = ev.thumbnail ?? null

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        startAt,
        end_at:          endAt,
        category,
        tags,
        price_min,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ev.url ?? null,
        source,
        source_id:       String(ev.id),
        status:          'published',
        featured:        false,
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}" [${source}]:`, error.message)
        results.skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        results.inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
      results.skipped++
    }
  }

  return resultsBySource
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting University of Akron calendar ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureUakronOrganizer()
    const rawEvents   = await fetchEvents()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    const resultsBySource = await processEvents(rawEvents, organizerId)
    const durationMs = Date.now() - start

    // Log one scraper_runs row per source — even zero-event sub-calendars get
    // a row so scraper-health can tell the difference between "ran but empty"
    // and "never ran".
    for (const [source, r] of Object.entries(resultsBySource)) {
      await logUpsertResult(source, r.inserted, 0, r.skipped, {
        eventsFound: r.total,
        durationMs,
      })
    }

    console.log(`\n✅  Done in ${(durationMs / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('uakron_calendar', err, start)
    process.exit(1)
  }
}

// Only run when invoked directly — allows tests to import `classifySource`
// without triggering a scrape.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
