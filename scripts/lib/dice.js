/**
 * Shared DICE (dice.fm) partner-API module.
 *
 * Some venues sell exclusively through DICE and embed its event-list widget
 * instead of running a native calendar. The widget fetches from DICE's partner
 * API; we hit the same endpoint directly for authoritative show times, prices,
 * and ticket links:
 *
 *   GET https://partners-endpoint.dice.fm/api/v2/events
 *       ?page[size]=N&types=linkout,event&filter[venues][]=<Venue Name>
 *       header: x-api-key: <DICE_API_KEY>   (the widget's public client key)
 *
 * DICE timestamps are absolute ISO-8601 (UTC "Z" or with an offset), so they
 * convert straight to UTC. As a defensive guard, a naive (offset-less) string
 * is routed through easternToIso() rather than misread as UTC — per the
 * project's hard-won timezone rule.
 *
 * Usage:
 *   import { fetchDiceEvents, normaliseDiceEvent, diceVenue } from './lib/dice.js'
 */

import { stripHtml, easternToIso } from './normalize.js'

const API_BASE = 'https://partners-endpoint.dice.fm/api/v2/events'
const DEFAULT_UA = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

/** Convert a DICE datetime to ISO-8601 UTC, or null. */
export function diceDateToIso(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  // Absolute instant: has a 'Z' or a ±hh:mm / ±hhmm offset.
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }
  // Naive "YYYY-MM-DD[ T]HH:MM[:SS]" — treat as Eastern wall-clock (don't assume UTC).
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/)
  if (m) return easternToIso(`${m[1]} ${m[2]}`)
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Fetch every event for a venue from the DICE partner API (paginated).
 * @param {object} opts
 *   @param {string} opts.venue   — venue name as DICE filters on it (e.g. 'Musica')
 *   @param {string} opts.apiKey  — DICE x-api-key
 *   @param {number} [opts.pageSize]
 *   @param {number} [opts.maxPages]
 */
export async function fetchDiceEvents({ venue, apiKey, pageSize = 50, maxPages = 6, userAgent = DEFAULT_UA } = {}) {
  if (!apiKey) throw new Error('DICE_API_KEY is required to call the DICE partner API')
  if (!venue) throw new Error('fetchDiceEvents: venue is required')

  let url = `${API_BASE}?page%5Bsize%5D=${pageSize}&types=linkout%2Cevent&filter%5Bvenues%5D%5B%5D=${encodeURIComponent(venue)}`
  const out = []
  for (let i = 0; i < maxPages && url; i++) {
    const res = await fetch(url, { headers: { 'x-api-key': apiKey, Accept: 'application/json', 'User-Agent': userAgent } })
    if (!res.ok) throw new Error(`DICE API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    const arr = data.data ?? data.events ?? []
    out.push(...arr)
    url = data.links?.next || null
    if (arr.length < pageSize) break
  }
  return out
}

/** Extract a flat venue record from a DICE event (defensive across shapes). */
export function diceVenue(ev) {
  const v = (Array.isArray(ev?.venues) ? ev.venues[0] : ev?.venue) || null
  if (!v) return null
  const city = typeof v.city === 'object' ? (v.city?.name ?? null) : (v.city ?? null)
  return {
    name:    (v.name ?? '').trim() || null,
    address: v.address ?? v.address_line_1 ?? null,
    city,
    lat:     v.location?.lat ?? v.latitude ?? null,
    lng:     v.location?.lng ?? v.longitude ?? null,
  }
}

/**
 * Normalize a raw DICE event into the common row shape. Field access is
 * defensive because DICE's payload varies by event type (event vs linkout).
 * Returns null if it lacks a usable start time or title.
 */
export function normaliseDiceEvent(ev, config = {}) {
  const {
    source         = 'dice',
    category       = 'music',
    mapTags        = () => [],
    ageRestriction = 'not_specified',
  } = config

  // DICE uses top-level `date`/`date_end` (no nested `dates` object).
  const startAt = diceDateToIso(ev?.date ?? ev?.dates?.event_start_date ?? ev?.start_date)
  if (!startAt) return null

  const title = String(ev?.name ?? ev?.title ?? '').trim()
  if (!title) return null

  const endAt = diceDateToIso(ev?.date_end ?? ev?.dates?.event_end_date ?? ev?.end_date)

  // Description: `description` is the rendered text; `raw_description` is a
  // fallback some events use instead.
  // `||` (not `??`) so an empty-string description falls through to raw_description.
  const rawDesc = ev?.description || ev?.raw_description || ev?.about?.description || ''
  const description = rawDesc ? (stripHtml(String(rawDesc)).slice(0, 5000) || null) : null

  // Images live under `event_images` ({landscape, portrait, square, brand}).
  // `images` is an index-keyed fallback; keep the old guesses last.
  const imagesArr = ev?.images
  const image_url =
    ev?.event_images?.landscape ?? ev?.event_images?.portrait ?? ev?.event_images?.square ??
    (Array.isArray(imagesArr) ? imagesArr[0] : imagesArr?.[0]) ??
    ev?.images?.landscape ?? ev?.image ?? null

  const ticket_url = ev?.url ?? ev?.external_url ?? ev?.share_url ?? null

  // age_limit is a free string like "All ages" / "18+" / "21+".
  const ageRaw = String(ev?.age_limit ?? '').toLowerCase()
  const age = /all ages|all-ages|family/.test(ageRaw) ? 'all_ages' : ageRestriction

  return {
    title,
    description,
    start_at:        startAt,
    end_at:          endAt,
    category,
    tags:            mapTags(ev),
    price_min:       null, // DICE `price` is null for linkout events; leave to later enrichment
    price_max:       null,
    age_restriction: age,
    image_url,
    ticket_url,
    source,
    source_id:       String(ev?.id ?? ev?.perm_name ?? '').trim() || null,
    status:          'published',
    featured:        Boolean(ev?.featured),
  }
}
