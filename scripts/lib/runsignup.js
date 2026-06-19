/**
 * Shared RunSignup module.
 *
 * RunSignup (runsignup.com) hosts registration pages for a large share of local
 * road races. Those pages embed a numeric `race_id`, and RunSignup exposes a
 * public REST API — `/rest/race/{race_id}?format=json`, no API key required —
 * that returns the full race object: description, start address, logo, dates.
 *
 * Many of our sources only link OUT to a RunSignup page (the Akron Promise City
 * Series, race calendars, aggregators, etc.), so this module lets any scraper
 * enrich a race from its RunSignup link in one call.
 *
 * Mirrors lib/wix-events.js / lib/squarespace.js: a scraper supplies the URL and
 * gets back normalised fields.
 *
 * Usage:
 *   import { isRunSignupUrl, fetchRunSignupRaceData } from './lib/runsignup.js'
 *   if (isRunSignupUrl(url)) {
 *     const rs = await fetchRunSignupRaceData(url)   // null on any failure
 *     // rs → { description, venueName, venueDetails, logo, bareAddress }
 *   }
 *
 * Venue note: RunSignup's `address.street` is freeform — sometimes a real venue
 * NAME ("Kohl Family YMCA"), sometimes a bare street address ("1307 E. Market
 * St."). parseRunSignupRace() flags the bare-address case (`bareAddress: true`)
 * so the caller can mint it UNLISTED via ensureVenue(name, details, {
 * allowAddressName: true, listed: false }) instead of cluttering the venues
 * directory with address-named rows.
 */

import { htmlToText, looksLikeStreetAddress } from './normalize.js'

export const RUNSIGNUP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** True when a URL points at a runsignup.com race page. */
export function isRunSignupUrl(url) {
  if (!url) return false
  try {
    return /(?:^|\.)runsignup\.com$/i.test(new URL(url).hostname)
  } catch {
    return /runsignup\.com/i.test(String(url))
  }
}

/** Pull the numeric RunSignup race_id out of a race page's HTML. */
export function extractRaceId(html) {
  const pats = [
    /raceId=(\d{3,8})/i,
    /"race_id"\s*:\s*"?(\d{3,8})/i,
    /\/Race\/(?:Info|Register)\/\?raceId=(\d{3,8})/i,
    /data-race-id="(\d{3,8})"/i,
  ]
  for (const p of pats) {
    const m = String(html || '').match(p)
    if (m) return m[1]
  }
  return null
}

/**
 * Shape a RunSignup REST `race` object into enrichment fields.
 *
 * @param {object} race — the `race` object from /rest/race/{id}
 * @returns {object|null} — { description, venueName, venueDetails, logo, bareAddress }
 */
export function parseRunSignupRace(race) {
  if (!race || typeof race !== 'object') return null
  const a = race.address || {}
  const street = String(a.street || '').trim()
  const city  = String(a.city || '').trim() || null
  const state = String(a.state || '').trim() || null
  const zip   = String(a.zipcode || '').trim() || null

  let venueName = null, venueDetails = null, bareAddress = false
  if (street) {
    if (looksLikeStreetAddress(street)) {
      // Bare street address, no formal venue name → mint UNLISTED via the caller.
      venueName = street
      venueDetails = { address: street, city, state, zip }
      bareAddress = true
    } else {
      // The street field holds a real place name (e.g. "Kohl Family YMCA").
      venueName = street
      venueDetails = { city, state, zip }
    }
  }

  const description = typeof race.description === 'string' && race.description.trim()
    ? htmlToText(race.description).slice(0, 3000) || null
    : null
  const logo = typeof race.logo_url === 'string' && /^https?:\/\//i.test(race.logo_url) ? race.logo_url : null

  return { venueName, venueDetails, description, logo, bareAddress }
}

/** Fetch the public REST race object for a numeric race_id (no API key). */
export async function fetchRunSignupRaceById(raceId, opts = {}) {
  const { userAgent = RUNSIGNUP_USER_AGENT } = opts
  const res = await fetch(`https://runsignup.com/rest/race/${raceId}?format=json`, {
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
  })
  if (!res.ok) throw new Error(`RunSignup REST HTTP ${res.status} for race ${raceId}`)
  const json = await res.json()
  return json.race || json
}

/**
 * Enrich a race from its RunSignup page URL: fetch the page, extract the
 * race_id, call the REST API, and normalise. Best-effort — returns null on any
 * failure so callers can fall back to their own data.
 *
 * @param {string} raceUrl — a runsignup.com race page URL
 * @param {object} opts — { userAgent }
 * @returns {object|null} — see parseRunSignupRace()
 */
export async function fetchRunSignupRaceData(raceUrl, opts = {}) {
  const { userAgent = RUNSIGNUP_USER_AGENT } = opts
  try {
    const res = await fetch(raceUrl, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    })
    if (!res.ok) return null
    const id = extractRaceId(await res.text())
    if (!id) return null
    return parseRunSignupRace(await fetchRunSignupRaceById(id, { userAgent }))
  } catch {
    return null
  }
}
