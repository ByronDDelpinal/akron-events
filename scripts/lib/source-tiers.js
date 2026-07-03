/**
 * source-tiers.js
 *
 * Per-source data-quality tier, used by the aggregator-precedence policy
 * (2026-07-02 data-quality remediation plan, task 3).
 *
 *   Tier 1 — VENUE_OFFICIAL. The venue/organizer's own site or official API.
 *            Most trusted. Default for any source not listed below — the
 *            large majority of this project's scrapers are bespoke
 *            per-venue/org scrapers, so that's the safe default.
 *   Tier 2 — PLATFORM. A shared platform a venue/org publishes through
 *            (a library consortium's calendar system, a city's RecDesk
 *            instance, an organizer's own recurring feed on a
 *            third-party platform like Meetup). Still first-party content,
 *            just not a bespoke scraper per venue.
 *   Tier 3 — AGGREGATOR. A republisher that collects events FROM other
 *            organizers (Downtown Akron Partnership, Ticketmaster,
 *            Eventbrite, Akron Life, RunSignup, Ohio Festivals). Thinner,
 *            occasionally wrong (stale dates/times, retitled events), and
 *            never trusted over a Tier 1/2 copy of the same event.
 *
 * This is a distinct concept from SOURCE_PRIORITY in dedupe-cross-source.js:
 * SOURCE_PRIORITY breaks ties between two rows that are already known to be
 * an exact venue+time duplicate. This module is about aggregator
 * SUPPRESSION/REVIEW for a single source (downtown_akron first) — deciding,
 * at ingest time, whether a Tier-3 event should publish at all.
 */

import { supabaseAdmin } from './supabase-admin.js'

export const TIER_VENUE_OFFICIAL = 1
export const TIER_PLATFORM = 2
export const TIER_AGGREGATOR = 3

// Sources that are a first-party feed but shared across many venues/orgs
// (not a bespoke per-venue scraper).
const TIER_2_SOURCES = new Set([
  'akron_library',
  'cuyahoga_falls_library',
  'akron_rec_parks',
  'meetup',
])

// Aggregators / republishers — collect events from other organizers rather
// than being the organizer themselves.
const TIER_3_SOURCES = new Set([
  'downtown_akron',
  'ticketmaster',
  'eventbrite',
  'visit_akron_cvb',
  'akron_life',
  'runsignup',
  'ohio_festivals',
])

export function sourceTier(source) {
  if (TIER_3_SOURCES.has(source)) return TIER_AGGREGATOR
  if (TIER_2_SOURCES.has(source)) return TIER_PLATFORM
  return TIER_VENUE_OFFICIAL
}

export function isAggregatorSource(source) {
  return sourceTier(source) === TIER_AGGREGATOR
}

export function isTrustedSource(source) {
  return sourceTier(source) !== TIER_AGGREGATOR
}

// ── Venue coverage (I/O) ──────────────────────────────────────────────────

/**
 * All currently-published Tier 1/2 events linked to a venue, as
 * { source, start_at } pairs. Read-only. Callers should fetch once per venue
 * and reuse across that venue's events in the same run (see
 * classifyAgainstTrusted below for the pure per-event decision).
 */
export async function getTrustedEventsAtVenue(venueId) {
  if (!venueId) return []
  const { data, error } = await supabaseAdmin
    .from('event_venues')
    .select('events!inner(source, start_at, status)')
    .eq('venue_id', venueId)
  if (error || !data) return []
  return data
    .map((row) => row.events)
    .filter((ev) => ev && ev.status === 'published' && isTrustedSource(ev.source))
    .map((ev) => ({ source: ev.source, start_at: ev.start_at }))
}

// ── Pure decision (unit-tested) ────────────────────────────────────────────

/**
 * Decide what to do with a single Tier-3 (aggregator) event given the
 * Tier 1/2 events already known at its venue.
 *
 *   - No Tier 1/2 events at this venue at all → aggregator is the sole
 *     source for this venue. Publish normally, no flag.
 *   - A Tier 1/2 event at the SAME venue within `windowDays` of this one →
 *     treat as the same physical event already covered by a trusted source.
 *     Suppress (do not publish) rather than a second, thinner copy.
 *   - Tier 1/2 events exist at this venue, but none near this date → the
 *     venue is covered in general but this specific event isn't (a scraper
 *     gap, e.g. a recurring "Free Thursday" program the venue scraper
 *     misses, or an aggregator error). Publish, but flag needs_review so a
 *     human decides — never silently drop.
 *
 * @param {{source:string, start_at:string}[]} trustedEventsAtVenue
 * @param {string} startAtIso
 * @param {{windowDays?: number}} [opts]
 * @returns {{ suppress: boolean, needsReview: boolean }}
 */
export function classifyAgainstTrusted(trustedEventsAtVenue, startAtIso, { windowDays = 3 } = {}) {
  if (!trustedEventsAtVenue || trustedEventsAtVenue.length === 0) {
    return { suppress: false, needsReview: false }
  }
  const target = new Date(startAtIso).getTime()
  if (Number.isNaN(target)) return { suppress: false, needsReview: false }

  const windowMs = windowDays * 24 * 60 * 60 * 1000
  const hasNearbyMatch = trustedEventsAtVenue.some((ev) => {
    const t = new Date(ev.start_at).getTime()
    return !Number.isNaN(t) && Math.abs(t - target) <= windowMs
  })

  return hasNearbyMatch
    ? { suppress: true, needsReview: false }
    : { suppress: false, needsReview: true }
}
