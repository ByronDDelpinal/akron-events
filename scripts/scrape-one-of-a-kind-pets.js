/**
 * scrape-one-of-a-kind-pets.js — One of A Kind Pet Rescue (oneofakindpets.com),
 * the Akron cat and dog rescue with an adoption center and a spay/neuter clinic
 * in West Akron.
 *
 * Its events are WordPress posts in the "calendar" category, built in Divi.
 * The REST API returns the raw Divi shortcodes; with those removed, every
 * event post reads the same way:
 *
 *   EVENT DETAILS
 *   Saturday, November 21st // 12pm-3pm
 *   One of a Kind Pet Rescue Spay & Neuter Clinic
 *   1700 W Exchange St.
 *   Akron, Ohio 44313
 *   MAP IT
 *   <description…>
 *   Two Convenient Locations          ← site-wide footer block, ignored
 *
 * The same category also holds standing offers with no date ("Corporate Puppy
 * Party"); a post with no date line is not an event and is ignored.
 *
 *   year   the date line has none. A year printed in the post for the same day
 *          wins; otherwise this year or next, whichever makes the date fall on
 *          the weekday the line names. If neither does, the post is skipped.
 *   time   the one time or range on the date line (lib/prose-time.js);
 *          "Doors Open at 6:30pm, Dinner Starts at 8pm" resolves to the stated
 *          start. A line with no single time is skipped. Nothing is defaulted.
 *   place  the three lines under the date line. The rescue also holds
 *          fundraisers outside Summit County (North Canton); those are skipped.
 *
 * Usage:
 *   node scripts/scrape-one-of-a-kind-pets.js
 *   node scripts/scrape-one-of-a-kind-pets.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { decodeEntities, clampChars, easternToIso, easternTodayIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { MONTH_RE, monthNumber } from './lib/clock-time.js'
import { proseTime } from './lib/prose-time.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'one_of_a_kind_pets'
const ORIGIN = 'https://www.oneofakindpets.com'
const CATEGORY_ID = 228 // "calendar"
export const POSTS_URL = `${ORIGIN}/wp-json/wp/v2/posts?categories=${CATEGORY_ID}&per_page=30&_embed=wp:featuredmedia&_fields=slug,link,title,content,_links,_embedded`
const MAX_DESCRIPTION = 2000
const DAY_MS = 86_400_000
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const ORG = {
  name: 'One of A Kind Pet Rescue',
  details: {
    website: ORIGIN,
    description: 'Non-profit cat and dog rescue in West Akron, with an adoption center and a low-cost spay and neuter clinic.',
  },
}

const clean = (s = '') => String(s).replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim()

/** Divi post content → plain lines, shortcodes and tags removed. */
export function contentLines(rendered = '') {
  const text = decodeEntities(String(rendered))
    .replace(/\[\/?et_pb_[^\]]*\]/g, '\n')
    .replace(/<br\b[^>]*>|<\/(?:p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(text).split('\n').map(clean).filter(Boolean)
}

/**
 * "Saturday, November 21st // 12pm-3pm" →
 *   { weekday: 6, month: 11, day: 21, timeText: '12pm-3pm' }, or null.
 */
export function parseDateLine(line = '') {
  const m = clean(line).match(new RegExp(`^(${WEEKDAYS.join('|')}),?\\s+(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\s*(?:\\/\\/|\\||[–—-]|@|,)?\\s*(.*)$`, 'i'))
  if (!m) return null
  const day = Number(m[3])
  if (day < 1 || day > 31) return null
  return { weekday: WEEKDAYS.indexOf(m[1].toLowerCase()), month: monthNumber(m[2]), day, year: m[4] ? Number(m[4]) : null, timeText: clean(m[5]) }
}

const weekdayOf = (year, month, day) => new Date(Date.UTC(year, month - 1, day)).getUTCDay()

/** The year that puts month/day on the named weekday: stated, then this year, then next. */
export function resolveYear(date, text, now = new Date()) {
  const stated = date.year ?? [...String(text).matchAll(new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'gi'))]
    .find((m) => monthNumber(m[1]) === date.month && Number(m[2]) === date.day)?.[3]
  const thisYear = Number(easternTodayIso(now).slice(0, 4))
  const candidates = stated ? [Number(stated)] : [thisYear, thisYear + 1]
  return candidates.find((y) => weekdayOf(y, date.month, date.day) === date.weekday) ?? null
}

/** "Akron, Ohio 44313" → { city, zip }, or null. */
function cityLine(line = '') {
  const m = clean(line).match(/^([A-Za-z .'-]+),\s*(?:OH|Ohio)\.?\s*(\d{5})?$/i)
  return m ? { city: clean(m[1]), zip: m[2] ?? null } : null
}

/**
 * One post → { title, date, venue, description } for an event post, or null
 * for a post with no date line (a standing offer, not an event).
 */
export function parsePost(post) {
  const lines = contentLines(post?.content?.rendered ?? '')
  const at = lines.findIndex((l) => parseDateLine(l))
  if (at < 0) return null
  const date = parseDateLine(lines[at])
  const end = lines.findIndex((l, i) => i > at && /^two convenient locations$/i.test(l))
  const body = lines.slice(at + 1, end > at ? end : undefined)
  const mapAt = body.findIndex((l) => /^map it$/i.test(l))
  const placeLines = mapAt > 0 ? body.slice(0, mapAt) : []
  const prose = (mapAt >= 0 ? body.slice(mapAt + 1) : body).filter((l) => !/^back to events$/i.test(l) && !/@[\w-]+\.\w+/.test(l))
  let venue = null
  const where = placeLines.length >= 2 ? cityLine(placeLines[placeLines.length - 1]) : null
  if (where) {
    const [name, ...street] = placeLines.slice(0, -1)
    venue = { name, details: { ...(street.length ? { address: street.join(', ').replace(/\.$/, '') } : {}), city: where.city, state: 'OH', ...(where.zip ? { zip: where.zip } : {}) } }
  }
  return {
    // The rescue decorates titles ("…to town!!🎵"); the listing keeps the words.
    title: clean(decodeEntities(post?.title?.rendered ?? '').replace(/\p{Extended_Pictographic}|\uFE0F/gu, '')).replace(/([!?])\1+$/, '$1'),
    date,
    venue,
    description: prose.length ? clampChars(prose.join('\n\n'), MAX_DESCRIPTION) : null,
    text: lines.slice(at).join('\n'),
  }
}

/** One event post → { row, venue } or { skip }. */
export function buildRow(post, now = new Date()) {
  const parsed = parsePost(post)
  if (!parsed) return { skip: 'not_an_event' }
  if (!post?.slug || !parsed.title) return { skip: 'invalid' }
  if (parsed.venue && classifySummitLocation({ city: parsed.venue.details.city }) === 'out') return { skip: 'out_of_county' }
  const time = proseTime(parsed.date.timeText)
  if (!time) return { skip: 'no_single_time' }
  const year = resolveYear(parsed.date, parsed.text, now)
  if (!year) return { skip: 'weekday_mismatch' }
  const dateStr = `${year}-${String(parsed.date.month).padStart(2, '0')}-${String(parsed.date.day).padStart(2, '0')}`
  const startAt = easternToIso(dateStr, time.startTime)
  if (!startAt) return { skip: 'undatable' }
  const endAt = time.endTime ? easternToIso(dateStr, time.endTime) : null
  return {
    row: {
      title: parsed.title,
      description: parsed.description,
      start_at: startAt,
      end_at: endAt && endAt > startAt ? endAt : null,
      categories: ['other'],
      tags: ['pets', 'animal-rescue', 'fundraiser'],
      price_min: null,
      price_max: null,
      age_restriction: 'not_specified',
      image_url: post?._embedded?.['wp:featuredmedia']?.[0]?.source_url ?? null,
      ticket_url: post.link,
      source: SOURCE_KEY,
      source_id: `${post.slug}-${dateStr}`,
      status: 'published',
      featured: false,
    },
    venue: parsed.venue,
  }
}

export async function collect({ fetchImpl, now = Date.now } = {}) {
  const res = await fetchWithRetry(POSTS_URL, { headers: { Accept: 'application/json' }, fetchImpl })
  if (!res.ok) throw new Error(`${POSTS_URL} answered HTTP ${res.status}`)
  const posts = await res.json()
  if (!Array.isArray(posts)) throw new Error('The WordPress posts endpoint did not return a list')
  const rows = []
  const skipped = {}
  const skip = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1 }
  const earliest = now() - DAY_MS
  let found = 0
  for (const post of posts) {
    const built = buildRow(post, new Date(now()))
    if (built.skip === 'not_an_event') continue
    found++
    if (built.skip) { skip(built.skip); continue }
    if (Date.parse(built.row.start_at) < earliest) { skip('past'); continue }
    rows.push(built)
  }
  return { found, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY,
    label: 'One of A Kind Pet Rescue',
    emoji: '🐾',
    org: ORG,
    homeVenue: null,
    collect: () => collect({ fetchImpl, now }),
    dryRun,
    emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
