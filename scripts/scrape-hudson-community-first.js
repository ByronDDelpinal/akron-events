/**
 * scrape-hudson-community-first.js — Hudson Community First
 * (hudsoncommunityfirst.com), the Hudson coalition for youth and families.
 *
 * Its site embeds a public Google Calendar. About half of the entries are
 * the school calendars it tracks for families ("No School - HCS", "Winter
 * Break - HCS", "Spring Break - WRA") and the coalition's own board meetings
 * and deadlines; those are dropped. What is left are community events: the
 * Holiday Shoppe & Community Craft Fair, Toast to Hudson, parent
 * presentations and career panels.
 *
 * The shared ICS pipeline does the rest. An entry with no time gets the
 * pipeline's disclosed noon placeholder; an entry with no LOCATION is
 * published without a venue.
 *
 * Usage:
 *   node scripts/scrape-hudson-community-first.js
 *   node scripts/scrape-hudson-community-first.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runIcsScraper, fetchIcsFeed, parseIcs, icsDateToIso } from './lib/ics.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'hudson_community_first'
export const FEED_URL = 'https://calendar.google.com/calendar/ical/hudsoncommunityfirstoh%40gmail.com/public/basic.ics'
const SITE = 'https://hudsoncommunityfirst.com'
const NAME = 'Hudson Community First'

// School-calendar markers, the coalition's internal business, and reminders.
const NOT_AN_EVENT_RE = /\b(no school|(?:thanksgiving|holiday|winter|spring|summer|fall)\s+break|last day of school|first day of school|early (?:release|dismissal)|late start|conferences?|board meeting|committee meeting|nominations? due|applications? due|deadline|cancel?led|postponed)\b/i

/** "Hudson Middle School, 83 N Oviatt St, Hudson, OH 44236, USA" → "Hudson"; null when unreadable. */
export function cityOf(location = '') {
  const parts = String(location).replace(/\\,/g, ',').split(',').map((p) => p.trim()).filter(Boolean)
  const i = parts.findIndex((p) => /^OH(?:\s+\d{5})?$/i.test(p))
  return i > 0 ? parts[i - 1] : null
}

/** True for a community event in (or not known to be outside) Summit County. */
export function isCommunityEvent(ev) {
  const title = String(ev?.SUMMARY ?? '').trim()
  if (!title || NOT_AN_EVENT_RE.test(title)) return false
  const city = cityOf(ev?.LOCATION ?? '')
  return !(city && classifySummitLocation({ city }) === 'out')
}

export function mapCategory(ev) {
  const t = String(ev?.SUMMARY ?? '')
  if (/\b(craft fair|shoppe|market|bazaar)\b/i.test(t)) return 'market'
  if (/\b(toast|gala|festival|celebration)\b/i.test(t)) return 'festival'
  return 'learning'
}
export const mapTags = () => ['hudson', 'family', 'community']

export const config = {
  source: SOURCE_KEY,
  feedUrl: FEED_URL,
  skipPast: true,
  allowEmptyFeed: true,
  includeEvent: isCommunityEvent,
  organizationName: NAME,
  organizationDetails: {
    website: SITE,
    description: 'Hudson coalition of parents, schools and community groups supporting the health and safety of local youth and families.',
  },
  mapCategory,
  mapTags,
  defaultPriceMin: null,
  defaultPriceMax: null,
  ageRestriction: 'all_ages',
}

/** Fetch + filter only; prints what a live run would publish. No database. */
export async function dryRun({ fetchText = () => fetchIcsFeed(FEED_URL), now = Date.now() } = {}) {
  const events = parseIcs(await fetchText())
  const upcoming = events
    .filter(isCommunityEvent)
    .map((ev) => ({ title: ev.SUMMARY, start: ev.DTSTART ? icsDateToIso(ev.DTSTART.value, ev.DTSTART.params) : null, location: ev.LOCATION ?? null }))
    .filter((e) => e.start && Date.parse(e.start) >= now - 86_400_000)
    .sort((a, b) => a.start.localeCompare(b.start))
  console.log(`🤝  ${NAME} [dry-run: fetch + parse only, no DB access]`)
  console.log(`📥  ${events.length} calendar entries; ${upcoming.length} upcoming community event(s)`)
  for (const e of upcoming) console.log(`     • ${e.title}\n       ${e.start}  @ ${e.location ?? '(no venue)'}`)
  return { found: events.length, upcoming }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--dry-run') || process.env.DRY_RUN === '1') await dryRun()
  else await runIcsScraper(config)
}
