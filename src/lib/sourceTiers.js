/**
 * sourceTiers.js — per-source trust tier + attribution policy (PURE DATA).
 *
 * SINGLE SOURCE OF TRUTH. Lives in src/lib (not scripts/lib) for the same
 * reason src/lib/categories.js does: both the browser bundle and the Node
 * scrapers need it, and duplicating the aggregator list into the frontend
 * would let the two drift.
 *
 * This module must stay PURE — no I/O, no supabase, no env. scripts/lib/
 * source-tiers.js re-exports everything here and adds the database-backed
 * helpers; it is the import site for all scraper code, so existing
 * `from './lib/source-tiers.js'` imports keep working unchanged. The browser
 * imports THIS file directly, because scripts/lib/source-tiers.js pulls in
 * @supabase/supabase-js and dotenv, which must never reach the client bundle.
 *
 *   Tier 1 — VENUE_OFFICIAL. The venue/organizer's own site or official API.
 *            Most trusted. Default for any source not listed below — the
 *            large majority of this project's scrapers are bespoke
 *            per-venue/org scrapers, so that's the safe default.
 *   Tier 2 — PLATFORM. A shared platform a venue/org publishes through
 *            (a library consortium's calendar system, a city's RecDesk
 *            instance, an organizer's own recurring feed on a third-party
 *            platform like Meetup). Still first-party content, just not a
 *            bespoke scraper per venue.
 *   Tier 3 — AGGREGATOR. A republisher that collects events FROM other
 *            organizers (Downtown Akron Partnership, Ticketmaster,
 *            Eventbrite, Akron Life, RunSignup, Ohio Festivals). Thinner,
 *            occasionally wrong (stale dates/times, retitled events), and
 *            never trusted over a Tier 1/2 copy.
 */

export const TIER_VENUE_OFFICIAL = 1
export const TIER_PLATFORM = 2
export const TIER_AGGREGATOR = 3

// Sources that are a first-party feed but shared across many venues/orgs
// (not a bespoke per-venue scraper).
export const TIER_2_SOURCES = new Set([
  'akron_library',
  'cuyahoga_falls_library',
  'akron_rec_parks',
  'meetup',
])

// Aggregators / republishers — collect events from other organizers rather
// than being the organizer themselves.
export const TIER_3_SOURCES = new Set([
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

// ── Analytics: readable tier labels ────────────────────────────────────────
// A bare 1/2/3 in a GA4 report forces every reader to carry the mapping in
// their head. Derived from sourceTier() rather than a parallel list, so the
// labels cannot drift from the tiers they name.
export const SOURCE_TIER_LABEL = {
  [TIER_VENUE_OFFICIAL]: 'venue_official',
  [TIER_PLATFORM]:       'platform',
  [TIER_AGGREGATOR]:     'aggregator',
}

/**
 * Tier label for analytics. Answers "are we sending traffic to the people who
 * actually host the event, or to a republisher?".
 *
 * Note the null case is NOT the sourceTier() default. sourceTier() maps an
 * unknown source key to TIER_VENUE_OFFICIAL because almost every scraper here
 * is a bespoke per-venue one — a safe default for TRUST decisions. But a row
 * with no source at all wasn't scraped, it was typed into the admin by hand.
 * Folding those into 'venue_official' would silently inflate the exact number
 * this label exists to measure, so they get their own bucket.
 */
export function sourceTierLabel(source) {
  if (!source) return 'manual'
  return SOURCE_TIER_LABEL[sourceTier(source)]
}

export function isTrustedSource(source) {
  return sourceTier(source) !== TIER_AGGREGATOR
}

// ── Aggregator precedence ──────────────────────────────────────────────────
// Internal ranking WITHIN Tier 3 — which aggregator's copy of the same event
// wins. Lower index = more trusted. dedupe-cross-source.js imports it for
// canonical selection, and classifyAggregatorEvent (scripts/lib/source-tiers.js)
// uses it for ingest-time suppression.
export const AGGREGATOR_PRIORITY = [
  'ticketmaster',
  'eventbrite',
  'visit_akron_cvb',
  'akron_life',
  'runsignup',
  'ohio_festivals',
  'downtown_akron',
]

/** Rank within Tier 3. Unlisted sources rank last (least trusted). */
export function aggregatorRank(source) {
  const i = AGGREGATOR_PRIORITY.indexOf(source)
  return i === -1 ? AGGREGATOR_PRIORITY.length : i
}

// ── Attribution: aggregators may never credit themselves ───────────────────
//
// POLICY (2026-07-15): an aggregator source must carry either the REAL
// hosting organization or NO organization at all. It may never name itself
// as the presenter.
//
// Why this is a rule and not a nice-to-have: the site renders
// event_organizations as "Presented by X". When an aggregator scraper
// hardcoded its own org onto every row, Akron Pulse was telling the public
// that Downtown Akron Partnership and Visit Akron HOST events they merely
// republish — so those orgs fielded phone calls about events they had nothing
// to do with. That is a real burden on partner orgs. Prior incident of the
// same shape: the "Hardy at Blossom" comment in scrape-akron-life.js.
//
// Why it cannot be fixed per-scraper: a Tier-1 scraper doing
// `ensureOrganization('Akron Civic Theatre')` is CORRECT, and is identical in
// shape to downtown_akron's incorrect `ensureOrganization('Downtown Akron
// Partnership')`. Only the tier distinguishes them, so the guard has to live
// at choke points that know the source — linkEventOrganization() in
// normalize.js (scraper path) and collectLinkDonations() in
// dedupe-cross-source.js (merge path).
//
// Keys are source keys; values are the `organizations.name` the source uses
// for itself. Comparison is via orgNameMatchKey() below — the same fold
// ensureOrganization uses for loose org matching ("The X" ↔ "X", case,
// whitespace) — so a "The"-prefixed or case-variant row that loose matching
// resolves onto can never slip past this guard. Sources with no entry have
// no self-org and cannot self-credit.
export const AGGREGATOR_SELF_ORG = {
  downtown_akron:  'Downtown Akron Partnership',
  visit_akron_cvb: 'Visit Akron / Summit County',
  akron_life:      'Akron Life Magazine',
  // Listed defensively: these sources do not currently mint a self-org, but an
  // entry here makes it impossible for a future edit to start doing so
  // silently.
  ohio_festivals:  'Ohio Festivals',
  runsignup:       'RunSignup',
  eventbrite:      'Eventbrite',
  ticketmaster:    'Ticketmaster',
}

/**
 * Match key for an organization name: case-folded, with a leading "The"
 * dropped and whitespace collapsed.
 *
 * SINGLE SOURCE OF TRUTH for the org-name fold. ensureOrganization's loose
 * matching (orgNameKey in scripts/lib/normalize.js, which adds HTML-entity
 * decoding on top) and the self-credit guard below MUST fold identically:
 * when they drifted, a "The Downtown Akron Partnership" row that loose
 * matching happily resolved onto was invisible to the exact-name guard,
 * silently re-opening the self-credit hole this policy exists to close.
 *
 * Deliberately conservative — folds only the "The"/case/whitespace axes we
 * have observed splitting rows. It does NOT strip punctuation: over-folding
 * would merge genuinely different orgs, which is worse than a duplicate.
 */
export function orgNameMatchKey(name) {
  return String(name ?? '')
    .trim()
    .replace(/^the\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const _selfOrgNames = new Set(
  Object.values(AGGREGATOR_SELF_ORG).map(orgNameMatchKey)
)

/**
 * True if `orgName` is the self-identity of ANY aggregator source
 * (compared via orgNameMatchKey, so "The X"/case/whitespace variants match).
 *
 * Cheap pre-filter: lets callers skip the (more expensive) source lookup for
 * the ~99% of links whose org could never be a self-credit in the first place.
 */
export function isAggregatorSelfOrgName(orgName) {
  if (!orgName) return false
  return _selfOrgNames.has(orgNameMatchKey(orgName))
}

/**
 * True if linking `orgName` to an event from `source` would make that source
 * credit ITSELF as the presenter.
 *
 * Deliberately keyed on the (source, org) PAIR, not on "is this org an
 * aggregator". Visit Akron is a real organizer of its OWN events, and "City of
 * Akron" is a legitimate organizer that also shows up as a CVB hostname —
 * neither should be blocked. Only the self-referential case is forbidden:
 * downtown_akron crediting Downtown Akron Partnership.
 */
export function isSelfCredit(source, orgName) {
  if (!source || !orgName) return false
  const self = AGGREGATOR_SELF_ORG[source]
  if (!self) return false
  return orgNameMatchKey(self) === orgNameMatchKey(orgName)
}
