/**
 * scrape-acf.js
 *
 * Akron Community Foundation — "Upcoming Events" page.
 *   https://www.akroncf.org/news-and-events/acf-events/
 *
 * ACF is Greater Akron's community foundation. Its events page is a custom
 * WordPress theme (acf-custom-theme) that renders each event as a server-side
 * HTML block — no Tribe Events REST API, no ICS feed — so we parse the markup
 * directly. The structure is clean and class-stable:
 *
 *   <h2 class="event-title">…</h2>
 *   <div class="event-details">
 *     <div class="event-details-left">
 *       <div class="event-start-date">June 5, 2026</div>
 *       <div class="event-start-time">6:00 pm</div>        (optional — all-day events omit)
 *       <div class="event-location">Venue<br>Street, City, ST ZIP</div>
 *       <div class="event-fund-affiliation">The Gay Community Endowment Fund</div>  (optional)
 *       <div class="event-website"><a class="btn" href="…eventbrite…">Get Tickets</a></div>
 *     </div>
 *   </div>
 *   <div class="event-description">…</div>
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

function parseCategory(title = '', desc = '') {
  const t = `${title} ${desc}`.toLowerCase()
  if (/celebration|anniversary|gala|reception|awards?\b|polsky/.test(t)) return 'nonprofit'
  if (/meeting|session|partner|breakfast|luncheon/.test(t))             return 'nonprofit'
  return 'nonprofit'
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

// ── Parse the events page ────────────────────────────────────────────────────

export function parseEvents(html) {
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

    const today = new Date().toISOString().split('T')[0]
    const future = parsed.filter(e => e.dateStr >= today)
    console.log(`  ${future.length} upcoming (dropped ${parsed.length - future.length} past)`)

    if (future.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: parsed.length === 0 ? 'error' : 'ok',
        errorMessage: parsed.length === 0
          ? 'Page fetched but 0 event blocks parsed — the acf-custom-theme markup may have changed (expected h2.event-title / .event-start-date).'
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
          end_at:          null,
          category:        parseCategory(ev.title, ev.description || ''),
          tags,
          price_min:       null,
          price_max:       null,
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
