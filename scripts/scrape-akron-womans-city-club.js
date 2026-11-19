/**
 * scrape-akron-womans-city-club.js — Akron Woman's City Club
 * (akronwomanscityclub.org), the club at Grey Lodge on West Exchange Street
 * that also houses Coach House Theatre, the Town Hall Series and Gallery 732.
 *
 * The /events page (Drupal) lists each event with a machine-readable date:
 *
 *   <h3 class="title"><a href="/events/<slug>">Victorian Christmas Bazaar…</a></h3>
 *   <span property="dc:date" content="2026-11-28T00:00:00-05:00">Nov 28, 2026</span>
 *
 * The site gives a DATE ONLY: the content attribute is always midnight, and
 * neither the list nor the event page prints a time or a description. So
 * every listing is built at the house noon placeholder and marked
 * time_inferred, which adds the "time is a placeholder" note and flags the
 * row for review. Everything is at the club.
 *
 * Usage:
 *   node scripts/scrape-akron-womans-city-club.js
 *   node scripts/scrape-akron-womans-city-club.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { decodeEntities, easternToIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'

export const SOURCE_KEY = 'akron_womans_city_club'
const ORIGIN = 'https://www.akronwomanscityclub.org'
export const PAGE_URL = `${ORIGIN}/events`
const DAY_MS = 86_400_000

const ORG = {
  name: "Akron Woman's City Club",
  details: { website: ORIGIN, description: 'Club at historic Grey Lodge in West Akron, home to Coach House Theatre, the Town Hall Series and Gallery 732.' },
}

export const VENUE = {
  name: "Akron Woman's City Club",
  details: { address: '732 W Exchange St', city: 'Akron', state: 'OH', zip: '44302', website: ORIGIN },
}

const text = (s = '') => decodeEntities(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()

/** Events page → [{ slug, url, title, date: 'YYYY-MM-DD' }]. */
export function parseEvents(html = '') {
  const out = []
  for (const chunk of String(html).split(/<div class="chunk\b/i).slice(1)) {
    const link = chunk.match(/<h3\b[^>]*>\s*<a\b[^>]*href="(\/events\/([^"/?#]+))"[^>]*>([\s\S]*?)<\/a>/i)
    const date = chunk.match(/property="dc:date"[^>]*content="(\d{4}-\d{2}-\d{2})T/i)
    if (!link || !date || !text(link[3])) continue
    out.push({ slug: link[2], url: `${ORIGIN}${link[1]}`, title: text(link[3]), date: date[1] })
  }
  return out
}

export function categoriesFor(title = '') {
  if (/\b(theat(?:re|er)|play|performance|playmakers|coach house)\b/i.test(title)) return ['theater']
  if (/\b(bazaar|market|sale)\b/i.test(title)) return ['market']
  if (/\b(buffet|brunch|dinner|luncheon|tea)\b/i.test(title)) return ['food']
  if (/\b(gallery|exhibit|art)\b/i.test(title)) return ['visual-art']
  return ['other']
}

/** One listing → { row, venue } or { skip }. */
export function buildRow(ev) {
  if (!ev?.slug || !ev.title || !ev.date) return { skip: 'invalid' }
  // SANCTIONED-DEFAULT-TIME: the site publishes a date and no time.
  const startAt = easternToIso(ev.date, '12:00 pm')
  if (!startAt) return { skip: 'undatable' }
  return {
    row: {
      title: ev.title,
      description: "Listed on the Akron Woman's City Club events calendar.",
      start_at: startAt,
      end_at: null,
      categories: categoriesFor(ev.title),
      tags: ['west-akron', 'grey-lodge'],
      price_min: null,
      price_max: null,
      age_restriction: 'not_specified',
      image_url: null,
      ticket_url: ev.url,
      source: SOURCE_KEY,
      source_id: `${ev.slug}-${ev.date}`,
      status: 'published',
      featured: false,
      time_inferred: true,
    },
    venue: VENUE,
  }
}

export async function collect({ fetchImpl, now = Date.now } = {}) {
  const res = await fetchWithRetry(PAGE_URL, { headers: { Accept: 'text/html' }, fetchImpl })
  if (!res.ok) throw new Error(`${PAGE_URL} answered HTTP ${res.status}`)
  const html = await res.text()
  // The filter form is on the page even when no events are listed.
  if (!/field_event_type_tid|view-content|views-exposed/i.test(html)) throw new Error(`${PAGE_URL} no longer has the events listing`)
  const events = parseEvents(html)
  const rows = []
  const skipped = {}
  const earliest = now() - DAY_MS
  for (const ev of events) {
    const built = buildRow(ev)
    if (built.skip) { skipped[built.skip] = (skipped[built.skip] ?? 0) + 1; continue }
    if (Date.parse(built.row.start_at) < earliest) { skipped.past = (skipped.past ?? 0) + 1; continue }
    rows.push(built)
  }
  return { found: events.length, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY, label: "Akron Woman's City Club", emoji: '🏛️', org: ORG, homeVenue: VENUE,
    collect: () => collect({ fetchImpl, now }), dryRun, emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
