/**
 * scrape-jadfa-house.js
 *
 * The JADFA House, a 501(c)(3) recovery and community center at 916 Kenmore
 * Blvd, Akron OH 44314, founded by Kenny Lambert (the "Just a Dad From Akron"
 * brand). Source page: https://www.thejadfahouse.org/meetings/, a WordPress
 * site built with Divi (generator meta "FSM Foundation v.1.0").
 *
 * Event model: RECURRENCE EXPANSION, not date parsing. The page publishes a
 * fixed weekly schedule with weekdays and clock times but NO dates: a
 * "Our Meetings:" heading, then one <p><strong>WEEKDAY:</strong></p> per day
 * followed by a <ul> of that day's meetings. Nothing about the schedule is
 * hardcoded here. We slice the meetings block, read the day headings and the
 * <li> items out of it, and generate the next OCCURRENCE_COUNT weekly
 * occurrences per meeting via lib/weekly-occurrences.js (Eastern-anchored
 * calendar math, immune to the UTC-rollover footgun) paired with
 * easternToIso(ymd, 'HH:MM'). If the house moves a meeting, the next scrape
 * follows it.
 *
 * BLOCK BOUND (load-bearing): the meetings block runs from the "Our Meetings"
 * <h3> to the NEXT <h3>. That next heading opens a RETIRED section, "Fear of
 * Change Friday Meeting", which the house concluded at the end of 2025. The
 * bound is what keeps a dead meeting off the site. It cuts both ways: any day
 * heading placed AFTER that h3 is silently dropped, so a SATURDAY block appended
 * below the retired section would never be seen. Undercounting is the fail-safe
 * direction and MIN_EXPECTED_MEETINGS catches a real shrink, but a genuinely new
 * day has to sit ABOVE the retired heading to be picked up.
 *
 * DAY HEADINGS: the colon after the weekday is optional. SUNDAY, TUESDAY,
 * WEDNESDAY and THURSDAY carry one; FRIDAY does not. Items are assigned to the
 * nearest PRECEDING day heading by byte offset rather than by matching nested
 * <ul> structure, because the day heading and its list are siblings, not
 * parent and child.
 *
 * SOURCE_ID (load-bearing): 'meeting-<weekday>-<HHMM>-<YYYY-MM-DD>', keyed on
 * weekday plus 24-hour start time plus date, NEVER on a title slug. The
 * likeliest edit this page will ever receive is fixing "Recovery Dharm" to
 * "Recovery Dharma". A title-keyed id would re-insert every future occurrence
 * under a new id and orphan the old rows, which is same-source source_id churn
 * that find:dupes is structurally blind to. There is no SOURCE_KEY prefix
 * because the unique constraint is on the PAIR (source, source_id).
 *
 * The other horn of that trade is COLLISION: two meetings sharing a weekday AND
 * a start time would mint the same id, and the second would upsert straight over
 * the first, so one meeting would silently never publish. A men's group and a
 * women's group running the same hour in different rooms is a common
 * recovery-center pattern, so this is a plausible future page edit rather than a
 * hypothetical. buildMeetingEvents therefore tracks the ids it has issued WITHIN
 * a run and appends a numeric suffix only on collision, in document order: the
 * first occupant keeps the bare id, the second becomes '...-2', the third
 * '...-3'. Every non-colliding meeting keeps a title-invariant id, which is the
 * property that must not regress. Reordering two colliding meetings on the page
 * swaps their suffixes; that is the accepted cost of not keying on the title.
 *
 * TITLES ARE VERBATIM: "Recovery Dharm" is the page's own spelling, a typo.
 * We publish what the house publishes. There is deliberately no correction map,
 * because a correction map is a second place the truth lives.
 *
 * ACCESS LABELS: four of the seven meetings state doors, six state an access
 * label in parentheses ("Open", "Open - Men Only", "Open - Women Only"). The
 * Friday Jenga line states NEITHER an access label nor a separator. We say
 * nothing about access for it rather than inferring "Open" from its siblings.
 * Sex restrictions ride in the title and description only; age_restriction
 * stays 'not_specified' because it is an age field, not a sex field.
 *
 * PRICE is parsed, never assumed. The rules section states "Attendance is free
 * as are snacks, water and hot coffee." We match that sentence and set
 * price 0 when it is present, null when it is not, so if the house ever starts
 * charging we stop claiming free on the next scrape.
 *
 * FAMILY: the rules section also says "We are a kid-friendly space." That is a
 * building policy, not an event facet, and it flips the family inference to
 * true. So the sentence is kept OUT of the description and is_family is set
 * explicitly to false.
 *
 * NEIGHBORHOOD: VENUE_DETAILS deliberately carries NO neighborhood_slug. The
 * polygon resolver derives it from the coordinates. KillBox spent two months
 * on the wrong neighborhood hub because a hardcoded slug sat next to hardcoded
 * coordinates and made the wrongness invisible; removing the redundant
 * hardcoded fact makes the coordinates load-bearing and therefore checkable.
 *
 * VENUE NAME TRAP: venueNameKey does NOT strip a leading "The" (unlike org
 * folding). venueNameKey('The JADFA House') is 'the jadfa house';
 * venueNameKey('JADFA House') is 'jadfa house'. The existing venue row is
 * named "The JADFA House" and its address is NULL, so the address fallback
 * cannot rescue a short-form lookup. Passing 'JADFA House' would mint a
 * duplicate venue. Never shorten it.
 *
 * We tag-strip the RAW HTML and decode entities locally rather than reaching
 * for htmlToText: the meeting lines are single <li> runs whose internal
 * structure carries no meaning, and stripHtml's flatten-all-whitespace contract
 * is exactly what we want per item. Fixture captured from the live raw source
 * (fetch().text(), not the rendered DOM) on 2026-08-23.
 *
 * Usage:   node scripts/scrape-jadfa-house.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { WEEKDAY, nextWeeklyOccurrences } from './lib/weekly-occurrences.js'

export const SOURCE_KEY = 'jadfa_house'
const PAGE_URL = 'https://www.thejadfahouse.org/meetings/'
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

/** How many weeks forward each weekly meeting is materialised. */
const OCCURRENCE_COUNT = 8

/**
 * Hard floor. Seven meetings are published today; anything under five means the
 * page was redesigned or the block bound moved, and the run fails loudly rather
 * than quietly writing a partial schedule. It also gates the stale sweep.
 */
export const MIN_EXPECTED_MEETINGS = 5

const ORG_NAME   = 'The JADFA House'
const VENUE_NAME = 'The JADFA House'   // EXACT, including "The" (see header)
const HOUSE_DESCRIPTION =
  'Recovery and community center on Kenmore Boulevard in Akron, founded by Kenny Lambert. ' +
  'Hosts free open recovery meetings, peer support, and community events.'
const VENUE_DETAILS = {
  address: '916 Kenmore Blvd',
  city: 'Akron', state: 'OH', zip: '44314',
  lat: 41.0436708, lng: -81.5568374,   // no neighborhood_slug on purpose, see header
  website: 'https://www.thejadfahouse.org',
  description: HOUSE_DESCRIPTION,
}

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/** Decode the handful of entities this Divi page actually emits. */
function decodeEntities(text = '') {
  return String(text)
    .replace(/&#8217;|&rsquo;|&#x27;|&#39;/g, "'")
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/** Strip tags, decode entities, collapse whitespace. One <li> in, one line out. */
export function cleanItemText(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ' '),
  )
    // \s already covers U+00A0, which this page emits literally as well as via &nbsp;
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The markup between the "Our Meetings" <h3> and the NEXT <h3>.
 *
 * That next heading opens the retired "Fear of Change Friday Meeting" section,
 * so this bound is the whole reason a concluded meeting never reaches the site.
 * Returns '' when the page no longer carries the heading at all.
 */
export function sliceMeetingsBlock(html = '') {
  const source = String(html)
  const headings = [...source.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)]
  const startIdx = headings.findIndex((h) => /our\s+meetings/i.test(h[1]))
  if (startIdx === -1) return ''
  const opening = headings[startIdx]
  const from = opening.index + opening[0].length
  const next = headings[startIdx + 1]
  return source.slice(from, next ? next.index : source.length)
}

/** "7", "30", "p" -> "19:30". Returns null when the hour is out of range. */
function to24h(hourStr, minStr, meridiem) {
  let hour = parseInt(hourStr, 10)
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null
  const isPm = /^p/i.test(meridiem)
  if (isPm && hour !== 12) hour += 12
  if (!isPm && hour === 12) hour = 0
  const minute = minStr != null ? minStr : '00'
  return `${String(hour).padStart(2, '0')}:${minute}`
}

/** "19:30" -> "7:30 pm", for prose. */
function timeLabel(hhmm) {
  if (!hhmm) return null
  const [h, m] = hhmm.split(':').map(Number)
  const meridiem = h >= 12 ? 'pm' : 'am'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${String(m).padStart(2, '0')} ${meridiem}`
}

const STARTS_RE = /meeting\s+starts?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i
const DOORS_RE  = /doors?\s+open\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i
const ACCESS_RE = /\(([^)]*)\)/
// the colon is optional: FRIDAY has none, the other four days do
const DAY_HEADING_RE = /<strong>\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*:?\s*<\/strong>/gi
const CANCELLED_RE = /\bcancel?led\b|\bpostponed\b|\bsuspended\b/i

/**
 * Every meeting stated in the meetings block, in document order.
 *
 * Day headings and <li> items are siblings in the Divi output, so each item is
 * assigned to the nearest PRECEDING day heading by byte offset. Items with no
 * parseable start time, or whose title reads as cancelled, are dropped: we only
 * publish what we can date.
 *
 * @returns {Array<{weekday: number, weekdayName: string, title: string,
 *   startTime: string, startLabel: string, doorsTime: string|null,
 *   doorsLabel: string|null, access: string|null, zoom: boolean, text: string}>}
 */
export function parseMeetings(html = '') {
  const block = sliceMeetingsBlock(html)
  if (!block) return []

  const days = [...block.matchAll(DAY_HEADING_RE)]
    .map((m) => ({ name: m[1].toLowerCase(), index: m.index }))
  if (!days.length) return []

  const out = []
  for (const item of block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    // nearest preceding day heading wins; an item above the first heading is orphaned
    let day = null
    for (const d of days) {
      if (d.index < item.index) day = d
      else break
    }
    if (!day) continue

    const text = cleanItemText(item[1])
    if (!text) continue

    const startsMatch = text.match(STARTS_RE)
    if (!startsMatch) continue
    const startTime = to24h(startsMatch[1], startsMatch[2], startsMatch[3])
    if (!startTime) continue

    const doorsMatch = text.match(DOORS_RE)
    const doorsTime = doorsMatch ? to24h(doorsMatch[1], doorsMatch[2], doorsMatch[3]) : null

    const accessMatch = text.match(ACCESS_RE)
    const access = accessMatch ? accessMatch[1].trim() || null : null

    // the title is whatever precedes the earliest of the three trailing parts
    const bounds = [accessMatch?.index, doorsMatch?.index, startsMatch.index]
      .filter((i) => typeof i === 'number')
    const title = text.slice(0, Math.min(...bounds)).replace(/[\s\-–—|]+$/, '').trim()
    if (!title) continue
    if (CANCELLED_RE.test(title)) continue

    out.push({
      weekday: WEEKDAY[day.name],
      weekdayName: day.name,
      title,
      startTime,
      startLabel: timeLabel(startTime),
      doorsTime,
      doorsLabel: timeLabel(doorsTime),
      access,
      zoom: /\bzoom\b/i.test(text),
      text,
    })
  }
  return out
}

/**
 * The street address as STATED on the page, a drift guard rather than the
 * source of truth (VENUE_DETAILS is verified by hand). The page writes
 * "916 Kenmore Blvd.," with a trailing abbreviation period that our stored
 * address omits, so the period is trimmed before comparison.
 */
export function parseStatedAddress(html = '') {
  const text = cleanItemText(sliceMeetingsBlock(html) || html)
  const m = text.match(/located\s+at\s+([^,]+),\s*([A-Za-z .']+),\s*(?:Ohio|OH)\s+(\d{5})/i)
  if (!m) return null
  return {
    address: m[1].trim().replace(/\.$/, ''),
    city: m[2].trim(),
    state: 'OH',
    zip: m[3],
  }
}

/**
 * True only when the page itself states that attendance is free. Never assumed:
 * if the house starts charging and drops the sentence, the next scrape stops
 * publishing a zero price.
 */
export function parseFreeAdmission(html = '') {
  return /attendance\s+is\s+free/i.test(cleanItemText(html))
}

/** "Men Only" -> "Men only." */
function sentenceCase(text) {
  const lower = text.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * The page's access label rendered as prose. "Open - Women Only" becomes
 * "Open meeting. Women only." An absent label yields nothing at all, because
 * the Friday meeting states none and we do not infer one from its siblings.
 */
function accessSentences(access) {
  if (!access) return []
  return access
    .split(/\s*[–—-]\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^(open|closed)$/i.test(part) ? `${sentenceCase(part)} meeting.` : `${sentenceCase(part)}.`))
}

/**
 * The published description, assembled only from parsed parts. The rules
 * section's "kid-friendly space" sentence is deliberately excluded: it is a
 * building policy and it flips the family facet inference to true.
 */
export function buildDescription(meeting, freeStated) {
  const parts = [
    `${meeting.title} at The JADFA House, a recovery and community center at ` +
    `916 Kenmore Blvd. in Akron's Kenmore neighborhood.`,
    meeting.doorsLabel
      ? `Meeting starts at ${meeting.startLabel}; doors open at ${meeting.doorsLabel}.`
      : `Meeting starts at ${meeting.startLabel}.`,
    ...accessSentences(meeting.access),
  ]
  if (meeting.zoom) parts.push('Also available on Zoom.')
  if (freeStated) parts.push('Attendance is free.')
  return parts.join(' ')
}

/**
 * Expand every parsed meeting into its next OCCURRENCE_COUNT weekly dates and
 * return ready-to-upsert rows (plus a non-column `ymd` for logging, which
 * main() destructures away before the write).
 */
export function buildMeetingEvents(html, now = new Date()) {
  const meetings = parseMeetings(html)
  if (!meetings.length) return []
  const freeStated = parseFreeAdmission(html)

  const rows = []
  // ids already issued in THIS run, so a weekday+time clash gets a suffix
  // instead of one meeting silently upserting over the other
  const claimed = new Set()

  for (const meeting of meetings) {
    const description = buildDescription(meeting, freeStated)
    const isAA = /\bAA\b/.test(meeting.title)
    const hhmm = meeting.startTime.replace(':', '')
    for (const ymd of nextWeeklyOccurrences(meeting.weekday, { count: OCCURRENCE_COUNT, now })) {
      const base = `meeting-${meeting.weekdayName}-${hhmm}-${ymd}`
      let sourceId = base
      for (let n = 2; claimed.has(sourceId); n++) sourceId = `${base}-${n}`
      claimed.add(sourceId)
      rows.push({
        ymd,
        title:           meeting.title,          // page verbatim, typo included
        description,
        start_at:        easternToIso(ymd, meeting.startTime),
        end_at:          null,                   // the page states no end time
        category:        'civic',
        tags:            ['jadfa-house', 'kenmore', 'akron', 'recovery', 'support-group',
          meeting.weekdayName, ...(isAA ? ['aa'] : [])],
        price_min:       freeStated ? 0 : null,  // parsed from the page, never assumed
        price_max:       freeStated ? 0 : null,
        is_family:       false,                  // explicit: overrides the kid-friendly inference
        age_restriction: 'not_specified',        // sex restrictions are not age restrictions
        image_url:       null,                   // no per-meeting imagery on the page
        ticket_url:      PAGE_URL,
        source:          SOURCE_KEY,
        source_id:       sourceId,   // bare unless a weekday+time twin claimed it first
        status:          'published',
        featured:        false,
      })
    }
  }
  return rows
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🏠  Starting The JADFA House ingestion…')
  const start = Date.now()
  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, {
        website: VENUE_DETAILS.website,
        description: HOUSE_DESCRIPTION,
      }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    await linkOrganizationVenue(organizerId, venueId)

    const html = await fetchPage(PAGE_URL)

    const stated = parseStatedAddress(html)
    if (!stated || stated.address !== VENUE_DETAILS.address || stated.city !== VENUE_DETAILS.city) {
      console.warn('  ⚠ Page address drifted from VENUE_DETAILS:', JSON.stringify(stated))
    }

    const meetings = parseMeetings(html)
    if (meetings.length < MIN_EXPECTED_MEETINGS) {
      console.error(`  ✖ Only ${meetings.length} meetings parsed (expected at least ${MIN_EXPECTED_MEETINGS}).`)
      throw new Error(
        `jadfa_house: parsed ${meetings.length} meetings, below the ${MIN_EXPECTED_MEETINGS} floor ` +
        '(page layout or the Our Meetings block bound has changed)',
      )
    }

    const events = buildMeetingEvents(html)
    console.log(`  ${PAGE_URL} → ${meetings.length} weekly meetings, ${events.length} occurrences`)

    const seenSourceIds = new Set()
    let inserted = 0, skipped = 0
    for (const ev of events) {
      const { ymd, ...row } = ev
      if (!row.start_at || Date.parse(row.start_at) < Date.now() - 3 * 3600_000) { skipped++; continue }
      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed "${row.title}" (${ymd}):`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        seenSourceIds.add(row.source_id)
        inserted++
      }
    }

    // ── Stale-row cleanup ────────────────────────────────────────────────
    // source_id embeds the weekday, start time and date, so a rescheduled
    // meeting upserts under a NEW id and the old future rows become orphans.
    // The LIKE scopes the sweep to recurrence rows only, so a future dated-
    // events pass on the same source key would be untouched. Guard first: never
    // sweep after a suspiciously small parse.
    if (seenSourceIds.size >= MIN_EXPECTED_MEETINGS * 4) {
      const { data: staleRows, error: staleErr } = await supabaseAdmin
        .from('events')
        .select('id, source_id, title')
        .eq('source', SOURCE_KEY)
        .gte('start_at', new Date().toISOString())
        .like('source_id', 'meeting-%')
      if (staleErr) {
        console.warn('  ⚠ Stale sweep query failed:', staleErr.message)
      } else {
        const stale = (staleRows ?? []).filter((r) => !seenSourceIds.has(r.source_id))
        if (stale.length) {
          const { error: delErr } = await supabaseAdmin
            .from('events')
            .delete()
            .in('id', stale.map((r) => r.id))
          if (delErr) console.warn('  ⚠ Stale delete failed:', delErr.message)
          else {
            console.log(`  🧹 Removed ${stale.length} stale meeting rows no longer on the page:`)
            stale.forEach((r) => console.log(`     - ${r.title} (${r.source_id})`))
          }
        }
      }
    } else {
      console.warn(`  ⚠ Only ${seenSourceIds.size} rows upserted, skipping stale sweep (page layout may have changed).`)
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: events.length, durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s: ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
