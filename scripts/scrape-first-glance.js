/**
 * scrape-first-glance.js
 *
 * First Glance Student Center — a youth/student center at 943 Kenmore Blvd in
 * Akron's Kenmore neighborhood. We previously only saw First Glance events
 * indirectly through the Better Kenmore aggregator; this is the direct source.
 *
 * Platform: WordPress (firstglance.org). There is NO events calendar plugin —
 * instead each recurring program is a `/program/<slug>/` page with a fixed
 * weekly schedule line ("Thursdays 7:00-9:00pm") under the title, plus an
 * og:description and og:image. The `/programs/` index links every program.
 *
 * Strategy:
 *   1. GET /programs/, collect every distinct /program/<slug>/ URL.
 *   2. GET each program page; parse title, the weekly schedule line, the
 *      description (og:description) and image (og:image).
 *   3. Expand each program's weekly schedule into individual dated occurrences
 *      for a rolling horizon (WEEKS_AHEAD). Programs with no parseable schedule
 *      line are skipped — we only publish what we can actually date.
 *
 * We reflect First Glance's own published schedule and link back to their page,
 * so users can always verify. Price is left NULL — the pages state no price and
 * we never assume free.
 *
 * Usage:   node scripts/scrape-first-glance.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  inferCategory,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'

// ── Constants ────────────────────────────────────────────────────────────────

const SOURCE_KEY   = 'first_glance'
const BASE_URL     = 'https://firstglance.org'
const PROGRAMS_URL = `${BASE_URL}/programs/`
const WEEKS_AHEAD  = 8
const USER_AGENT   = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const VENUE_INFO = {
  name:    'First Glance',
  address: '943 Kenmore Blvd',
  city:    'Akron',
  state:   'OH',
  zip:     '44314',
  lat:     41.0440,
  lng:     -81.5577,
  neighborhood_slug: 'kenmore',
  website: BASE_URL,
  description: 'Youth and student center in Akron\'s Kenmore neighborhood, offering after-school and community programs for over 25 years.',
  parking_type:  'street',
  parking_notes: 'On-street parking along Kenmore Blvd.',
}

const ORG_INFO = {
  name: 'First Glance Student Center',
  details: {
    website: BASE_URL,
    description: 'A youth/student center in the Kenmore neighborhood of Akron connecting students and families to the community.',
  },
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

/** Read a <meta property|name="…" content="…"> value. */
export function getMeta(html, key) {
  const tag = String(html || '').match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i'),
  )
  const content = tag?.[0].match(/content=["']([\s\S]*?)["']\s*\/?>/i)?.[1]
  return content ? content.trim() : null
}

/** Distinct /program/<slug>/ URLs from the programs index. */
export function parseProgramUrls(html) {
  const seen = new Set()
  for (const m of String(html || '').matchAll(/href="([^"]*\/program\/([^"/?#]+)\/?)"/gi)) {
    const slug = m[2].toLowerCase()
    seen.add(`${BASE_URL}/program/${slug}/`)
  }
  return [...seen]
}

// ── Schedule parsing ─────────────────────────────────────────────────────────

const DOW = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

/** "7:00" + "pm" → "19:00:00". Missing am/pm on an after-school program is
 *  treated as PM for hours 1–11 (these run afternoons/evenings). */
export function to24h(hm, ampm) {
  const m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = m[2]
  const pm = ampm ? /pm/i.test(ampm) : h < 12 // default PM when unspecified
  if (h === 12) h = pm ? 12 : 0
  else if (pm) h += 12
  if (h > 23) return null
  return `${String(h).padStart(2, '0')}:${min}:00`
}

/**
 * Parse a schedule line like "Thursdays 7:00-9:00pm" or
 * "Tuesdays & Thursdays 6:00-8:00pm" into { days:[dow…], start, end }.
 * Returns null when no day OR no time range is present.
 */
export function parseScheduleLine(text) {
  if (!text) return null
  const lower = String(text).toLowerCase()

  const days = []
  for (const [name, idx] of Object.entries(DOW)) {
    if (new RegExp(`\\b${name}s?\\b`).test(lower)) days.push(idx)
  }
  if (!days.length) return null

  const tm = lower.match(/(\d{1,2}:\d{2})\s*(am|pm)?\s*[-–—]\s*(\d{1,2}:\d{2})\s*(am|pm)?/)
  if (!tm) return null

  const startAmPm = tm[2] || tm[4] || null
  const endAmPm   = tm[4] || tm[2] || null
  const start = to24h(tm[1], startAmPm)
  const end   = to24h(tm[3], endAmPm)
  if (!start) return null

  return { days: [...new Set(days)].sort((a, b) => a - b), start, end }
}

/** Parse a /program/ detail page into its event-shaping fields. */
export function parseProgramPage(html, url = '') {
  const ogTitle = getMeta(html, 'og:title') || ''
  const title = ogTitle.replace(/\s*[-–|]\s*First Glance.*$/i, '').trim()
    || (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim()

  const description = getMeta(html, 'og:description')
  const imageUrl    = getMeta(html, 'og:image')

  // The schedule line is short free text near the title; find the first
  // "<day(s)> <time>-<time>" pattern in the stripped body.
  const body = stripHtml(html)
  const schedM = body.match(
    /((?:sun|mon|tues|wednes|thurs|fri|satur)days?(?:\s*(?:&|and|,|\/)\s*(?:sun|mon|tues|wednes|thurs|fri|satur)days?)*)\s+(\d{1,2}:\d{2}\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}:\d{2}\s*(?:am|pm)?)/i,
  )
  const schedule = schedM ? parseScheduleLine(`${schedM[1]} ${schedM[2]}`) : null

  const slug = url.match(/\/program\/([^/]+)\//)?.[1] ?? null
  return { slug, title, description, imageUrl, schedule }
}

// ── Eastern-anchored recurrence ──────────────────────────────────────────────
// Anchor to America/New_York calendar dates (NOT local/UTC) so evening runs
// don't roll an occurrence to the wrong day — see the project's repeated
// local-Date/UTC off-by-one fixes.

export function easternTodayYmd(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/** Add days to a YYYY-MM-DD using a noon-UTC anchor (DST-safe). */
export function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10)
}

/** Day-of-week (0=Sun) for a YYYY-MM-DD, evaluated at noon UTC (stable). */
export function weekdayOfYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()
}

/**
 * Expand a weekly schedule into dated occurrences for the next `weeks` weeks.
 * One occurrence per scheduled weekday per week, starting from today (ET).
 */
export function generateOccurrences(schedule, weeks = WEEKS_AHEAD, todayYmd = easternTodayYmd()) {
  if (!schedule?.days?.length) return []
  const todayDow = weekdayOfYmd(todayYmd)
  const out = []
  for (const dow of schedule.days) {
    const offset = (dow - todayDow + 7) % 7
    const firstYmd = addDaysYmd(todayYmd, offset)
    for (let i = 0; i < weeks; i++) {
      out.push({ dateYmd: addDaysYmd(firstYmd, i * 7), start: schedule.start, end: schedule.end })
    }
  }
  return out.sort((a, b) => a.dateYmd.localeCompare(b.dateYmd))
}

// ── Process ──────────────────────────────────────────────────────────────────

async function processPrograms(programPages, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const { url, html } of programPages) {
    const prog = parseProgramPage(html, url)
    if (!prog.title || !prog.schedule) { skipped++; continue }

    const category = inferCategory(prog.title, prog.description ?? '')
    const dayTag = Object.keys(DOW).find((k) => DOW[k] === prog.schedule.days[0])
    const tags = ['first-glance', 'kenmore', 'akron', 'youth', 'student-program']
    if (dayTag) tags.push(dayTag)

    for (const occ of generateOccurrences(prog.schedule)) {
      try {
        const startAt = easternToIso(`${occ.dateYmd} ${occ.start}`)
        if (!startAt) { skipped++; continue }
        const endAt = occ.end ? easternToIso(`${occ.dateYmd} ${occ.end}`) : null

        const row = {
          title:           prog.title,
          description:     prog.description || null,
          start_at:        startAt,
          end_at:          endAt,
          category,
          is_family:       true, // youth/student center programming
          tags,
          price_min:       null, // never assume free — pages state no price
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       prog.imageUrl || null,
          ticket_url:      url,
          source:          SOURCE_KEY,
          source_id:       `${SOURCE_KEY}-${prog.slug}-${occ.dateYmd}`,
          status:          'published',
          featured:        false,
        }

        const enriched = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enriched)
        if (error) { console.warn(`  ⚠ Upsert failed for "${prog.title}" @ ${occ.dateYmd}: ${error.message}`); skipped++; continue }

        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${prog.title}" @ ${occ.dateYmd}: ${err.message}`)
        skipped++
      }
    }
  }
  return { inserted, skipped }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🧑‍🎓  Starting First Glance ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization(ORG_INFO.name, ORG_INFO.details)
    const venueId = await ensureVenue(VENUE_INFO.name, {
      address: VENUE_INFO.address, city: VENUE_INFO.city, state: VENUE_INFO.state,
      zip: VENUE_INFO.zip, lat: VENUE_INFO.lat, lng: VENUE_INFO.lng,
      neighborhood_slug: VENUE_INFO.neighborhood_slug, website: VENUE_INFO.website,
      description: VENUE_INFO.description, parking_type: VENUE_INFO.parking_type,
      parking_notes: VENUE_INFO.parking_notes,
    })
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    console.log(`\n🔍  Fetching ${PROGRAMS_URL}…`)
    const indexHtml = await fetchHtml(PROGRAMS_URL)
    const urls = parseProgramUrls(indexHtml)
    console.log(`  Found ${urls.length} program page(s)`)

    const programPages = []
    for (const url of urls) {
      try { programPages.push({ url, html: await fetchHtml(url) }) }
      catch (err) { console.warn(`  ⚠ Failed to fetch ${url}: ${err.message}`) }
      await new Promise((r) => setTimeout(r, 150))
    }

    console.log(`\n📥  Processing ${programPages.length} programs…`)
    const { inserted, skipped } = await processPrograms(programPages, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: programPages.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
