/**
 * scrape-akron-rec-parks.js
 *
 * Fetches public programs from Akron Recreation & Parks (RecDesk portal).
 *
 * Platform: RecDesk SaaS — plain HTTP POST, no headless browser needed.
 * Site:     https://akron.recdesk.com/Community/Program
 *
 * The program list is populated by a jQuery AJAX POST to /FilterPrograms,
 * which returns a server-rendered HTML fragment. We replicate that POST
 * directly with node fetch (GET first to obtain the ASP.NET session cookie,
 * then POST with the cookie and standard form fields).
 *
 * HTML structure of the response (each program spans several <tr> rows):
 *   <tr><td class="category-header" colspan="7">Category: Adult Programming</td></tr>
 *   <tr class="sub-category-header ...">
 *     <td colspan="4"><a class="text-semibold text-primary" href="...?programId=1880">Title</a></td>
 *     <td colspan="3">Adult Programming</td>
 *   </tr>
 *   <tr> [optional] <td colspan="7"><div class="label-warning">Registration ended on ...</div></td> </tr>
 *   <tr class="hidden-xs no-border ...">
 *     <td><span>Dates</span><br><small class="text-muted">6/8/2026 - 7/31/2026</small></td>
 *     <td><span>Days</span><br><small class="text-muted">Mon, Tue, Wed, Thu, Fri</small></td>
 *     <td><span>Ages</span><br><small class="text-muted">7y - 12y</small></td>
 *     ...
 *   </tr>
 *
 * We produce ONE event row per program. The list fragment only carries title /
 * dates / ages, so each program's Detail page is fetched for the description,
 * fees, and the real daily start/end times (falling back to a 9 AM–5 PM
 * placeholder only when a program has no schedule table).
 *
 * Usage:
 *   node scripts/scrape-akron-rec-parks.js
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
  enrichWithImageDimensions,
  upsertEventSafe,
  setEventVenue,
  linkEventOrganization,
  ensureOrganization,
  ensureVenue,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'

// ── Constants ─────────────────────────────────────────────────────────────

const SOURCE_KEY    = 'akron_rec_parks'
const BASE_URL      = 'https://akron.recdesk.com/Community/Program'
const FILTER_URL    = 'https://akron.recdesk.com/Community/Program/FilterPrograms'
const DETAIL_BASE   = 'https://akron.recdesk.com/Community/Program/Detail?programId='
const USER_AGENT    = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const MAX_DAYS_AHEAD = 365

const VENUE_INFO = {
  name:    'Akron Recreation & Parks',
  address: '217 S. High Street',
  city:    'Akron',
  state:   'OH',
  zip:     '44308',
  website: 'https://www.akronohio.gov/departments/recreation_and_parks',
}

// ── Community-center facilities ─────────────────────────────────────────────
//
// Programs are held at one of Akron's community centers, but the list fragment
// only carries the department name — so historically EVERY program linked to
// the single "Akron Recreation & Parks" venue at the downtown admin address
// (217 S. High St, downtown-akron). That hid every program from its real
// neighborhood hub (e.g. Kenmore CC camps never reached /events/kenmore).
//
// We now read the actual facility from the Detail page's schedule and map it to
// its real address + neighborhood. Keyed by the facility name exactly as it
// appears in the schedule's Location link. Addresses pulled from RecDesk's
// facility pages (2026-06-14). neighborhood_slug is set explicitly — and is
// REQUIRED here rather than relying on coordinates, because the polygon
// resolver misclassifies the Kenmore Blvd corridor as 'summit-lake'. Two
// centers whose neighborhood is genuinely ambiguous are left unset for admin
// classification (the venue is still correct; it just won't hub yet).
const KNOWN_FACILITIES = {
  'Kenmore Community Center':           { address: '880 Kenmore Blvd',      zip: '44314', neighborhood_slug: 'kenmore' },
  'Ellet Community Center':             { address: '2449 Wedgewood Dr',     zip: '44312', neighborhood_slug: 'ellet' },
  'Firestone Park Community Center':    { address: '1480 Girard St',        zip: '44301', neighborhood_slug: 'firestone-park' },
  'Summit Lake Community Center':       { address: '380 W Crosier St',      zip: '44311', neighborhood_slug: 'summit-lake' },
  'Patterson Park Community Center':    { address: '800 Patterson Ave',     zip: '44310', neighborhood_slug: 'north-hill', lat: 41.107016, lng: -81.504164 },
  'Joy Park Community Center':          { address: '825 Fuller Ave',        zip: '44306', neighborhood_slug: 'east-akron' },
  'Reservoir Park Community Center':    { address: '1735 Hillside Terrace', zip: '44305', neighborhood_slug: 'goodyear-heights' },
  'Ed Davis Community Center':          { address: '730 Perkins Park Dr',   zip: '44320', neighborhood_slug: 'west-akron' },
  'Lawton Street Community Center':     { address: '1225 Lawton St',        zip: '44320', neighborhood_slug: 'west-akron' },
  'Mason Park Community Center':        { address: '700 E Exchange St',     zip: '44306' },
  'Northwest Family Recreation Center': { address: '1730 Shatto Ave',       zip: '44313' },
  // Addresses below verified against the city's own RecDesk facility pages
  // (akron.recdesk.com/Community/Facility/Detail) on 2026-07-08.
  'Balch Street Community Center':      { address: '220 S Balch St',        zip: '44302' },
  'Hardesty Park':                      { address: '1615 Wallhaven Dr',     zip: '44313' },
  'Cascade Valley Softball Fields':     { address: '1690 Cuyahoga St',      zip: '44313' },
}

// RecDesk usually puts the ROOM in the schedule Location cell ("Northwest Tot
// Room", "Balch Street Fitness Center", "Ellet Art & Crafts Room"), so an
// exact-match lookup misses most programs. These ordered prefixes map any
// room/variant back to its canonical KNOWN_FACILITIES entry. Longer prefixes
// first where one is a prefix of another.
const FACILITY_PREFIXES = [
  ['summit lake',    'Summit Lake Community Center'],
  ['joy park',       'Joy Park Community Center'],
  ['ed davis',       'Ed Davis Community Center'],
  ['cascade valley', 'Cascade Valley Softball Fields'],
  ['northwest',      'Northwest Family Recreation Center'],
  ['balch',          'Balch Street Community Center'],
  ['ellet',          'Ellet Community Center'],
  ['reservoir',      'Reservoir Park Community Center'],
  ['kenmore',        'Kenmore Community Center'],
  ['patterson',      'Patterson Park Community Center'],
  ['firestone',      'Firestone Park Community Center'],
  ['lawton',         'Lawton Street Community Center'],
  ['mason',          'Mason Park Community Center'],
  ['hardesty',       'Hardesty Park'],
]

/**
 * Map a raw location string (schedule Location cell, room name, or title
 * fragment) to a canonical KNOWN_FACILITIES key, or null when unknown.
 */
export function resolveFacilityName(raw) {
  if (!raw) return null
  const s = String(raw).replace(/\s+/g, ' ').trim()
  if (!s) return null
  if (KNOWN_FACILITIES[s]) return s
  const lower = s.toLowerCase()
  for (const [prefix, canonical] of FACILITY_PREFIXES) {
    if (lower.startsWith(prefix)) return canonical
  }
  return null
}

/**
 * Some programs have no schedule table, but the facility is embedded in the
 * program title — "Ellet CC - Week 1: Dinosaur Digs", "Balch St - Tuesday…",
 * "Cheernastics Camp @ Balch St.". Try the leading "Facility -" segment, then
 * a trailing "@ Facility" segment.
 */
export function facilityFromTitle(title) {
  if (!title) return null
  const lead = String(title).split(/\s+-\s+/)[0]
  const fromLead = resolveFacilityName(lead)
  if (fromLead) return fromLead
  const at = String(title).match(/@\s*([^@]+)$/)
  return at ? resolveFacilityName(at[1].replace(/[.\s]+$/, '')) : null
}

export { KNOWN_FACILITIES }

const facilityVenueCache = new Map()
const warnedUnmapped = new Set()

/**
 * Resolve a program's real community-center venue from its schedule Location,
 * falling back to a facility named in the program title. Returns a venue id,
 * or null when the facility is unknown (caller falls back to the generic
 * department venue).
 */
async function ensureFacilityVenue(locationName, title) {
  const canonical = resolveFacilityName(locationName) ?? facilityFromTitle(title)

  if (!canonical) {
    // Surface brand-new facilities in scrape logs instead of silently pinning
    // programs to the generic downtown venue.
    if (locationName && !warnedUnmapped.has(locationName) && locationName !== 'No location set') {
      warnedUnmapped.add(locationName)
      console.warn(`  ⚠ Unmapped facility location "${locationName}" — using generic department venue`)
    }
    return null
  }

  if (facilityVenueCache.has(canonical)) return facilityVenueCache.get(canonical)

  const f = KNOWN_FACILITIES[canonical]

  const id = await ensureVenue(canonical, {
    address:           f.address,
    city:              'Akron',
    state:             'OH',
    zip:               f.zip,
    neighborhood_slug: f.neighborhood_slug,
    lat:               f.lat,   // optional — ensureVenue ignores null/undefined
    lng:               f.lng,
    website:           VENUE_INFO.website,
    parking_type:      'lot',
  })
  facilityVenueCache.set(canonical, id)
  return id
}

// ── Category mapping ──────────────────────────────────────────────────────

// v2 content slugs only (see docs/tagging-audit-2026-06.md, Part 2 — the
// guard test fails CI on legacy v1 slugs). 'family' is NOT a category: tot /
// youth / camp programming carries the is_family FACET (mapIsFamily below)
// and lets text inference pick the content axis. Unmapped program types
// return null so inference decides instead of a blanket guess.
const CATEGORY_MAP = {
  'adult sports':      'sports',
  'aquatics':          'fitness',     // swim lessons / water aerobics
  'art programming':   'visual-art',
  'dance':             'learning',    // rec-center dance = classes, not staged shows
  'gymnastics':        'sports',
  'stem':              'learning',
  'summer camp':       'learning',
}

function mapCategory(programType) {
  return CATEGORY_MAP[String(programType).toLowerCase()] ?? null
}

// Tot / youth / camp program types are authoritative kid-programming signals.
// Returns true or undefined (never false) so inference can still flag others.
function mapIsFamily(programType) {
  return /^(tot programming|youth programming|summer camp)$/.test(String(programType).toLowerCase()) || undefined
}

// ── Tag builder ───────────────────────────────────────────────────────────

function buildTags(programType) {
  const tags = ['parks-recreation', 'akron', 'city-programs']
  const type = String(programType).toLowerCase()
  if (type.includes('camp'))       tags.push('summer-camp', 'family')
  if (type.includes('art'))        tags.push('arts-crafts')
  if (type.includes('gymnastics')) tags.push('gymnastics')
  if (type.includes('stem'))       tags.push('stem')
  if (type.includes('dance'))      tags.push('dance')
  if (type.includes('aquatics'))   tags.push('swimming')
  if (type.includes('tot') || type.includes('youth')) tags.push('family')
  return [...new Set(tags)]
}

// ── Age restriction mapping ───────────────────────────────────────────────

function mapAgeRestriction(agesText) {
  const m = String(agesText || '').match(/(\d+)y/)
  if (!m) return 'not_specified'
  return parseInt(m[1], 10) >= 18 ? '18_plus' : 'all_ages'
}

// ── Date parsing ──────────────────────────────────────────────────────────

/**
 * Parse "M/D/YYYY" or "M/D/YYYY - M/D/YYYY" → { startYmd, endYmd } | null.
 */
export function parseDateRange(raw) {
  const clean = String(raw || '').trim()
  const rangeM = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (rangeM) {
    return {
      startYmd: `${rangeM[3]}-${rangeM[1].padStart(2,'0')}-${rangeM[2].padStart(2,'0')}`,
      endYmd:   `${rangeM[6]}-${rangeM[4].padStart(2,'0')}-${rangeM[5].padStart(2,'0')}`,
    }
  }
  const singleM = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (singleM) {
    const ymd = `${singleM[3]}-${singleM[1].padStart(2,'0')}-${singleM[2].padStart(2,'0')}`
    return { startYmd: ymd, endYmd: ymd }
  }
  return null
}

/** "M/D/YYYY" or "MM/DD/YYYY" → "YYYY-MM-DD" | null. */
export function mdyToYmd(mdy) {
  const m = String(mdy || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

/** "9:00 AM" / "3:00 PM" → "HH:MM:SS" (24h) | null. */
export function to24h(timeStr) {
  const m = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = m[2]
  const pm = /p/i.test(m[3])
  if (h === 12) h = pm ? 12 : 0
  else if (pm) h += 12
  return `${String(h).padStart(2, '0')}:${min}:00`
}

// ── Detail-page parsing ─────────────────────────────────────────────────────

const _ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  mdash: '—', ndash: '–', hellip: '…',
}

/** Decode the HTML entities RecDesk emits in attribute/body text. */
export function decodeEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => (name.toLowerCase() in _ENTITIES ? _ENTITIES[name.toLowerCase()] : m))
}

/**
 * Description: prefer the og:description meta (a single stable attribute that
 * can't be derailed by body markup nesting), fall back to the body .well block.
 */
export function parseDescription(html) {
  const meta = String(html || '').match(/<meta[^>]*property=["']og:description["'][^>]*>/i)?.[0]
  let raw = meta?.match(/content=["']([\s\S]*?)["']\s*\/?>/i)?.[1] ?? null

  if (!raw) {
    const well = String(html || '').match(/<div[^>]*class=["']well["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
    if (well) raw = well.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  }
  if (!raw) return null

  const text = decodeEntities(raw)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}

/**
 * Fees: parse the FIRST table in #program-fees (the Standard Fee table; the
 * second table, if present, is Addon Fees and is ignored). Returns the price
 * a member of the public actually pays — the rows with NO membership
 * restriction. Membership-gated discount tiers (AMHA, YES Fund) are excluded
 * from the public price, falling back to all rows only if none are open.
 */
export function parseFees(html) {
  const seg = String(html || '').match(/id=["']program-fees["']([\s\S]*?)(?:id=["']program-schedule["']|$)/i)?.[1]
  if (!seg) return { min: null, max: null }
  const firstTable = seg.match(/<table[\s\S]*?<\/table>/i)?.[0] ?? seg

  const open = []
  const all = []
  for (const row of firstTable.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const amtM = row.match(/data-label=["']Amount["'][^>]*>\s*\$?([\d,]+\.\d{2})/i)
    if (!amtM) continue
    const amt = parseFloat(amtM[1].replace(/,/g, ''))
    if (Number.isNaN(amt)) continue
    all.push(amt)
    const memCell = row.match(/data-label=["']Membership Restrictions["']([\s\S]*?)<\/td>/i)?.[1] ?? ''
    if (!/<a[\s>]/i.test(memCell)) open.push(amt)
  }

  const pool = open.length ? open : all
  if (!pool.length) return { min: null, max: null }
  return { min: Math.min(...pool), max: Math.max(...pool) }
}

/**
 * Schedule: first/last session dates + the daily start/end times from the
 * #program-schedule table (authoritative, and holiday-aware — e.g. a camp that
 * skips Juneteenth). Returns null when the program has no schedule table.
 */
export function parseSchedule(html) {
  const seg = String(html || '').match(/id=["']program-schedule["']([\s\S]*?)$/i)?.[1]
  if (!seg) return null
  const rows = (seg.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).filter(r => /data-label=["']Date["']/i.test(r))
  if (!rows.length) return null

  const cell = (row, label) =>
    decodeEntities(row.match(new RegExp(`data-label=["']${label}["'][^>]*>\\s*([^<]+?)\\s*<`, 'i'))?.[1] ?? '').trim() || null

  const first = rows[0]
  const last = rows[rows.length - 1]

  // The Location cell wraps the facility in an <a>, so pull the anchor text
  // (or any inner text) rather than the bare-text cell() helper.
  const locM = first.match(/data-label=["']Location["'][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)
    ?? first.match(/data-label=["']Location["'][^>]*>([\s\S]*?)<\/td>/i)
  const location = locM ? decodeEntities(locM[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() || null : null

  return {
    firstDate: cell(first, 'Date'),
    lastDate:  cell(last, 'Date'),
    startTime: cell(first, 'Start Time'),
    endTime:   cell(first, 'End Time'),
    location,
  }
}

/** Parse a RecDesk program Detail page into the fields the list view omits. */
export function parseDetailHtml(html) {
  return {
    description: parseDescription(html),
    fees:        parseFees(html),
    schedule:    parseSchedule(html),
  }
}

/** GET a program's Detail page HTML (public; cookie passed for session parity). */
async function fetchProgramDetail(programId, cookie) {
  const res = await fetch(`${DETAIL_BASE}${programId}`, {
    headers: { 'User-Agent': USER_AGENT, ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`GET detail ${programId} → HTTP ${res.status}`)
  return res.text()
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

/**
 * GET the programs page and return the ASP.NET session cookie string.
 */
async function getSessionCookie() {
  const res = await fetch(BASE_URL, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`GET ${BASE_URL} → HTTP ${res.status}`)
  const setCookie = res.headers.getSetCookie?.() ?? []
  return setCookie.map(c => c.split(';')[0]).join('; ')
}

/**
 * POST /FilterPrograms for the given page number (1-indexed).
 * Returns the raw HTML fragment string.
 *
 * RecDesk expects a JSON body (application/json), not form-encoded data.
 * The payload mirrors what the page's jQuery filterPrograms() function sends.
 */
async function postFilterPrograms(cookie, pageNum = 1) {
  const PAGE_SIZE = '100'
  const body = JSON.stringify({
    ProgramName:        '',
    Code:               '',
    ProgramNameXS:      '',
    DateRangeSelection: '',
    DateRangeFrom:      '',
    DateRangeTo:        '',
    ProgramType:        '0',
    Age:                '',
    Facility:           '0',
    Days:               '0',
    ResultsPerPage:     PAGE_SIZE,
    Pagination: {
      CurrentPageIndex: pageNum,
      PageSize:         PAGE_SIZE,
      LoadMore:         false,
    },
  })

  const res = await fetch(FILTER_URL, {
    method:  'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent':       USER_AGENT,
      'Cookie':           cookie,
    },
    body,
    redirect: 'follow',
  })

  if (!res.ok) throw new Error(`POST FilterPrograms → HTTP ${res.status}`)
  return res.text()
}

// ── HTML parser ───────────────────────────────────────────────────────────

/**
 * Parse the FilterPrograms HTML fragment into an array of program objects.
 *
 * Each program spans several <tr> rows in the response:
 *   1. category-header row  → sets currentCategory
 *   2. sub-category-header  → title + programId
 *   3. (optional) registration-ended row
 *   4. hidden-xs no-border  → dates / days / ages (in <small class="text-muted">)
 *
 * We walk the <tr> blocks sequentially, maintaining a small state machine.
 */
export function parseFilterHtml(html) {
  const programs = []
  if (!html) return programs

  // Split on <tr boundaries, keeping the delimiter
  const trBlocks = html.split(/(?=<tr[\s>])/i)

  let currentCategory = ''
  let pendingProgram  = null   // program waiting for its data row

  for (const block of trBlocks) {
    const rowHtml = block.trim()
    if (!rowHtml.startsWith('<tr')) continue

    // ── Category header ────────────────────────────────────────────────
    const catM = rowHtml.match(/class="category-header"[^>]*>[\s\S]*?Category:\s*<strong>([^<]+)<\/strong>/i)
      ?? rowHtml.match(/class="category-header"[^>]*>\s*<span[^>]*>[^<]*<\/span>\s*<strong>([^<]+)<\/strong>/i)
    if (!catM) {
      // Simpler fallback: just look for "Category:" followed by text
      const fallback = rowHtml.match(/category-header[\s\S]*?>Category:\s*([^<\n]+)</i)
      if (fallback) {
        currentCategory = fallback[1].trim()
        pendingProgram  = null
        continue
      }
    } else {
      currentCategory = catM[1].trim()
      pendingProgram  = null
      continue
    }

    // ── Program title row (sub-category-header) ────────────────────────
    if (/class="sub-category-header/i.test(rowHtml)) {
      // Flush any pending program that never got a data row
      if (pendingProgram) programs.push(pendingProgram)

      const linkM = rowHtml.match(/programId=(\d+)[^"]*"[^>]*>([^<]+)<\/a>/i)
      if (linkM) {
        pendingProgram = {
          programId:   linkM[1],
          title:       linkM[2].trim(),
          programType: currentCategory,
          datesText:   '',
          agesText:    '',
        }
      }
      continue
    }

    // ── Data row (hidden-xs no-border) — dates / days / ages ──────────
    if (/class="hidden-xs no-border/i.test(rowHtml) && pendingProgram) {
      // Extract all <small class="text-muted"> values in order
      const smalls = [...rowHtml.matchAll(/<small[^>]*class="text-muted"[^>]*>([\s\S]*?)<\/small>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())

      // The cells appear in column order: Dates, Days, Ages, Grades, Openings, Remaining
      if (smalls[0]) pendingProgram.datesText = smalls[0]
      if (smalls[2]) pendingProgram.agesText  = smalls[2]

      programs.push(pendingProgram)
      pendingProgram = null
      continue
    }
  }

  // Flush any trailing program
  if (pendingProgram) programs.push(pendingProgram)

  return programs
}

// ── Fetch all pages ───────────────────────────────────────────────────────

async function fetchAllPrograms(cookie) {
  const all    = []
  let   page   = 1

  for (;;) {
    const html     = await postFilterPrograms(cookie, page)
    const programs = parseFilterHtml(html)

    if (programs.length === 0) break
    all.push(...programs)

    // RecDesk returns up to 100 per page; if we got fewer we're done
    if (programs.length < 100) break
    page++
  }

  return all
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🏊  Starting Akron Rec & Parks ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization('Akron Recreation & Parks', {
      website:     VENUE_INFO.website,
      description: 'City of Akron Recreation & Parks offers programs, camps, classes, and sports leagues at community centers across Akron.',
    })

    const venueId = await ensureVenue(VENUE_INFO.name, {
      address: VENUE_INFO.address,
      city:    VENUE_INFO.city,
      state:   VENUE_INFO.state,
      zip:     VENUE_INFO.zip,
      website: VENUE_INFO.website,
    })

    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const cookie      = await getSessionCookie()
    const rawPrograms = await fetchAllPrograms(cookie)
    console.log(`  Found ${rawPrograms.length} program(s)`)

    const now          = new Date()
    const cutoffFuture = new Date(now.getTime() + MAX_DAYS_AHEAD * 86_400_000)
    let inserted = 0, skipped = 0

    for (const prog of rawPrograms) {
      try {
        // ── Date window (list page) — cheap gate before fetching the detail.
        const listDates = parseDateRange(prog.datesText)
        if (!listDates) { skipped++; continue }

        if (new Date(listDates.endYmd + 'T23:59:59') < now)            { skipped++; continue }
        if (new Date(listDates.startYmd + 'T00:00:00') > cutoffFuture) { skipped++; continue }

        // ── Detail page — description, fees, and authoritative session times.
        // The list fragment carries none of these, so each program needs a GET.
        let detail = {}
        if (prog.programId) {
          try {
            detail = parseDetailHtml(await fetchProgramDetail(prog.programId, cookie))
          } catch (err) {
            console.warn(`  ⚠ Detail fetch failed for "${prog.title}": ${err.message}`)
          }
          await new Promise(r => setTimeout(r, 150))
        }

        // Prefer the schedule's real dates/times; fall back to the list range
        // with the legacy 9–5 placeholder when no schedule table is present.
        const sched     = detail.schedule
        const startYmd  = (sched?.firstDate && mdyToYmd(sched.firstDate)) || listDates.startYmd
        const endYmd    = (sched?.lastDate  && mdyToYmd(sched.lastDate))  || listDates.endYmd
        const startTime = (sched?.startTime && to24h(sched.startTime)) || '09:00:00'
        const endTime   = (sched?.endTime   && to24h(sched.endTime))   || '17:00:00'

        const startAt = easternToIso(`${startYmd} ${startTime}`)
        if (!startAt) { skipped++; continue }

        // Multi-day → end on the last day; single-day → only set an end when we
        // actually have a real end time from the schedule (else leave null).
        const endAt = endYmd !== startYmd
          ? easternToIso(`${endYmd} ${endTime}`)
          : (sched?.endTime ? easternToIso(`${startYmd} ${endTime}`) : null)

        const row = {
          title:           prog.title,
          description:     detail.description ?? null,
          start_at:        startAt,
          end_at:          endAt,
          category:        mapCategory(prog.programType),
          is_family:       mapIsFamily(prog.programType),
          tags:            buildTags(prog.programType),
          price_min:       detail.fees?.min ?? null,
          price_max:       detail.fees?.max ?? null,
          age_restriction: mapAgeRestriction(prog.agesText),
          image_url:       null,
          ticket_url:      prog.programId ? `${DETAIL_BASE}${prog.programId}` : BASE_URL,
          source:          SOURCE_KEY,
          source_id:       `${SOURCE_KEY}-${prog.programId}`,
          status:          'published',
          featured:        false,
        }

        // Prefer the program's real community-center venue (from the schedule
        // Location, or a facility named in the title); fall back to the
        // generic department venue when unknown.
        const facilityVenueId = await ensureFacilityVenue(sched?.location, prog.title)
        const eventVenueId    = facilityVenueId || venueId

        const enriched = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enriched)

        if (error) {
          console.warn(`  ⚠ Upsert failed for "${prog.title}": ${error.message}`)
          skipped++
        } else {
          // setEventVenue (not linkEventVenue) so re-scrapes move existing
          // programs OFF the old generic downtown venue onto their real center.
          await setEventVenue(upserted.id, eventVenueId)
          await linkEventOrganization(upserted.id, organizerId)
          inserted++
        }
      } catch (err) {
        console.warn(`  ⚠ Error on "${prog.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawPrograms.length,
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
