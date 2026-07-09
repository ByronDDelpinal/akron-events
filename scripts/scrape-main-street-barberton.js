/**
 * scrape-main-street-barberton.js
 *
 * Main Street Barberton — the downtown Barberton revitalization nonprofit.
 * Its calendar carries the community lineup: the Lake Anna Concert Series,
 * the .5K race, the Summer Crawl, White Rabbit Galleries art classes, plus
 * downtown business programming.
 *
 * Platform: WordPress + The Events Calendar, but an OLD install (ECPv6.16.x
 * with legacy recurrence): the REST API ignores date windows and reports
 * recurring series with their ORIGINAL dates (a 2026 query returns the same
 * 2023-dated "Open Mic Night" parent, duplicated within a page). The iCal
 * export is the sane path — real dated 2026 one-offs interleaved with the
 * same stale recurring parents, which skipPast + UID dedupe cleanly drop.
 *
 * Known tradeoff (verified 2026-07-08): weekly bar programming exported with
 * stale parent dates (Kavé Open Mic, Pregame Karaoke, Sporcle Trivia at
 * Ignite) is lost to skipPast because the feed carries no RRULE to expand.
 * That programming belongs to those venues' own calendars anyway (Ignite
 * Brewing is a census To Do).
 *
 * City Council / Main Street board meetings ride this feed too — dropped by
 * the meeting filter (municipal meetings are city_of_barberton territory,
 * and we filter them there as well).
 *
 * Usage:   node scripts/scrape-main-street-barberton.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import { runIcsScraper } from './lib/ics.js'

export const SOURCE_KEY = 'main_street_barberton'
const FEED_URL = 'https://www.mainstreetbarberton.com/?post_type=tribe_events&ical=1&eventDisplay=list'

// Governance entries on a community calendar — never public events.
const MEETING_RE = /\b(city council|board meeting|committee|commission|trustees?)\b/i

/** Drop meetings; everything else on the community calendar is fair game. */
export function includeEvent(ev = {}) {
  return !MEETING_RE.test(ev.SUMMARY ?? '')
}

/** ICS CATEGORIES ("Music", "art class") + title keywords → category hint. */
export function mapCategory(ev = {}) {
  const cats = String(ev.CATEGORIES ?? '').toLowerCase()
  const title = String(ev.SUMMARY ?? '').toLowerCase()
  if (cats.includes('music') || /\bconcert\b/.test(title)) return 'music'
  if (cats.includes('art')) return 'visual-art'
  if (/\bcrawl\b|\bchristmas walk\b/.test(title)) return 'festival'
  if (/\brace\b|\b5k\b/.test(title)) return 'fitness'
  return null // text inference decides
}

/**
 * Tribe iCal LOCATION: "Kavé Coffee Bar\, 584 W. Tuscarawas\, Barberton\, OH\,
 * 44203\, United States" (already unescaped by the parser). First segment is
 * the venue name unless it starts with a digit (bare address — let the
 * address-named-venue guard route it).
 */
export function parseLocation(loc = '') {
  const parts = String(loc).split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return null
  const name = parts[0]
  if (/^\d/.test(name)) return null // bare address → default venue
  // The concert series LOCATION bakes the cross-streets into the name
  // ("Lake Anna W. Park Ave/6th St NW") — canonicalize to the park record
  // instead of minting an address-in-name venue (first live run 2026-07-08).
  if (/^lake anna\b/i.test(name)) {
    return { name: 'Lake Anna Park', details: { address: 'W Park Ave & 6th St NW', city: 'Barberton', state: 'OH', zip: '44203' } }
  }
  const address = parts[1] && /\d/.test(parts[1]) ? parts[1] : null
  return { name, details: { address, city: 'Barberton', state: 'OH' } }
}

async function main() {
  await runIcsScraper({
    source:   SOURCE_KEY,
    feedUrl:  FEED_URL,
    skipPast: true,   // stale recurring parents export 2023/24 dates — drop them
    includeEvent,
    mapCategory,
    parseLocation,
    mapTags: () => ['barberton', 'downtown-barberton', 'main-street-barberton'],
    organizationName: 'Main Street Barberton',
    organizationDetails: {
      website:     'https://www.mainstreetbarberton.com',
      description: 'Downtown Barberton revitalization nonprofit — Lake Anna concerts, the .5K, the Summer Crawl, art classes, and downtown business events.',
    },
    defaultVenueName: 'Downtown Barberton',
    defaultVenueDetails: {
      address: 'W Tuscarawas Ave & 2nd St NW',
      city: 'Barberton', state: 'OH', zip: '44203',
      website: 'https://www.mainstreetbarberton.com',
      description: 'The Magic City’s historic downtown district around Lake Anna.',
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
