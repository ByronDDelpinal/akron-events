/**
 * scrape-life-gurukula.js
 *
 * Fetches upcoming events from Life Gurukula — a Vedanta retreat center and
 * residential community at 1230 W. Market St in Akron.
 *
 * Platform: WordPress + The Events Calendar (Tribe). The events page exposes
 * the standard Tribe ICS feed (?ical=1).
 *
 * 403 handling: lifegurukula.org sits behind a security plugin (Wordfence-
 * style) that blocks generic "bot" User-Agents on the ICS endpoint with a
 * 403. The fix has two layers:
 *   1. Default path — plain `fetch` with a realistic Chrome UA + browser-y
 *      headers (Accept-Language, Sec-Fetch-*, Referer pointing back at
 *      /events/). This is cheap and works against simple UA gates.
 *   2. Puppeteer fallback — if the simple fetch still 403s (e.g. a JS
 *      challenge was issued), we render the /events/ page in headless Chrome
 *      so any cookie gets set, then fetch the ICS URL from inside that page
 *      context. Same approach as scrape-akron-symphony.js.
 *
 * Usage:
 *   node scripts/scrape-life-gurukula.js
 *
 * Environment overrides:
 *   LIFE_GURUKULA_ICS_URL — direct ICS feed URL (skip default)
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { runIcsScraper } from './lib/ics.js'
import { withBrowser, newConfiguredPage } from './lib/puppeteer.js'

const SOURCE_KEY = 'life_gurukula'

const EVENTS_PAGE_URL = 'https://lifegurukula.org/events/'

// The Tribe ICS endpoint. The list-view query string returns all upcoming
// events instead of just the current month, so multi-day retreats and
// future-dated programming both flow in.
const ICS_URL =
  process.env.LIFE_GURUKULA_ICS_URL ||
  'https://lifegurukula.org/?post_type=tribe_events&ical=1&eventDisplay=list'

// Realistic Chrome-on-Mac fingerprint. Matches the default UA inside
// lib/puppeteer.js so the simple-fetch path and the headless-Chrome path
// look identical to the origin.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function mapCategory(ev) {
  const text = [(ev.SUMMARY || ''), (ev.DESCRIPTION || ''), (ev.CATEGORIES || '')]
    .join(' ').toLowerCase()
  if (/\b(yoga|meditat|pranayama|asana|chant|kirtan)\b/.test(text))      return 'fitness'
  if (/\b(class|workshop|discourse|lecture|study|course)\b/.test(text))  return 'education'
  if (/\b(festival|celebration|puja|prayer)\b/.test(text))                return 'community'
  if (/\b(food|meal|dinner|lunch|brunch)\b/.test(text))                   return 'food'
  // Retreats — the most common event type — sit at the intersection of
  // education, community, and wellness; bucket them under 'community' so they
  // surface broadly rather than being hidden under a single specialty.
  return 'community'
}

function mapTags(ev) {
  const text = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''}`.toLowerCase()
  const tags = ['vedanta', 'spiritual', 'akron']
  if (/\bretreat\b/.test(text))                  tags.push('retreat')
  if (/\byoga\b/.test(text))                     tags.push('yoga')
  if (/\bmeditat/.test(text))                    tags.push('meditation')
  if (/\b(youth|chyk|chysk|teen|kids|children)\b/.test(text)) tags.push('youth')
  if (/\bfamily\b/.test(text))                   tags.push('family')
  return [...new Set(tags)]
}

// ── ICS fetch with progressive fallback ───────────────────────────────────

/**
 * Try a direct fetch with realistic browser headers. Throws on non-2xx or
 * if the body isn't iCalendar.
 */
async function fetchIcsDirect() {
  const res = await fetch(ICS_URL, {
    headers: {
      'User-Agent':      BROWSER_UA,
      'Accept':          'text/calendar, text/plain, */*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         EVENTS_PAGE_URL,
      'Sec-Fetch-Dest':  'document',
      'Sec-Fetch-Mode':  'navigate',
      'Sec-Fetch-Site':  'same-origin',
      'Sec-Fetch-User':  '?1',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} on direct fetch`)
  const text = await res.text()
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('Direct fetch returned non-iCalendar body')
  }
  return text
}

/**
 * Headless-Chrome fallback. Render /events/ first so any security-plugin
 * cookie (e.g. wfwaf-authcookie-*) gets set, then fetch the ICS URL from
 * inside the page context. The fetch inherits cookies + the realistic UA
 * already configured on the page.
 */
async function fetchIcsViaBrowser() {
  return withBrowser(async (browser) => {
    const page = await newConfiguredPage(browser, { userAgent: BROWSER_UA })
    await page.goto(EVENTS_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30_000 })
    const text = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: 'include' })
      if (!r.ok) throw new Error(`HTTP ${r.status} on browser-context fetch`)
      return r.text()
    }, ICS_URL)
    if (!text || !text.includes('BEGIN:VCALENDAR')) {
      throw new Error('Browser-context fetch returned non-iCalendar body')
    }
    return text
  })
}

async function getIcsText() {
  // 1. Cheap path first.
  try {
    const text = await fetchIcsDirect()
    console.log(`  ✓ Direct fetch succeeded (${text.length} bytes)`)
    return text
  } catch (err) {
    console.warn(`  ⚠ Direct fetch failed: ${err.message}`)
    console.warn(`  ↳ Falling back to Puppeteer with cookie reuse…`)
  }

  // 2. Headless Chrome — exchanges cookies via /events/ then fetches the ICS.
  const text = await fetchIcsViaBrowser()
  console.log(`  ✓ Puppeteer fetch succeeded (${text.length} bytes)`)
  return text
}

runIcsScraper({
  source:     SOURCE_KEY,
  getIcsText,
  organizationName: 'Life Gurukula',
  organizationDetails: {
    website:     'https://lifegurukula.org',
    description: 'Life Gurukula is a Vedanta-rooted retreat center and residential community in Akron offering retreats, classes, and workshops focused on meditation, yoga, and contemplative living.',
  },
  defaultVenueName: 'Life Gurukula',
  defaultVenueDetails: {
    address: '1230 W Market St',
    city:    'Akron',
    state:   'OH',
    zip:     '44313',
    website: 'https://lifegurukula.org',
    parking_type:  'lot',
    parking_notes: 'On-site parking available for retreat guests.',
    description:   'Vedanta retreat center and residential ashrama with a mandir, library, reflection room, dining area, dormitory rooms, and outdoor field.',
  },
  mapCategory,
  mapTags,
  defaultPriceMin: null,
  defaultPriceMax: null,
  ageRestriction:  'all_ages',
})
