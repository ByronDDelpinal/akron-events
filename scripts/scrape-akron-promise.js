/**
 * scrape-akron-promise.js
 *
 * Akron Promise is an Akron education nonprofit (scholarships + student support)
 * whose public-facing events are its "City Series" — a season of neighborhood
 * 5K/run-walk races that support community organizations, promote youth
 * opportunity, and explore Akron's neighborhoods (Flight of the Heron, West
 * Akron, Goodyear Heights History, Towpath Freedom, etc.).
 *
 * Source: the City Series landing page at akronpromise.org/cityseries (Drupal
 * 10, server-rendered). Each "Upcoming Races" card (`div.item`) carries a logo
 * image, an <h3> title, a `div.date` (M/D/YY H:MM [AM/PM]), free-text detail
 * lines (Dog Friendly / Finisher Medal / Kids Run, etc.), and a "Register Now"
 * link (usually RunSignup). The thin /events page only holds a Google Form, so
 * the City Series is the real event source.
 *
 * Notes:
 *   - No venue: the races are scattered across different Akron neighborhoods and
 *     the page lists no per-race address, so we don't mint a (wrong) venue — the
 *     RunSignup link carries the start location.
 *   - Price is left null (never assume free — races are ticketed; APS students
 *     register free, but the general public pays a registration fee).
 *   - Category is 'fitness' (run/walk races), mirroring scrape-akron-marathon.js.
 *
 * Usage:
 *   node scripts/scrape-akron-promise.js
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
  htmlToText,
  decodeEntities,
  easternToIso,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventOrganization,
  linkEventVenue,
  ensureOrganization,
  ensureVenue,
} from './lib/normalize.js'
import { isRunSignupUrl, fetchRunSignupRaceData } from './lib/runsignup.js'

// ── Constants ──────────────────────────────────────────────────────────────

export const SOURCE_KEY = 'akron_promise'
const ORIGIN     = 'https://www.akronpromise.org'
const SERIES_URL = `${ORIGIN}/cityseries`
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_DAYS_AHEAD = 400  // the City Series publishes its full season at once

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/** Parse a "M/D/YY H:MM [AM/PM]" string into { datePart, time } for easternToIso. */
export function parsePromiseDate(text) {
  const m = String(text || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/)
  if (!m) return null
  const month = +m[1], day = +m[2]
  let year = +m[3]; if (year < 100) year += 2000
  let hour = +m[4]; const minute = m[5]
  const mer = (m[6] || '').toUpperCase()
  if (mer === 'PM' && hour < 12) hour += 12
  else if (mer === 'AM' && hour === 12) hour = 0
  // No meridiem (e.g. "8:00"): morning race — use the hour as written (24h).
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const datePart = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const h12 = (hour % 12) || 12
  const ampm = hour < 12 ? 'AM' : 'PM'
  return { datePart, time: `${h12}:${minute} ${ampm}` }
}

/** Derive the full-resolution Drupal image (strip the image-style segment). */
export function fullImage(src, origin = ORIGIN) {
  if (!src) return null
  const p = String(src).replace(/\/styles\/[^/]+\/public\//, '/').split('?')[0]
  return /^https?:\/\//i.test(p) ? p : `${origin}${p.startsWith('/') ? '' : '/'}${p}`
}

/** Build the tag list from a race's detail text. */
export function raceTags(detail) {
  const d = (detail || '').toLowerCase()
  const tags = ['city-series', 'race', 'run-walk', 'akron-promise']
  if (/dog friendly/.test(d))   tags.push('dog-friendly')
  if (/kids run/.test(d))       tags.push('family')
  if (/wheel racers/.test(d))   tags.push('accessible')
  if (/\b5k\b/.test(d))         tags.push('5k')
  return [...new Set(tags)]
}

/**
 * Parse the "Upcoming Races" cards out of the City Series HTML.
 * @returns {object[]} — { title, startIso, imageUrl, ticketUrl, description, detail }
 */
export function parseRaces(html, origin = ORIGIN) {
  // Scope to the races region so footer headings don't leak in.
  const region = String(html || '').match(/Upcoming Races<\/h2>([\s\S]*?)<\/main>/i)?.[1] || String(html || '')
  const cards = region.split(/<div class="item">/i).slice(1)
  const out = []
  for (const card of cards) {
    const title = decodeEntities((card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || '')
      .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
    const dateText = (card.match(/<div[^>]*class="date"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '')
      .replace(/<[^>]*>/g, '').trim()
    if (!title || !dateText) continue

    const dt = parsePromiseDate(dateText)
    if (!dt) continue
    const startIso = easternToIso(dt.datePart, dt.time)
    if (!startIso) continue

    const imageUrl = fullImage(card.match(/<img[^>]+src="([^"]+)"/i)?.[1] || null, origin)
    const ticketUrl = card.match(/<a[^>]+href="([^"]+)"[^>]*>\s*Register Now/i)?.[1] || null
    // Detail lines: text between the date div and the Register link / text-div close.
    const detailHtml = card.match(/<div[^>]*class="date"[^>]*>[\s\S]*?<\/div>([\s\S]*?)<(?:a|\/div)\b/i)?.[1] || ''
    const description = htmlToText(detailHtml) || null

    out.push({ title, startIso, imageUrl, ticketUrl, description, detail: htmlToText(detailHtml) })
  }
  return out
}

// ── HTML fetch ──────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🏃  Starting Akron Promise City Series ingestion…')
  const start = Date.now()
  try {
    const organizerId = await ensureOrganization('Akron Promise', {
      website: ORIGIN,
      description: 'Akron Promise is an Akron nonprofit providing scholarships and student support, and the organizer of the City Series — a season of neighborhood run/walk races supporting local community organizations.',
    })

    const html  = await fetchHtml(SERIES_URL)
    const races = parseRaces(html)
    console.log(`  Found ${races.length} upcoming race(s)`)

    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    const venueCache = new Map() // venue name → id
    let inserted = 0, skipped = 0, enriched = 0

    for (const race of races) {
      try {
        const startMs = Date.parse(race.startIso)
        if (startMs < now - 86_400_000 || startMs > cutoff) { skipped++; continue }

        // Enrich from RunSignup when the race links there (description, venue,
        // logo, authoritative start time + price). RunSignup is the registration
        // system of record, so its start time wins over the City Series card
        // (which can be stale) — this also aligns times with scrape-runsignup.js
        // so the cross-source dedupe can merge the overlap.
        const rs = isRunSignupUrl(race.ticketUrl) ? await fetchRunSignupRaceData(race.ticketUrl) : null
        if (rs) enriched++
        const startIso = rs?.startIso || race.startIso

        // Resolve the venue from RunSignup's address. Real place names become
        // normal (listed) venues; bare street addresses are minted UNLISTED so
        // the event has a navigable location without cluttering the directory.
        let venueId = null
        if (rs?.venueName) {
          if (venueCache.has(rs.venueName)) {
            venueId = venueCache.get(rs.venueName)
          } else {
            const venueOpts = rs.bareAddress ? { allowAddressName: true, listed: false } : {}
            venueId = await ensureVenue(rs.venueName, rs.venueDetails, venueOpts)
            venueCache.set(rs.venueName, venueId)
          }
        }

        const slug = race.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const row = {
          title:           race.title,
          description:     rs?.description || race.description,
          start_at:        startIso,
          end_at:          null,
          category:        'fitness',
          tags:            raceTags(race.detail),
          price_min:       rs?.priceMin ?? null,   // real registration fee when RunSignup has it; never assumed
          price_max:       rs?.priceMax ?? null,
          age_restriction: 'all_ages',
          image_url:       race.imageUrl || rs?.logo || null,
          ticket_url:      race.ticketUrl || SERIES_URL,
          source:          SOURCE_KEY,
          source_id:       `${slug}-${startIso.slice(0, 10)}`,
          status:          'published',
          featured:        false,
        }

        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}":`, error.message); skipped++; continue }
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${race.title}":`, err.message)
        skipped++
      }
    }
    console.log(`  Enriched ${enriched}/${races.length} race(s) from RunSignup`)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: races.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
