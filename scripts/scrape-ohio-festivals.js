/**
 * scrape-ohio-festivals.js
 *
 * Ohio Festivals (ohiofestivals.net) — a statewide, hand-curated festival
 * directory (WordPress). Its 2,600+ listings are a single chronological guide;
 * each festival is one line:
 *
 *     7/10-7/11 – Summit County Italian American Festival – Akron – My Review
 *     7/18*     – Halfway to Christmas – Akron
 *
 * Format: {M/D[-M/D]}{*?} – {Festival Name} – {City} [– My Review]. The trailing
 * "*" marks an unconfirmed date; "My Review" is a link to the site's own review.
 *
 * This is an AGGREGATOR, so we gate every entry to Summit County by city
 * (lib/summit-county.js) — that yields ~100 local festivals. The data is thin
 * (date + name + city only — no time, venue, or description), so we set a
 * midday default start, leave the venue null (the city goes in the description),
 * and rank `ohio_festivals` below richer sources in the dedupe priority. Year is
 * inferred from the month relative to today (months already past this year roll
 * to next year). Category festival; price never assumed.
 *
 * Usage:   node scripts/scrape-ohio-festivals.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, htmlToText, easternToIso,
  enrichWithImageDimensions, upsertEventSafe,
} from './lib/normalize.js'
import { isSummitCountyLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'ohio_festivals'
const GUIDE_URL = 'https://ohiofestivals.net/ohio-festivals/'
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const DEFAULT_TIME = '12:00 PM'   // festivals list no time — midday default
const END_TIME     = '8:00 PM'
const MAX_DAYS_AHEAD = 400

const DASH = '–'  // en-dash field separator

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/** Build YYYY-MM-DD, inferring the year: a month earlier than the current month
 *  belongs to next year (the guide spans into next year). */
export function buildYmd(month, day, now = new Date()) {
  const cm = now.getMonth() + 1
  const year = month >= cm ? now.getFullYear() : now.getFullYear() + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Parse one festival line → { name, city, startYmd, endYmd, unconfirmed } or null. */
export function parseFestivalLine(line, now = new Date()) {
  const re = new RegExp(`^(\\d{1,2})\\/(\\d{1,2})(?:-(\\d{1,2})\\/(\\d{1,2}))?(\\*?)\\s*${DASH}\\s*(.+)$`)
  const m = String(line || '').trim().match(re)
  if (!m) return null
  const [, sm, sd, em, ed, star, rest] = m
  const parts = rest.split(new RegExp(`\\s*${DASH}\\s*`)).map((s) => s.trim()).filter((p) => p && !/^my review$/i.test(p))
  if (parts.length < 2) return null
  const city = parts[parts.length - 1]
  const name = parts.slice(0, -1).join(` ${DASH} `).trim()
  if (!name || !city) return null
  return {
    name, city,
    startYmd: buildYmd(+sm, +sd, now),
    endYmd:   em ? buildYmd(+em, +ed, now) : null,
    unconfirmed: !!star,
  }
}

/** Parse the whole guide text into festival entries (not yet gated). */
export function parseFestivals(text, now = new Date()) {
  // Insert a break before each "M/D –" start, so we parse whether the source
  // rendered one festival per line or ran them together.
  const normalized = String(text || '').replace(
    new RegExp(`([^\\n\\d])\\s*(?=\\d{1,2}\\/\\d{1,2}(?:-\\d{1,2}\\/\\d{1,2})?\\*?\\s*${DASH})`, 'g'),
    '$1\n',
  )
  const out = []
  for (const line of normalized.split('\n')) {
    const f = parseFestivalLine(line, now)
    if (f) out.push(f)
  }
  return out
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎪  Starting Ohio Festivals (Summit County) ingestion…')
  const start = Date.now()
  try {
    const html = await fetchHtml(GUIDE_URL)
    const all = parseFestivals(htmlToText(html))
    const summit = all.filter((f) => isSummitCountyLocation({ city: f.city }))
    console.log(`  Parsed ${all.length} festivals; ${summit.length} in Summit County`)

    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    let inserted = 0, skipped = 0

    for (const f of summit) {
      try {
        const startIso = easternToIso(f.startYmd, DEFAULT_TIME)
        if (!startIso) { skipped++; continue }
        const ms = Date.parse(startIso)
        if (ms < now - 86_400_000 || ms > cutoff) { skipped++; continue }

        const description =
          `${f.name} is a festival in ${f.city}, Summit County, Ohio.` +
          (f.unconfirmed ? ' Dates are tentative — confirm before attending.' : '') +
          ' Listed in the Ohio Festivals guide.'

        const row = {
          title:           f.name,
          description,
          start_at:        startIso,
          end_at:          f.endYmd ? easternToIso(f.endYmd, END_TIME) : null,
          category:        'festival',
          tags:            ['festival', 'ohio-festivals', slugify(f.city)],
          price_min:       null,            // never assume free
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       null,
          ticket_url:      GUIDE_URL,
          source:          SOURCE_KEY,
          source_id:       `${slugify(f.name)}-${f.startYmd}`,
          status:          'published',
          featured:        false,
        }
        const { error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}":`, error.message); skipped++; continue }
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${f.name}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: summit.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
