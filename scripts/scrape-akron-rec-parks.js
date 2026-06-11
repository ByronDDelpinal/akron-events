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
 * We produce ONE event row per program: start_at = program start at 9 AM ET,
 * end_at = program end date at 5 PM ET (null for single-day programs).
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
  linkEventVenue,
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

async function fetchAllPrograms() {
  const cookie = await getSessionCookie()
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

    const rawPrograms = await fetchAllPrograms()
    console.log(`  Found ${rawPrograms.length} program(s)`)

    const now          = new Date()
    const cutoffFuture = new Date(now.getTime() + MAX_DAYS_AHEAD * 86_400_000)
    let inserted = 0, skipped = 0

    for (const prog of rawPrograms) {
      try {
        const parsed = parseDateRange(prog.datesText)
        if (!parsed) { skipped++; continue }

        const { startYmd, endYmd } = parsed

        if (new Date(endYmd + 'T23:59:59') < now)            { skipped++; continue }
        if (new Date(startYmd + 'T00:00:00') > cutoffFuture) { skipped++; continue }

        const startAt = easternToIso(`${startYmd} 09:00:00`)
        if (!startAt) { skipped++; continue }

        const endAt = endYmd !== startYmd ? easternToIso(`${endYmd} 17:00:00`) : null

        const row = {
          title:           prog.title,
          description:     null,
          start_at:        startAt,
          end_at:          endAt,
          category:        mapCategory(prog.programType),
          is_family:       mapIsFamily(prog.programType),
          tags:            buildTags(prog.programType),
          price_min:       null,
          price_max:       null,
          age_restriction: mapAgeRestriction(prog.agesText),
          image_url:       null,
          ticket_url:      prog.programId ? `${DETAIL_BASE}${prog.programId}` : BASE_URL,
          source:          SOURCE_KEY,
          source_id:       `${SOURCE_KEY}-${prog.programId}`,
          status:          'published',
          featured:        false,
        }

        const enriched = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enriched)

        if (error) {
          console.warn(`  ⚠ Upsert failed for "${prog.title}": ${error.message}`)
          skipped++
        } else {
          await linkEventVenue(upserted.id, venueId)
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
