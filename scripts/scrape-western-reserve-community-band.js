/**
 * scrape-western-reserve-community-band.js — Western Reserve Community Band
 * (wrcband97.org), a volunteer concert band based in Hudson.
 *
 * The band keeps a public Google Calendar (embedded on its site). The feed is
 * the band's working calendar, so most of it is rehearsals and meetings; only
 * the public performances are published:
 *
 *   kept     "WRCB Holiday Concert", "WRCB Hudson Bandstand Concert",
 *            "Hudson Ice Cream Social", "WRCB Summer Winds Event …"
 *   dropped  "WRCB Rehearsal 7-9 pm", "WRCB Holiday Concert Dress Rehearsal",
 *            "No WRCB Rehearsal", "WRCB Annual Meeting", "WRCB Social Event"
 *
 * A performance outside Summit County (the band also plays in Aurora) is
 * dropped by the city in the VEVENT's LOCATION. A concert with no LOCATION is
 * kept without a venue rather than assigned one.
 *
 * "WRCB" means nothing to a visitor, so the title is spelled out before the
 * shared ICS pipeline sees it (see expandTitles).
 *
 * Usage:
 *   node scripts/scrape-western-reserve-community-band.js
 *   node scripts/scrape-western-reserve-community-band.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runIcsScraper, fetchIcsFeed, parseIcs, icsDateToIso } from './lib/ics.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'western_reserve_community_band'
export const FEED_URL = 'https://calendar.google.com/calendar/ical/wrcband97%40gmail.com/public/basic.ics'
const SITE = 'https://wrcband97.org'
const BAND = 'Western Reserve Community Band'

const PUBLIC_RE = /\b(concert|ice cream social|summer winds|bandstand|heritage)\b/i
// "senior living": concerts played for a residence's own residents are not public.
const INTERNAL_RE = /\b(rehearsal|meeting|social event|sectional|set[\s-]?up|load[\s-]?in|senior living|cancel?led|postponed)\b/i

/** "Hudson Green, Hudson, OH 44236, USA" → "Hudson"; null when no city can be read. */
export function cityOf(location = '') {
  const parts = String(location).replace(/\\,/g, ',').split(',').map((p) => p.trim()).filter(Boolean)
  const i = parts.findIndex((p) => /^OH(?:\s+\d{5})?$/i.test(p))
  return i > 0 ? parts[i - 1] : null
}

/** True for a public performance in (or not known to be outside) Summit County. */
export function isPublicPerformance(ev) {
  const title = String(ev?.SUMMARY ?? '').trim()
  if (!title || INTERNAL_RE.test(title) || !PUBLIC_RE.test(title)) return false
  const city = cityOf(ev?.LOCATION ?? '')
  if (city && classifySummitLocation({ city }) === 'out') return false
  return true
}

/**
 * Spell the band's name out in SUMMARY lines: "WRCB Holiday Concert" →
 * "Western Reserve Community Band: Holiday Concert". A summary that never
 * names the band ("Hudson Ice Cream Social") gets the band appended, since
 * the band is what is on the bill. Runs on the raw ICS text.
 */
export function expandTitles(icsText = '') {
  return String(icsText).replace(/^SUMMARY:(.*)$/gm, (line, raw) => {
    const title = raw.trim()
    if (!title || INTERNAL_RE.test(title) || !PUBLIC_RE.test(title)) return line
    const m = title.match(/^(?:WRCB|WRC Band|WRCBand)\b[\s:–-]*(.+)$/i)
    if (m) return `SUMMARY:${BAND}: ${m[1].trim()}`
    return /western reserve community band/i.test(title) ? line : `SUMMARY:${title} (${BAND})`
  })
}

export const mapCategory = () => 'music'
export const mapTags = () => ['music', 'concert-band', 'community-band', 'hudson']

export const config = {
  source: SOURCE_KEY,
  getIcsText: async () => expandTitles(await fetchIcsFeed(FEED_URL)),
  skipPast: true,
  allowEmptyFeed: true,   // between concerts the calendar holds only rehearsals
  includeEvent: isPublicPerformance,
  organizationName: BAND,
  organizationDetails: {
    website: SITE,
    description: 'A volunteer community concert band based in Hudson, performing free public concerts around northern Summit County.',
  },
  mapCategory,
  mapTags,
  defaultPriceMin: null,   // never assume free
  defaultPriceMax: null,
  ageRestriction: 'all_ages',
}

/** Fetch + filter only; prints what a live run would publish. No database. */
export async function dryRun({ fetchText = () => fetchIcsFeed(FEED_URL), now = Date.now() } = {}) {
  const events = parseIcs(expandTitles(await fetchText()))
  const upcoming = events
    .filter(isPublicPerformance)
    .map((ev) => ({ title: ev.SUMMARY, start: ev.DTSTART ? icsDateToIso(ev.DTSTART.value, ev.DTSTART.params) : null, location: ev.LOCATION ?? null }))
    .filter((e) => e.start && Date.parse(e.start) >= now - 86_400_000)
    .sort((a, b) => a.start.localeCompare(b.start))
  console.log(`🎺  ${BAND} [dry-run: fetch + parse only, no DB access]`)
  console.log(`📥  ${events.length} calendar entries; ${upcoming.length} upcoming public performance(s)`)
  for (const e of upcoming) console.log(`     • ${e.title}\n       ${e.start}  @ ${e.location ?? '(no venue)'}`)
  return { found: events.length, upcoming }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--dry-run') || process.env.DRY_RUN === '1') await dryRun()
  else await runIcsScraper(config)
}
