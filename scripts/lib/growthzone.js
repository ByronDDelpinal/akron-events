/**
 * Shared GrowthZone (WebLink) module.
 *
 * GrowthZone (growthzone.com, formerly ChamberMaster/WebLink) is a chamber-
 * of-commerce management platform. Member-facing event calendars ("Atlas")
 * are server-fed by a shared, un-authenticated JSON API at
 * api-internal.weblinkconnect.com — the SPA that renders the public calendar
 * calls it directly, tenant-scoped by an `x-tenant` request header (NOT a
 * query param; the API 500s without it).
 *
 * Endpoints:
 *   GET /api/Events?PageSize=0&OrganizationEvent=true&CommunityEvent=true
 *       &MembersOnlyEvent=true&InternalEvent=false
 *       &SearchDateBegin=<ISO>&SearchDateEnd=<ISO>&EventClosed=false
 *     → { TotalCount, TotalPages, Result: [...] } — the list/search feed.
 *     MembersOnlyEvent=true is intentional: the list still needs to SEE
 *     members-only events so a scraper can skip them explicitly (raw.MembersOnly)
 *     rather than have the API silently drop them and leave the skip
 *     unaccounted-for in the run summary.
 *   GET /api/Event/{id}/Details
 *     → the full event object: rich-text Descr, Latitude/Longitude, and the
 *       Items[] fee schedule (registration tiers, sponsorships, tables).
 *
 * This module is tenant-parameterized (every fetcher takes `tenant`) and has
 * no side effects and no DB imports — pure fetch + shape helpers, importable
 * by tests with no env. Per-chamber specifics (the tenant string, the public
 * page base URL) stay in the calling scraper.
 *
 * Usage:
 *   import { fetchGrowthZoneEvents, fetchGrowthZoneDetail } from './lib/growthzone.js'
 *   const events = await fetchGrowthZoneEvents({ tenant: 'AkronOHCOC', windowDays: 400 })
 *   const detail = await fetchGrowthZoneDetail(event.EventId, { tenant: 'AkronOHCOC' })
 */

import { htmlToText, clampChars } from './normalize.js'

/** Base URL for the shared GrowthZone/WebLink internal API (all tenants). */
export const WEBLINK_API = 'https://api-internal.weblinkconnect.com/api'

// One day in milliseconds — used to build the default search window.
const DAY_MS = 86_400_000

/**
 * Build the events list/search URL for a forward window.
 *
 * @param {object} p
 * @param {string} p.searchDateBegin — ISO datetime, inclusive lower bound
 * @param {string} p.searchDateEnd   — ISO datetime, inclusive upper bound
 * @param {number} [p.pageSize=0]    — 0 = no paging (the feed returns every
 *   matching event in Result on one page; GrowthZone chamber calendars run in
 *   the dozens, never enough to need real pagination)
 * @returns {string}
 */
export function buildEventsUrl({ searchDateBegin, searchDateEnd, pageSize = 0 }) {
  const qs = new URLSearchParams({
    PageSize: String(pageSize),
    OrganizationEvent: 'true',
    CommunityEvent: 'true',
    MembersOnlyEvent: 'true',
    InternalEvent: 'false',
    SearchDateBegin: searchDateBegin,
    SearchDateEnd: searchDateEnd,
    EventClosed: 'false',
  })
  return `${WEBLINK_API}/Events?${qs.toString()}`
}

/** Build the per-event detail URL. */
export function buildDetailUrl(eventId) {
  return `${WEBLINK_API}/Event/${encodeURIComponent(eventId)}/Details`
}

/**
 * Fetch the events list for a tenant over a forward window from now.
 *
 * @param {object} p
 * @param {string} p.tenant           — GrowthZone tenant id (e.g. 'AkronOHCOC')
 * @param {number} [p.windowDays=180] — forward horizon in days
 * @param {function} [p.fetchImpl]    — injectable fetch (tests)
 * @returns {Promise<object[]>} the raw `Result` array
 */
export async function fetchGrowthZoneEvents({ tenant, windowDays = 180, fetchImpl = fetch }) {
  if (!tenant) throw new Error('fetchGrowthZoneEvents: tenant is required')
  const now = Date.now()
  const searchDateBegin = new Date(now - DAY_MS).toISOString()
  const searchDateEnd = new Date(now + windowDays * DAY_MS).toISOString()
  const url = buildEventsUrl({ searchDateBegin, searchDateEnd })

  const res = await fetchImpl(url, {
    headers: { 'x-tenant': tenant, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`GrowthZone Events HTTP ${res.status} for tenant ${tenant}`)
  const json = await res.json()
  const result = json?.Result
  if (!Array.isArray(result)) throw new Error('unexpected response shape (no Result array)')
  return result
}

/**
 * Fetch the detail object for a single event. `x-tenant` is REQUIRED — the
 * API returns a 500 without it, not a 404 or an empty body, so a missing
 * tenant fails loud rather than silently returning nothing.
 *
 * @param {number|string} eventId
 * @param {object} p
 * @param {string} p.tenant
 * @param {function} [p.fetchImpl]
 * @returns {Promise<object>} the raw event detail object
 */
export async function fetchGrowthZoneDetail(eventId, { tenant, fetchImpl = fetch }) {
  if (!tenant) throw new Error('fetchGrowthZoneDetail: tenant is required')
  const res = await fetchImpl(buildDetailUrl(eventId), {
    headers: { 'x-tenant': tenant, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`GrowthZone Event/${eventId}/Details HTTP ${res.status} for tenant ${tenant}`)
  return res.json()
}

// ── Time ─────────────────────────────────────────────────────────────────

/**
 * Normalize a GrowthZone UTC timestamp to a strict ISO string with an
 * explicit offset. `StartDateTimeUtc`/`EndDateTimeUtc` are already UTC and
 * (in every feed we've observed) carry a trailing "Z" — but the API is not
 * documented, so this defends against a bare offset-less variant by
 * appending "Z" only when neither a "Z" nor a numeric offset is present.
 */
function toUtcIso(raw) {
  if (!raw) return null
  const s = String(raw)
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`
  const ms = Date.parse(normalized)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString()
}

/** `StartDateTimeUtc` → strict ISO, or null. Ignores StartDate/StartTime. */
export function growthZoneStartIso(raw) {
  return toUtcIso(raw?.StartDateTimeUtc)
}

/** `EndDateTimeUtc` → strict ISO, or null. Ignores EndDate/EndTime. */
export function growthZoneEndIso(raw) {
  return toUtcIso(raw?.EndDateTimeUtc)
}

// ── Price ────────────────────────────────────────────────────────────────

// Sponsorship / table line items are registration "prices" in name only —
// they buy a sponsorship tier or a reserved table, not admission — so they
// must never set the public price range (a $3,500 "Presenting Sponsor" item
// would otherwise make an event look impossibly expensive).
const SPONSOR_OR_TABLE_RE = /sponsor|table/i

/**
 * Derive { price_min, price_max } from a detail event's `Items[]` fee
 * schedule. Only public, priced, non-sponsor/table items count:
 *   - `IsPublic === true`      (internal/comp/sponsor-comp rows are not real
 *      admission tiers a visitor can buy)
 *   - `MemberPrice > 0`        (free/comp rows would otherwise drag price_min
 *      to 0 even when a real paid tier exists)
 *   - `NonMemberPrice > 0`     (same reasoning, applied to the price a
 *      non-member — the general public — actually pays; a $0 NonMemberPrice
 *      on an otherwise-priced item is a data glitch, not a real free tier)
 *   - `Descr` doesn't match /sponsor|table/i
 * price_min is the lowest MemberPrice; price_max is the highest NonMemberPrice
 * clamped to never fall below price_min (Math.max(price_min, ...)), so a
 * member-only discount tier can never invert the displayed range. No
 * qualifying item → both null, never assumed.
 */
export function growthZonePriceRange(items) {
  const qualifying = (Array.isArray(items) ? items : []).filter((it) => {
    if (it?.IsPublic !== true) return false
    const memberPrice = Number(it?.MemberPrice)
    if (!Number.isFinite(memberPrice) || memberPrice <= 0) return false
    const nonMemberPrice = Number(it?.NonMemberPrice)
    if (!Number.isFinite(nonMemberPrice) || nonMemberPrice <= 0) return false
    if (SPONSOR_OR_TABLE_RE.test(String(it?.Descr ?? ''))) return false
    return true
  })
  if (!qualifying.length) return { price_min: null, price_max: null }

  const memberPrices = qualifying.map((it) => Number(it.MemberPrice))
  const nonMemberPrices = qualifying.map((it) => Number(it.NonMemberPrice))

  const price_min = Math.min(...memberPrices)
  const price_max = Math.max(price_min, ...nonMemberPrices)
  return { price_min, price_max }
}

// ── Description ──────────────────────────────────────────────────────────

// Cuts everything from a sponsor-tier heading onward ("Presenting Sponsors:",
// "Supporting Sponsor:", …) — boilerplate for a page layout, meaningless as
// plain text once htmlToText drops the images/headings that gave it context.
const SPONSOR_TAIL_RE = /\n\s*(presenting|supporting|premier|title|patron)\s+sponsors?\s*:[\s\S]*$/i

// The GAC's standing photo/video release notice, appended to nearly every
// description — not useful content for our listing.
const CONSENT_TO_RECORDING_RE =
  /by registering and participating in this event, you consent to the recording[\s\S]*$/i

const MAX_DESCRIPTION = 2000

/**
 * Clean a raw GrowthZone `Descr` HTML field into listing-ready plain text:
 * strip HTML (preserving paragraph breaks), cut the sponsor-tier boilerplate
 * tail, drop the standing photo/video consent notice, and clamp to the
 * shared description length cap. Returns null for empty/blank input.
 */
export function cleanGrowthZoneDescription(html) {
  if (!html) return null
  let text = htmlToText(String(html))
  if (!text) return null
  text = text.replace(SPONSOR_TAIL_RE, '').replace(CONSENT_TO_RECORDING_RE, '').trim()
  if (!text) return null
  return clampChars(text, MAX_DESCRIPTION)
}
