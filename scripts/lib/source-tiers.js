/**
 * source-tiers.js — server-side source-tier helpers.
 *
 * The tier/attribution POLICY itself (which sources are aggregators, the
 * precedence order, and the self-credit rules) is pure data and lives in
 * src/lib/sourceTiers.js, so the browser can share it without pulling
 * @supabase/supabase-js and dotenv into the client bundle. Same split as
 * src/lib/categories.js.
 *
 * This module re-exports all of it, so every existing
 * `from './lib/source-tiers.js'` import keeps working, and adds the pieces
 * that need database access or the ingest-time decision logic.
 *
 * This is a distinct concept from SOURCE_PRIORITY in dedupe-cross-source.js:
 * SOURCE_PRIORITY breaks ties between two rows that are already known to be
 * an exact venue+time duplicate. This module is about aggregator
 * SUPPRESSION/REVIEW for a single source (downtown_akron first) — deciding,
 * at ingest time, whether a Tier-3 event should publish at all.
 */

import { supabaseAdmin } from './supabase-admin.js'
import { isTrustedSource, isAggregatorSource, aggregatorRank } from '../../src/lib/sourceTiers.js'

// Re-export the shared policy so scraper code has a single import site.
export {
  TIER_VENUE_OFFICIAL,
  TIER_PLATFORM,
  TIER_AGGREGATOR,
  TIER_2_SOURCES,
  TIER_3_SOURCES,
  sourceTier,
  isAggregatorSource,
  isTrustedSource,
  AGGREGATOR_PRIORITY,
  aggregatorRank,
  AGGREGATOR_SELF_ORG,
  orgNameMatchKey,
  isAggregatorSelfOrgName,
  isSelfCredit,
} from '../../src/lib/sourceTiers.js'

// ── Local mirrors of dedupe-cross-source helpers ───────────────────────────
// dedupe-cross-source.js imports AGGREGATOR_PRIORITY from this module, so
// this module cannot import dedupe's normalizeTitle/toSecondKey without a
// cycle. These are deliberate small copies — keep semantics in sync.

/** Punctuation/case-insensitive title key (mirrors dedupe's normalizeTitle). */
export function titleKey(title) {
  return (title || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whole-second UTC key (mirrors dedupe's toSecondKey). */
function secondKey(ts) {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString().slice(0, 19)
}

// ── Venue coverage (I/O) ──────────────────────────────────────────────────

/**
 * All currently-published events linked to a venue, as
 * { source, start_at, title } rows. Read-only. Callers should fetch once per
 * venue and reuse across that venue's events in the same run (see
 * classifyAggregatorEvent below for the pure per-event decision).
 */
export async function getPublishedEventsAtVenue(venueId) {
  if (!venueId) return []
  const { data, error } = await supabaseAdmin
    .from('event_venues')
    .select('events!inner(source, start_at, status, title)')
    .eq('venue_id', venueId)
  if (error || !data) return []
  return data
    .map((row) => row.events)
    .filter((ev) => ev && ev.status === 'published')
    .map((ev) => ({ source: ev.source, start_at: ev.start_at, title: ev.title }))
}

/**
 * All currently-published Tier 1/2 events linked to a venue.
 * Kept for callers that only need the trusted subset.
 */
export async function getTrustedEventsAtVenue(venueId) {
  const events = await getPublishedEventsAtVenue(venueId)
  return events
    .filter((ev) => isTrustedSource(ev.source))
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

/**
 * Full ingest-time decision for a single Tier-3 (aggregator) event, given
 * ALL published events already linked to its venue. Extends
 * classifyAgainstTrusted with aggregator-vs-aggregator suppression:
 *
 *   1. Trusted (Tier 1/2) copy within `windowDays` at this venue →
 *      suppress (reason 'trusted-nearby'). Same as classifyAgainstTrusted.
 *   2. Else: a copy from a STRICTLY higher-priority aggregator (see
 *      AGGREGATOR_PRIORITY) at the same venue, same start SECOND, with the
 *      same normalized title → suppress (reason 'higher-priority-aggregator').
 *      This is the gap that let a downtown_akron copy of an
 *      eventbrite-covered event publish between dedupe runs (Vinyasa Yoga
 *      on the Plaza, 2026-07-04): dedupe only runs at the end of scrape:all,
 *      so an aggregator dupe inserted out-of-band went live for days.
 *      The gate is deliberately strict (exact second + exact title key,
 *      mirroring dedupe Pass 1's hard gate) because ingest suppression drops
 *      silently — looser matches (promoter prefixes, doors-vs-show drift)
 *      stay dedupe's job, where merges preserve the richer copy.
 *      Strictly-higher rank means a source never suppresses itself on
 *      re-scrape, and two aggregators can never mutually suppress.
 *   3. Else: trusted coverage exists at the venue but nothing nearby →
 *      publish + needs_review (reason 'trusted-not-nearby'), never
 *      silently drop.
 *   4. Else: publish normally.
 *
 * @param {{source:string, start_at:string, title?:string}[]} eventsAtVenue
 *   from getPublishedEventsAtVenue()
 * @param {{source:string, startAt:string, title?:string}} candidate
 * @param {{windowDays?: number}} [opts]
 * @returns {{ suppress: boolean, needsReview: boolean, reason: string|null }}
 */
export function classifyAggregatorEvent(eventsAtVenue, candidate, { windowDays = 3 } = {}) {
  const events = eventsAtVenue ?? []
  const trusted = events.filter((ev) => isTrustedSource(ev.source))

  const base = classifyAgainstTrusted(trusted, candidate.startAt, { windowDays })
  if (base.suppress) {
    return { suppress: true, needsReview: false, reason: 'trusted-nearby' }
  }

  const candRank   = aggregatorRank(candidate.source)
  const candSecond = secondKey(candidate.startAt)
  const candTitle  = titleKey(candidate.title)
  const higherPriorityCopy = candTitle && events.some((ev) =>
    isAggregatorSource(ev.source) &&
    aggregatorRank(ev.source) < candRank &&
    secondKey(ev.start_at) === candSecond &&
    titleKey(ev.title) === candTitle
  )
  if (higherPriorityCopy) {
    return { suppress: true, needsReview: false, reason: 'higher-priority-aggregator' }
  }

  return base.needsReview
    ? { suppress: false, needsReview: true, reason: 'trusted-not-nearby' }
    : { suppress: false, needsReview: false, reason: null }
}
