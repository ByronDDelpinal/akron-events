/**
 * scrape-hudson-heritage.js — Hudson Heritage Association (hudsonheritage.org),
 * the historic-preservation society that hosts a free public history program
 * each month from September to May.
 *
 * The season is published once a year as a WordPress post titled
 * "Our 2026-2027 Program Calendar". Each program is one paragraph:
 *
 *   <p><strong>February 11 – Introducing the Akron History Museum<br></strong>
 *      Laurel Lake Community Room</p>
 *
 * The post is found through the WordPress REST API by its slug pattern
 * (our-YYYY-YYYY-program-calendar), so next season's post is picked up without
 * a code change. The year of each date comes from the season in the slug:
 * July to December is the first year, January to June the second.
 *
 * Left out, and counted: a month whose program is "to be announced" (there is
 * nothing to list yet; the id is the date, so it appears once it is named),
 * a program with no announced place, and the May annual meeting, which the
 * page says is for members only.
 *
 * START TIME. The association's programs begin at 7 p.m. and the calendar
 * says so in some seasons ("all meetings … begin at 7 p.m.") but not in
 * others. A time printed in the post is used. When none is printed the row is
 * built at 7:00 PM and marked time_inferred, which makes the shared upsert add
 * the placeholder-time note and flag the row for review.
 *
 * Usage:
 *   node scripts/scrape-hudson-heritage.js
 *   node scripts/scrape-hudson-heritage.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { htmlToText, easternToIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { MONTH_RE, monthNumber, parseClockTime } from './lib/clock-time.js'

export const SOURCE_KEY = 'hudson_heritage'
const ORIGIN = 'https://hudsonheritage.org'
export const POSTS_URL = `${ORIGIN}/wp-json/wp/v2/posts?search=program%20calendar&per_page=20&_fields=slug,link,title,content`
const SLUG_RE = /^our-(20\d{2})-(20\d{2})-program-calendar$/
const USUAL_TIME = parseClockTime('7:00 pm')
const DAY_MS = 86_400_000

const ORG = {
  name: 'Hudson Heritage Association',
  details: {
    website: ORIGIN,
    description: 'Volunteer historic-preservation society in Hudson. Hosts a free public history program each month from September to May.',
  },
}

const HUDSON = { city: 'Hudson', state: 'OH', zip: '44236' }

/** Places the association names, matched loosely; `room` is kept in the description. */
const KNOWN_VENUES = [
  { match: /barlow community center/i, name: 'Barlow Community Center', details: { address: '41 S Oviatt St', ...HUDSON } },
  { match: /hudson library/i, name: 'Hudson Library & Historical Society', details: { address: '96 Library St', ...HUDSON } },
  { match: /western reserve academy|\bWRA\b/i, name: 'Western Reserve Academy', details: { address: '115 College Street', ...HUDSON } },
  { match: /laurel lake/i, name: 'Laurel Lake Retirement Community', details: { address: '200 Laurel Lake Dr', ...HUDSON } },
]

const clean = (s = '') => String(s).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim()

/** "our-2026-2027-program-calendar" → { startYear: 2026, endYear: 2027 }, or null. */
export function seasonOf(slug = '') {
  const m = String(slug).match(SLUG_RE)
  if (!m) return null
  const startYear = Number(m[1])
  const endYear = Number(m[2])
  return endYear === startYear + 1 ? { startYear, endYear } : null
}

/** Season posts that have not ended yet (a season ends on June 30 of its second year). */
export function pickSeasonPosts(posts = [], now = Date.now()) {
  return (Array.isArray(posts) ? posts : [])
    .map((post) => ({ post, season: seasonOf(post?.slug) }))
    .filter(({ season }) => season && Date.UTC(season.endYear, 6, 1) > now)
    .sort((a, b) => a.season.startYear - b.season.startYear)
}

/** "Laurel Lake Community Room" → { venue: { name, details }, room } ; null when unannounced. */
export function resolvePlace(text = '') {
  const place = clean(text)
  if (!place || /to be announced|\btba\b|\btbd\b/i.test(place)) return null
  const known = KNOWN_VENUES.find((v) => v.match.test(place))
  if (known) return { venue: { name: known.name, details: known.details }, room: place === known.name ? null : place }
  return { venue: { name: place, details: { ...HUDSON } }, room: null }
}

/** A time the post states for its meetings ("begin at 7 p.m."), or null. */
export function statedTime(text = '') {
  const m = clean(text).match(/\b(?:begin|start)s?\s+at\s+(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i)
  return m ? parseClockTime(m[1]) : null
}

/**
 * Program paragraphs of one season post →
 *   { programs: [{ month, day, title, place }], time, unparsed }
 * `unparsed` counts paragraphs that begin with a month and day but do not fit.
 */
export function parseSeasonPost(html = '') {
  const paragraphs = [...String(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => htmlToText(m[1].replace(/<br\s*\/?>/gi, '\n')).split('\n').map(clean).filter(Boolean))
    .filter((lines) => lines.length)
  const lineRe = new RegExp(`^(${MONTH_RE})\\s+(\\d{1,2})\\s*[–—-]\\s*(.+)$`, 'i')
  const datedRe = new RegExp(`^(?:${MONTH_RE})\\s+\\d{1,2}\\b`, 'i')
  const programs = []
  let unparsed = 0
  for (const lines of paragraphs) {
    const m = lines[0].match(lineRe)
    if (!m) { if (datedRe.test(lines[0])) unparsed++; continue }
    const day = Number(m[2])
    if (day < 1 || day > 31) { unparsed++; continue }
    programs.push({ month: monthNumber(m[1]), day, title: clean(m[3]), place: lines.slice(1).join(', ') })
  }
  return { programs, time: statedTime(htmlToText(html)), unparsed }
}

/** One program → { row, venue } or { skip }. */
export function buildRow(program, season, { link, time } = {}) {
  if (!program?.title || !season) return { skip: 'invalid' }
  if (/to be announced|\btba\b|\btbd\b|no program/i.test(program.title)) return { skip: 'unannounced' }
  if (/\bmembers\b|annual meeting/i.test(program.title)) return { skip: 'members_only' }
  const place = resolvePlace(program.place)
  if (!place) return { skip: 'no_place' }
  const year = program.month >= 7 ? season.startYear : season.endYear
  const dateStr = `${year}-${String(program.month).padStart(2, '0')}-${String(program.day).padStart(2, '0')}`
  const startAt = easternToIso(dateStr, (time ?? USUAL_TIME).time)
  if (!startAt) return { skip: 'undatable' }
  const where = place.room ? ` Held in the ${place.room}.` : ''
  const row = {
    title: program.title,
    description: `A Hudson Heritage Association monthly program. Free and open to the public.${where}`,
    start_at: startAt,
    end_at: null,
    categories: ['learning'],
    tags: ['history', 'lecture', 'hudson', 'free'],
    price_min: 0,
    price_max: 0,
    age_restriction: 'all_ages',
    image_url: null,
    ticket_url: link || ORIGIN,
    source: SOURCE_KEY,
    // The date, not the title: a month announced later keeps its id.
    source_id: `${season.startYear}-${season.endYear}-${dateStr}`,
    status: 'published',
    featured: false,
  }
  // SANCTIONED-DEFAULT-TIME: the post printed no time, so 7:00 PM (the
  // association's standing hour) is a placeholder and is disclosed as one.
  if (!time) row.time_inferred = true
  return { row, venue: place.venue }
}

export async function collect({ fetchImpl, now = Date.now } = {}) {
  const res = await fetchWithRetry(POSTS_URL, { headers: { Accept: 'application/json' }, fetchImpl })
  if (!res.ok) throw new Error(`${POSTS_URL} answered HTTP ${res.status}`)
  const posts = await res.json()
  if (!Array.isArray(posts)) throw new Error('The WordPress posts endpoint did not return a list')
  const rows = []
  const skipped = {}
  const skip = (reason, n = 1) => { if (n > 0) skipped[reason] = (skipped[reason] ?? 0) + n }
  const earliest = now() - DAY_MS
  let found = 0
  for (const { post, season } of pickSeasonPosts(posts, now())) {
    const parsed = parseSeasonPost(post?.content?.rendered ?? '')
    found += parsed.programs.length + parsed.unparsed
    skip('unparsed_line', parsed.unparsed)
    for (const program of parsed.programs) {
      const built = buildRow(program, season, { link: post.link, time: parsed.time })
      if (built.skip) { skip(built.skip); continue }
      if (Date.parse(built.row.start_at) < earliest) { skip('past'); continue }
      rows.push(built)
    }
  }
  return { found, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY,
    label: 'Hudson Heritage Association',
    emoji: '🏛️',
    org: ORG,
    homeVenue: null,
    collect: () => collect({ fetchImpl, now }),
    dryRun,
    // In July and August no season post is current; that is not a broken parser.
    emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
