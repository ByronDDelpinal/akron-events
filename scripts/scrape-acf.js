/**
 * scrape-acf.js
 *
 * Akron Community Foundation — "Upcoming Events" page.
 *   https://www.akroncf.org/news-and-events/acf-events/
 *
 * ACF is Greater Akron's community foundation. As of July 2026 the site
 * migrated off the old acf-custom-theme server-side event markup
 * (h2.event-title / .event-start-date) to the "Blocks for Eventbrite"
 * WordPress plugin. Event cards are rendered CLIENT-SIDE, but the full
 * Eventbrite API v3 payload is embedded in the page source as an inline
 * script assignment:
 *
 *   blocksForEventbrite = {"events":[{ id, name:{text}, summary,
 *     description:{text}, url, start:{local,utc,timezone}, end:{…},
 *     is_free, logo:{original:{url}}, venue:{name, address:{…}} }, …]}
 *
 * There may be multiple assignments on the page (an empty placeholder plus
 * the real one), so we scan all of them and merge their events arrays.
 * The legacy DOM parser is kept as a fallback in case the theme reverts.
 *
 * Events: annual meetings, fund anniversary celebrations, the Polsky Award,
 * the ACF Annual Meeting, and affiliate-fund gatherings (Bath, Black Giving
 * Collective, Gay Community Endowment, Women's Endowment, etc.). Most carry an
 * Eventbrite registration link. Organizer is attributed to Akron Community
 * Foundation; the specific fund (when present) is carried as a tag.
 *
 * Usage:   node scripts/scrape-acf.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { pathToFileURL } from 'node:url'
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
  easternTodayIso,
} from './lib/normalize.js'

const SOURCE_KEY = 'akron_community_foundation'
const EVENTS_URL = 'https://www.akroncf.org/news-and-events/acf-events/'

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}

// ── Field helpers ────────────────────────────────────────────────────────────

/** "June 5, 2026" → "2026-06-05" (null if unparseable). */
function parseDate(raw) {
  if (!raw) return null
  const m = stripHtml(raw).match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/)
  if (!m) return null
  const month = MONTH_MAP[m[1].toLowerCase()]
  if (!month) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`
}

/** "6:00 pm" / "8:30 am" → "HH:MM:00". Empty → "00:00:00" (all-day). */
function parseTime(raw) {
  if (!raw) return '00:00:00'
  const m = stripHtml(raw).match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i)
  if (!m) return '00:00:00'
  let hr = parseInt(m[1], 10)
  const min = m[2] ?? '00'
  const isPm = /p/i.test(m[3])
  if (isPm && hr !== 12) hr += 12
  if (!isPm && hr === 12) hr = 0
  return `${String(hr).padStart(2, '0')}:${min}:00`
}

function firstMatch(html, re) {
  const m = html.match(re)
  return m ? m[1] : null
}

/**
 * ACF events split into two shapes: convenings (meetings, info sessions,
 * partner breakfasts -> civic) and benefit-style celebrations (galas,
 * receptions, award nights -> inference picks content; the is_fundraiser
 * facet carries the give-back signal). The old map returned v1 'nonprofit'
 * for everything, which left 100% of ACF events in the Other bucket.
 */
function parseCategory(title = '', desc = '') {
  const t = `${title} ${desc}`.toLowerCase()
  if (/meeting|session|partner|breakfast|luncheon/.test(t)) return 'civic'
  return null // celebrations/galas — let inference pick the content category
}

/** A community foundation's public events are fundraiser-adjacent by design. */
function parseIsFundraiser(title = '', desc = '') {
  const t = `${title} ${desc}`.toLowerCase()
  return /celebration|anniversary|gala|reception|awards?\b|polsky|fundrais|benefit|giving/.test(t) || undefined
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

// ── Inline Eventbrite JSON extraction ────────────────────────────────────────

/**
 * Balanced-brace scan: return the JSON object literal starting at `start`
 * (which must point at '{'), string- and escape-aware. Null if unterminated.
 */
function scanJsonObject(str, start) {
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < str.length; i++) {
    const c = str[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return str.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Find every `blocksForEventbrite = {…}` assignment in the page and merge
 * their `events` arrays (the plugin emits an empty placeholder assignment
 * before the populated one). Returns [] if none parse.
 */
export function extractEventbriteEvents(html) {
  const events = []
  const seen = new Set()
  let idx = 0
  while ((idx = html.indexOf('blocksForEventbrite', idx)) !== -1) {
    idx += 'blocksForEventbrite'.length
    const eq = html.slice(idx, idx + 10).indexOf('=')
    if (eq === -1) continue
    const braceStart = html.indexOf('{', idx + eq)
    if (braceStart === -1) continue
    const raw = scanJsonObject(html, braceStart)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      for (const ev of parsed.events || []) {
        const key = ev.id || ev.url
        if (key && seen.has(key)) continue
        if (key) seen.add(key)
        events.push(ev)
      }
    } catch { /* not the assignment we want — keep scanning */ }
  }
  return events
}

/** Map one Eventbrite API v3 event object to the internal parsed shape. */
function mapEventbriteEvent(ev) {
  const title = ev.name?.text?.trim()
  const local = ev.start?.local // "2026-07-14T17:30:00"
  if (!title || !local) return null
  return {
    title,
    dateStr:   local.slice(0, 10),
    timeStr:   local.length >= 19 ? local.slice(11, 19) : '00:00:00',
    endLocal:  ev.end?.local || null,
    venueName: ev.venue?.name?.trim() || null,
    fund:      null, // fund affiliation isn't carried in the Eventbrite payload
    ticketUrl: ev.url || null,
    description: (ev.description?.text || ev.summary || '').trim().slice(0, 5000) || null,
    imageUrl:  ev.logo?.original?.url || ev.logo?.url || null,
    isFree:    ev.is_free === true,
    sourceId:  ev.id ? String(ev.id) : slugify(`${ev.name?.text}-${local.slice(0, 10)}`),
  }
}

// ── Parse the events page ────────────────────────────────────────────────────

export function parseEvents(html) {
  // Primary path: inline Blocks-for-Eventbrite JSON.
  const ebEvents = extractEventbriteEvents(html).map(mapEventbriteEvent).filter(Boolean)
  if (ebEvents.length > 0) return ebEvents

  // Legacy fallback: old acf-custom-theme server-side markup.
  return parseEventsLegacy(html)
}

export function parseEventsLegacy(html) {
  const events = []
  // Split on the event-title heading; first chunk is page preamble.
  const chunks = html.split(/<h2[^>]*class="[^"]*event-title[^"]*"[^>]*>/i)
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]

    const titleRaw = firstMatch(chunk, /^([\s\S]*?)<\/h2>/i)
    const title = titleRaw ? stripHtml(titleRaw) : null
    if (!title) continue

    const dateStr = parseDate(firstMatch(chunk, /class="[^"]*event-start-date[^"]*"[^>]*>([\s\S]*?)<\/div>/i))
    if (!dateStr) continue
    const timeStr = parseTime(firstMatch(chunk, /class="[^"]*event-start-time[^"]*"[^>]*>([\s\S]*?)<\/div>/i))

    // Location: "Venue<br>Street, City, ST ZIP" — venue name is the text
    // before the first <br> (falls back to the whole string).
    const locHtml = firstMatch(chunk, /class="[^"]*event-location[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    let venueName = null
    if (locHtml) {
      const beforeBr = locHtml.split(/<br\s*\/?>/i)[0]
      venueName = stripHtml(beforeBr) || null
    }

    const fund = stripHtml(firstMatch(chunk, /class="[^"]*event-fund-affiliation[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || '') || null

    // Ticket / registration link inside event-website.
    const websiteBlock = firstMatch(chunk, /class="[^"]*event-website[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || ''
    const ticketUrl = firstMatch(websiteBlock, /href="([^"]+)"/i)

    const description = (() => {
      const d = firstMatch(chunk, /class="[^"]*event-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      if (!d) return null
      const text = htmlToText(d).trim()
      return text ? text.slice(0, 5000) : null
    })()

    const imageUrl = firstMatch(chunk, /<img[^>]+src="([^"]+)"/i)

    // Stable id: prefer the Eventbrite numeric event id, else title+date.
    const ebId = ticketUrl ? firstMatch(ticketUrl, /-tickets-(\d+)/) : null
    const sourceId = ebId || slugify(`${title}-${dateStr}`)

    events.push({ title, dateStr, timeStr, venueName, fund, ticketUrl, description, imageUrl, sourceId })
  }
  return events
}

// ── HTML fetch ───────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🏛️  Starting Akron Community Foundation ingestion (HTML)…')
  const start = Date.now()

  try {
    const html = await fetchHtml(EVENTS_URL)
    const parsed = parseEvents(html)
    console.log(`  Parsed ${parsed.length} event blocks`)

    const today = easternTodayIso()
    const future = parsed.filter(e => e.dateStr >= today)
    console.log(`  ${future.length} upcoming (dropped ${parsed.length - future.length} past)`)

    if (future.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: parsed.length === 0 ? 'error' : 'ok',
        errorMessage: parsed.length === 0
          ? 'Page fetched but 0 events parsed — expected inline blocksForEventbrite JSON (Blocks for Eventbrite plugin) or legacy acf-custom-theme markup.'
          : undefined,
        durationMs:  Date.now() - start,
        eventsFound: parsed.length,
      })
      console.warn('  ⚠ No upcoming events — exiting 0.')
      process.exit(0)
    }

    const organizerId = await ensureOrganization('Akron Community Foundation', {
      website:     'https://www.akroncf.org',
      description: "Akron Community Foundation is Greater Akron's community foundation, stewarding hundreds of charitable funds. Its events include the ACF Annual Meeting, the Polsky Award, and affiliate-fund celebrations and annual meetings (Bath Community Fund, Black Giving Collective, Gay Community Endowment Fund, Women's Endowment Fund, and more).",
    })

    let inserted = 0, skipped = 0
    const venueCache = new Map()

    for (const ev of future) {
      try {
        const startAt = easternToIso(`${ev.dateStr} ${ev.timeStr}`)
        if (!startAt) { skipped++; continue }

        // Eventbrite payload carries an end time; legacy markup didn't.
        const endAt = ev.endLocal
          ? easternToIso(`${ev.endLocal.slice(0, 10)} ${ev.endLocal.slice(11, 19)}`)
          : null

        let venueId = null
        if (ev.venueName) {
          if (venueCache.has(ev.venueName)) {
            venueId = venueCache.get(ev.venueName)
          } else {
            venueId = await ensureVenue(ev.venueName, { city: 'Akron', state: 'OH' })
            venueCache.set(ev.venueName, venueId)
          }
          if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)
        }

        const tags = ['akron', 'nonprofit']
        if (ev.fund) tags.push(slugify(ev.fund))

        const row = {
          title:           ev.title,
          description:     ev.description,
          start_at:        startAt,
          end_at:          endAt,
          category:        parseCategory(ev.title, ev.description || ''),
          is_fundraiser:   parseIsFundraiser(ev.title, ev.description || ''),
          tags,
          price_min:       ev.isFree ? 0 : null,
          price_max:       ev.isFree ? 0 : null,
          age_restriction: 'not_specified',
          image_url:       ev.imageUrl || null,
          ticket_url:      ev.ticketUrl || EVENTS_URL,
          source:          SOURCE_KEY,
          source_id:       ev.sourceId,
          status:          'published',
          featured:        false,
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
          continue
        }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: parsed.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-acf.js`); importing the
// module for tests exposes the pure parser without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
