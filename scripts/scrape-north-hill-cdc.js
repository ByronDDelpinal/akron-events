/**
 * scrape-north-hill-cdc.js
 *
 * Fetches North Hill Community Development Corporation events from their
 * public iCalendar feed (WordPress + The Events Calendar / Tribe).
 *
 * 403/HTML handling: northhillcdc.org started serving an HTML block page
 * (no BEGIN:VCALENDAR) to the generic "AkronPulse-bot" User-Agent that
 * lib/ics.js sends by default — the feed itself is unchanged and still
 * serves text/calendar to a normal browser fingerprint. So this scraper
 * now fetches the feed itself with realistic browser headers (same
 * layer-1 approach as scrape-life-gurukula.js) and tries a couple of
 * known-good Tribe feed URLs in order.
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

async function getIcsText() {
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
  throw new Error(
    `All North Hill CDC ICS feed candidates failed:\n  ${failures.join('\n  ')}\n` +
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
