/**
 * scrape-akron-symphony.js
 *
 * Fetches Akron Symphony Orchestra events from their iCalendar feed.
 *
 * Platform: WordPress + The Events Calendar (Tribe) on akronsymphony.org.
 * The entire site sits behind a Cloudflare JS bot challenge (`__cf_bm`
 * cookie issued only after browser JS runs), so direct fetches return 403.
 * We use Puppeteer to render the page, let Cloudflare's challenge resolve,
 * then fetch the ICS feed inside the same browser context where the cookie
 * is already set.
 *
 * Strategy (in order):
 *   1. Puppeteer: navigate to the calendar page, then fetch the ICS feed
 *      from the same browser context (cookie reused). Live data path.
 *   2. Snapshot fallback at scripts/data/akron-symphony-snapshot.json — only
 *      kicks in if Puppeteer itself can't run (Chrome missing, network down).
 *      Hand-refreshable via the README in scripts/data/.
 *
 * Usage:
 *   node scripts/scrape-akron-symphony.js
 *
 * Environment overrides:
 *   AKRON_SYMPHONY_ICS_URL — direct ICS feed URL (skip discovery)
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runIcsScraper } from './lib/ics.js'
import { withBrowser, newConfiguredPage } from './lib/puppeteer.js'

const SOURCE_KEY = 'akron_symphony'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const SNAPSHOT_PATH = join(__dirname, 'data', 'akron-symphony-snapshot.json')

function mapCategory() { return 'music' }

function mapTags(ev) {
  const summary = (ev.SUMMARY || '').toLowerCase()
  const categories = (ev.CATEGORIES || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean)
  const tags = ['symphony', 'classical', 'music', 'akron']
  if (summary.includes('pops'))    tags.push('pops')
  if (summary.includes('family'))  tags.push('family')
  if (summary.includes('chamber')) tags.push('chamber')
  if (summary.includes('karaoke')) tags.push('karaoke')
  return [...new Set([...tags, ...categories])]
}

/**
 * Convert a snapshot JSON event into a synthetic VEVENT block.
 *
 * The snapshot JSON keeps dtstart/dtend as compact iCal date strings
 * ("20260603T190000" for floating local, "20260715" for all-day) so we can
 * pass them through to a synthesized VEVENT with the appropriate TZID or
 * VALUE=DATE parameter. This keeps the snapshot human-editable while
 * letting it go through the same parser as the live feed.
 */
function snapshotEventToVEvent(ev) {
  const lines = ['BEGIN:VEVENT']
  if (ev.uid)     lines.push(`UID:${ev.uid}`)
  if (ev.summary) lines.push(`SUMMARY:${escapeIcsText(ev.summary)}`)
  if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`)
  // All-day events use VALUE=DATE; timed events get TZID=America/New_York
  // (Eastern Time — Akron's local zone, matching what the Tribe feed emits).
  if (ev.dtstart) {
    if (/^\d{8}$/.test(ev.dtstart))      lines.push(`DTSTART;VALUE=DATE:${ev.dtstart}`)
    else                                  lines.push(`DTSTART;TZID=America/New_York:${ev.dtstart}`)
  }
  if (ev.dtend) {
    if (/^\d{8}$/.test(ev.dtend))        lines.push(`DTEND;VALUE=DATE:${ev.dtend}`)
    else                                  lines.push(`DTEND;TZID=America/New_York:${ev.dtend}`)
  }
  if (ev.url)        lines.push(`URL:${ev.url}`)
  if (ev.location)   lines.push(`LOCATION:${escapeIcsText(ev.location)}`)
  if (ev.categories) lines.push(`CATEGORIES:${ev.categories}`)
  lines.push('END:VEVENT')
  return lines.join('\r\n')
}

/** RFC 5545 §3.3.11 text escapes — same set parseIcs() unescapes. */
function escapeIcsText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g,  '\\n')
    .replace(/,/g,   '\\,')
    .replace(/;/g,   '\\;')
}

function snapshotToIcs(snapshot) {
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Akron Pulse Snapshot//Akron Symphony//EN',
    'CALSCALE:GREGORIAN',
  ]
  const footer = ['END:VCALENDAR']
  const bodies = (snapshot.events ?? []).map(snapshotEventToVEvent)
  return [...header, ...bodies, ...footer].join('\r\n') + '\r\n'
}

const CALENDAR_PAGE = 'https://akronsymphony.org/event/'
const ICS_URL =
  process.env.AKRON_SYMPHONY_ICS_URL ||
  'https://akronsymphony.org/?post_type=tribe_events&ical=1&eventDisplay=list'

/**
 * Fetch the ICS feed via Puppeteer. We first visit the calendar page so
 * Cloudflare can issue its `__cf_bm` cookie, then call the ICS URL with
 * fetch() from inside the same page context — that request inherits the
 * cookie and bypasses the 403.
 */
async function fetchIcsViaBrowser() {
  return withBrowser(async (browser) => {
    const page = await newConfiguredPage(browser)
    // Step 1: render the calendar page so Cloudflare hands us a cookie.
    await page.goto(CALENDAR_PAGE, { waitUntil: 'networkidle2', timeout: 30_000 })
    // Step 2: from inside the page (same origin, cookies attached), fetch
    // the ICS endpoint and return its text body.
    const icsText = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: 'include' })
      if (!r.ok) throw new Error(`HTTP ${r.status} on ICS fetch`)
      return r.text()
    }, ICS_URL)
    if (!icsText || !icsText.includes('BEGIN:VCALENDAR')) {
      throw new Error('Browser fetch returned non-ICS body')
    }
    return icsText
  })
}

/**
 * Resolve ICS text. Puppeteer first (live), snapshot fallback only if
 * Puppeteer itself can't run. The snapshot at scripts/data/ keeps the
 * pipeline functional when Chrome isn't installed (CI without browsers,
 * old environments) but it's no longer the primary path.
 */
async function getIcsText() {
  // ── 1. Puppeteer ──
  let liveError = null
  try {
    const text = await fetchIcsViaBrowser()
    console.log(`  ✓ Live ICS fetch via Puppeteer succeeded (${text.length} bytes)`)
    return text
  } catch (err) {
    liveError = err
  }

  console.warn(`  ⚠ Puppeteer fetch failed: ${liveError?.message}`)
  console.warn(`  ↳ Falling back to snapshot at ${SNAPSHOT_PATH}`)

  // ── 2. Snapshot fallback ──
  let snapshot
  try {
    const raw = readFileSync(SNAPSHOT_PATH, 'utf8')
    snapshot = JSON.parse(raw)
  } catch (err) {
    // Re-throw the live-fetch error since the snapshot is also unusable —
    // the original cause is more informative for the operator.
    throw new Error(
      `Live fetch failed (${liveError?.message}) and snapshot at ${SNAPSHOT_PATH} ` +
      `is unreadable: ${err.message}. See file header for refresh instructions.`
    )
  }

  // Warn if snapshot is older than 60 days — events past their dtstart will
  // already be filtered by useEvents (start_at > now), so a stale file
  // gracefully empties itself rather than serving fake events.
  const age = Date.now() - new Date(snapshot.fetched_at).getTime()
  const days = Math.round(age / 86400_000)
  if (days > 60) {
    console.warn(`  ⚠ Snapshot is ${days} days old — consider refreshing.`)
  } else {
    console.log(`  ✓ Snapshot loaded (${snapshot.events?.length ?? 0} events, ${days}d old)`)
  }

  return snapshotToIcs(snapshot)
}

runIcsScraper({
  source: SOURCE_KEY,
  getIcsText,
  organizationName: 'Akron Symphony Orchestra',
  organizationDetails: {
    website:     'https://akronsymphony.org',
    description: 'The Akron Symphony Orchestra is a professional orchestra serving the greater Akron community with classical, pops, and family programming throughout the season.',
  },
  defaultVenueName:    'E.J. Thomas Performing Arts Hall',
  defaultVenueDetails: {
    address: '198 Hill St', city: 'Akron', state: 'OH', zip: '44325',
    lat: 41.0756, lng: -81.5113,
    website: 'https://www.ejthomashall.com',
    parking_type: 'garage',
    parking_notes: 'Parking garages available on campus.',
  },
  mapCategory,
  mapTags,
  defaultPriceMin: 0,
  defaultPriceMax: null,
  ageRestriction:  'all_ages',
})
