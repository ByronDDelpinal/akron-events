/**
 * scrape-north-hill-cdc.js
 *
 * Fetches North Hill Community Development Corporation events from their
 * public iCalendar feed (WordPress + The Events Calendar / Tribe).
 *
 * Bot-protection handling (two layers, same as scrape-life-gurukula.js):
 *   1. Direct fetch with realistic Chrome headers against each candidate
 *      feed URL. This stopped working ~2026-07: SiteGround now serves an
 *      HTTP 202 meta-refresh to /.well-known/sgcaptcha/ (a passive JS
 *      challenge) to ALL non-browser clients regardless of headers.
 *   2. Puppeteer fallback — render /events/ in headless Chrome, wait for
 *      the sgcaptcha challenge to clear (it sets a clearance cookie and
 *      redirects back), then fetch the ICS URL from inside the page
 *      context so the cookie is sent.
 *
 * Usage:
 *   node scripts/scrape-north-hill-cdc.js
 *
 * Environment overrides:
 *   NORTH_HILL_CDC_ICS_URL — direct ICS feed URL (tried first)
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { inferCategory } from './lib/category-inference.js'
import { runIcsScraper } from './lib/ics.js'
import { withBrowser, newConfiguredPage } from './lib/puppeteer.js'

const SOURCE_KEY = 'north_hill_cdc'

const EVENTS_PAGE_URL = 'https://northhillcdc.org/events/'

// Candidate feed URLs, tried in order. The list-view feed returns all
// upcoming events; /events/?ical=1 (month view) is a narrower fallback.
// Both verified serving text/calendar as of 2026-07-01.
const FEED_CANDIDATES = [...new Set([
  process.env.NORTH_HILL_CDC_ICS_URL,
  'https://northhillcdc.org/?post_type=tribe_events&ical=1&eventDisplay=list',
  'https://northhillcdc.org/events/?ical=1',
].filter(Boolean))]

// Realistic Chrome-on-Mac fingerprint — matches scrape-life-gurukula.js /
// lib/puppeteer.js so we look identical to a normal browser to the WAF.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Fetch one candidate feed URL with browser-like headers; throw unless ICS. */
async function fetchFeedCandidate(url) {
  const res = await fetch(url, {
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('non-iCalendar body (no BEGIN:VCALENDAR marker)')
  }
  return text
}

/**
 * Headless-Chrome fallback for the SiteGround sgcaptcha challenge.
 * Render /events/ first so the passive JS challenge runs and sets its
 * clearance cookie, then fetch each candidate feed URL from inside the
 * page context (inherits cookies + the realistic UA on the page).
 */
async function fetchIcsViaBrowser() {
  return withBrowser(async (browser) => {
    const page = await newConfiguredPage(browser, { userAgent: BROWSER_UA })
    await page.goto(EVENTS_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30_000 })

    // The sgcaptcha interstitial is a PASSIVE check for normal browsers: it
    // runs, sets a clearance cookie, and redirects back within a few seconds.
    // waitForFunction resolves instantly when we're not on the challenge.
    try {
      await page.waitForFunction(
        () =>
          !/\/\.well-known\/(?:sgcaptcha|captcha)\//.test(location.href) &&
          !/robot challenge/i.test(document.title || ''),
        { timeout: 25_000, polling: 500 },
      )
    } catch {
      throw new Error(
        'sgcaptcha challenge did not clear within 25s — likely an interactive ' +
        'CAPTCHA was served to the headless browser rather than the passive ' +
        'JS challenge a normal browser receives.',
      )
    }

    // The challenge may redirect to the site root; return to /events/ so the
    // in-page fetches below are same-origin with the clearance cookie set.
    if (!page.url().includes('/events')) {
      await page.goto(EVENTS_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30_000 })
    }

    const failures = []
    for (const url of FEED_CANDIDATES) {
      const text = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'include' })
        if (!r.ok) return { error: `HTTP ${r.status}` }
        return { body: await r.text() }
      }, url)
      if (text.body && text.body.includes('BEGIN:VCALENDAR')) return text.body
      failures.push(`${url} → ${text.error || 'non-iCalendar body'}`)
    }
    throw new Error(`Browser-context fetch failed for all candidates:\n  ${failures.join('\n  ')}`)
  })
}

async function getIcsText() {
  // 1. Cheap path: direct fetch with browser-like headers.
  const failures = []
  for (const url of FEED_CANDIDATES) {
    try {
      const text = await fetchFeedCandidate(url)
      console.log(`  ✓ Feed fetch succeeded: ${url} (${text.length} bytes)`)
      return text
    } catch (err) {
      console.warn(`  ⚠ Feed candidate failed: ${url} → ${err.message}`)
      failures.push(`${url} → ${err.message}`)
    }
  }

  // 2. Headless Chrome — clears the sgcaptcha challenge, then fetches with cookies.
  console.warn('  ↳ All direct fetches failed; falling back to Puppeteer…')
  try {
    const text = await fetchIcsViaBrowser()
    console.log(`  ✓ Puppeteer fetch succeeded (${text.length} bytes)`)
    return text
  } catch (err) {
    failures.push(`puppeteer → ${err.message}`)
  }

  throw new Error(
    `All North Hill CDC ICS feed candidates failed (direct + puppeteer):\n  ${failures.join('\n  ')}\n` +
    `Verify the subscribe link on ${EVENTS_PAGE_URL} and update FEED_CANDIDATES ` +
    `or set NORTH_HILL_CDC_ICS_URL.`
  )
}

// Category: infer from event text.
function mapCategory(ev) {
  const text = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''} ${ev.CATEGORIES || ''}`
  return inferCategory(text, '')
}

function mapTags(ev) {
  const summary = (ev.SUMMARY || '').toLowerCase()
  const tags = ['community', 'akron']
  if (summary.includes('maker monday')) tags.push('maker-monday')
  return [...new Set(tags)]
}

runIcsScraper({
  source: SOURCE_KEY,
  getIcsText,
  organizationName: 'North Hill Community Development Corporation',
  organizationDetails: {
    website:     'https://northhillcdc.org',
    description: 'North Hill CDC is a neighborhood-based nonprofit supporting residents, small businesses, and civic engagement in the North Hill area of Akron.',
  },
  defaultVenueDetails: { city: 'Akron', state: 'OH' },
  mapCategory,
  mapTags,
  defaultPriceMin: null,
  defaultPriceMax: null,
  ageRestriction:  'all_ages',
})
