/**
 * financials.ts - single source of truth for the public /financials page.
 *
 * Every figure on that page that is NOT queried live (event counts come from
 * Supabase, traffic from /api/pageviews) lives here, so updating the numbers
 * is one file edit.
 *
 * THIS MODULE IS THE COMMITTED METHODOLOGY. An earlier draft pointed readers
 * at a Word document under docs/, but docs/ is gitignored project-wide, so
 * that pointer resolved to nothing for every reader including future
 * maintainers. The model now lives here in full: the per-line cost
 * schedules, what each line buys, what is measured versus modeled
 * (ASSUMPTIONS below), and when vendor prices were last checked
 * (PRICES_VERIFIED). Re-verify vendor prices against the linked pricing
 * pages before each funding cycle and bump PRICES_VERIFIED when you do -
 * and only when you actually did.
 *
 * COST MODEL (rewritten 2026-08-17, replacing a two-point `monthly:
 * [today, atScale]` array per line): every cost line now declares a
 * `driver` - 'flat', 'traffic', or 'subscribers' - and a schedule.
 * `lineCostMonthly(line, driverValue)` evaluates plan price plus metered
 * overage from that schedule. TIER_TOTALS' Today and At-scale columns, and
 * the /financials adoption slider's live "At this adoption" column, are all
 * evaluations of the exact same functions at different driver values, so
 * the table and the slider can never disagree. See the "Cost model: drivers
 * and schedules" section below for the full derivation.
 */

import { ACTIVE_SCRAPERS } from '../../scripts/manifest.js'

/**
 * Human-readable date every vendor price schedule below was last checked
 * against its pricing page (Supabase, Vercel, Resend, Claude, the domain
 * registrar).
 *
 * Do not bump this as a formality. scripts/tests/test-financials-model.js
 * fails once it is more than 180 days stale, but be clear about what that
 * buys: it enforces a CADENCE, not honesty. Bumping the date is precisely
 * what makes the test pass again, so nothing but the person editing this line
 * stands behind the claim that the prices were actually re-checked. A stale
 * date is a true statement about an unchecked page; a fresh date on an
 * unchecked page is a lie on a page whose entire premise is accuracy, and no
 * test can tell the two apart.
 */
export const PRICES_VERIFIED = 'August 17, 2026'

/**
 * Index of the "today" tier: the real, current bill. Every headline stat,
 * the cost-per-event math, and the sponsor ask all read this index, and the
 * page keeps this column on screen at all times.
 */
export const TODAY_INDEX = 0

/**
 * Which tier the cost table's second column opens on.
 *
 * Deliberately NOT TODAY_INDEX. The table always shows today; the second
 * column exists to answer "what happens when this grows", so it opens on the
 * first modeled tier. Keeping these two as separate named constants is the
 * whole point - the previous draft used a bare `0` for both meanings, and the
 * two are not the same idea even when they hold the same value.
 */
export const DEFAULT_TIER_INDEX = 1

// TIERS is declared further down this file, after CEILING_VIEWS_PER_USER_MONTH
// and TODAY_MONTHLY_ACTIVE_USERS are defined - both labels are now derived
// expressions (users-first, 2026-08-17), and a const can only reference an
// identifier declared earlier in module evaluation order. See TIERS' own
// comment for the full reasoning.

/** Number of fixed reference tiers TIER_TOTALS carries: today and at-scale. */
export type TierAmounts = [number, number]

/**
 * How many scrapers actually run every night, DERIVED from
 * scripts/manifest.js rather than typed in as prose.
 *
 * The previous copy said "90+", which was stale by more than fifty sources
 * the day it shipped. A count in a sentence is a registry pair held together
 * by nobody, so this one reads the registry.
 */
export const ACTIVE_SOURCE_COUNT = ACTIVE_SCRAPERS.length

// ── County population and reach ──────────────────────────────────────────
// Shared inputs: both the cost model's traffic/subscriber drivers below AND
// the impact calculator further down in this file read these same figures,
// so they live here, once, ahead of both.

/**
 * Annual unique users, GA4 property 538991588, trailing 365 days through
 * REACH_MEASURED_THROUGH (identical to 2026 year-to-date - the site is new,
 * so the calendar year and the trailing year cover the same traffic).
 *
 * The denominator is annual UNIQUE users, not monthly actives multiplied by
 * twelve. A visitor who returns in a second month is one person who came
 * back, not a second new person; compounding monthly actives into a
 * pseudo-annual figure would count them twice.
 */
export const ANNUAL_UNIQUE_USERS = 3127

/**
 * MEASURED, GA4 property 538991588, trailing 30 days through
 * REACH_MEASURED_THROUGH (pulled 2026-08-17). THE public traffic metric
 * (maintainer decision, 2026-08-17): active users, not pageviews - this is
 * what TIERS' "today" tier label names below, and what the /financials stat
 * card leads with. LAST_30D_USERS, further down in the "Local spending
 * facilitated" section, is the same measurement kept under a different name
 * for that section's reach-context prose; it is derived from this constant
 * so the two figures can never drift apart. Update this value (and
 * REACH_MEASURED_THROUGH) together at each reach refresh.
 */
export const TODAY_MONTHLY_ACTIVE_USERS = 2859

/** census.gov QuickFacts, V2025 estimate for Summit County, Ohio (2025-07-01). */
export const SUMMIT_COUNTY_POPULATION = 538376

/** census.gov QuickFacts: adults as a share of Summit County's population, V2025. */
export const SUMMIT_COUNTY_ADULT_SHARE = 0.80

/**
 * DERIVED. Adults in Summit County: population x adult share, rounded to the
 * nearest person. 538,376 x 80.0% = 430,701.
 */
export const SUMMIT_COUNTY_ADULTS = Math.round(SUMMIT_COUNTY_POPULATION * SUMMIT_COUNTY_ADULT_SHARE)

/**
 * DERIVED. adopters(s): active users at adoption share s (0..1) of Summit
 * County's adults. THE primary driver quantity for this model (maintainer
 * decision, 2026-08-17: active users are the one public metric). Every other
 * adoption-driven figure below - traffic views, subscribers, local spending
 * facilitated - is derived FROM this user count, never the other way around.
 * Views in particular are an internal unit the traffic cost schedules
 * respond to, not a public-facing quantity - see trafficViewsPerMonth and
 * CEILING_VIEWS_PER_USER_MONTH further down for that derivation.
 */
export function adoptersAtShare(share: number): number {
  return SUMMIT_COUNTY_ADULTS * share
}

// ── Cost model: drivers and schedules ───────────────────────────────────────
//
// Every cost line declares exactly one driver:
//   'flat'        - does not vary with adoption (Claude Max, domain, the
//                    proxy's headroom, the labor/marketing budgets, the free
//                    lines). See lineCostMonthly for how a flat line's Today
//                    figure differs from its At-scale figure without being a
//                    function of traffic.
//   'traffic'      - varies with monthly pageviews (Vercel, Supabase).
//   'subscribers'  - varies with the email list (Resend).
//
// USERS FIRST (maintainer decision, 2026-08-17): active users are the one
// public metric this page and model use. Views and subscriber counts are
// internal derived quantities that exist only inside these cost evaluators -
// nothing renders a view count as a headline any more (see TIERS below).
// Both conversions below start from the same primary quantity,
// adoptersAtShare(s) (adopters(s) for short - see its definition above),
// active users at adoption share s of Summit County's adults:
//
//   traffic(s)      = adopters(s) * CEILING_VIEWS_PER_USER_MONTH
//   subscribers(s)  = adopters(s) * SUBSCRIBER_CONVERSION
//
// traffic(s) intentionally scales through a CEILING-CALIBRATED views-per-user
// rate rather than deriving pageviews from
// adopters(s) * VIEWS_PER_USER_YEAR (see siteOnlyViewsPerMonth below): the
// ceiling already includes embed syndication and pass-through traffic that
// county-adoption share alone does not generate (Byron, 2026-08-17), and
// CEILING_VIEWS_PER_USER_MONTH is defined precisely so that adopters(1.0) -
// every Summit County adult - produces exactly EMBED_CEILING_VIEWS_PER_MONTH,
// by construction, with no second assumption needed: the live column at
// s=1.0 still equals the At-scale column exactly. siteOnlyViewsPerMonth
// stays in the file as a documented lower reference (~267k/mo at s=1.0) and
// is never rendered.
//
// "Today" is not a point on either curve - it is measured directly
// (TODAY_VIEWS_PER_MONTH, TODAY_SUBSCRIBERS) and evaluated through the same
// lineCostMonthly function, so the Today column and the live column share
// one implementation even though Today's inputs come from measurement
// rather than the slider. TODAY_VIEWS_PER_MONTH in particular stays a direct
// measurement rather than a derivation from TODAY_MONTHLY_ACTIVE_USERS - a
// real measurement needs no derivation.

/** MEASURED (embed-EXCLUDING), GA4 property 538991588, pulled 2026-08-17: GA4 totalUsers x average pageviews/user, trailing 365 days = 23,260 total pageviews. Kept as a named reference for VIEWS_PER_USER_YEAR below; not used to calibrate CEILING_VIEWS_PER_USER_MONTH, which is ceiling-calibrated instead (see that constant's comment for why the two numbers are not meant to agree). */
export const GA4_TOTAL_PAGEVIEWS_TRAILING_365D = 23260

/**
 * DERIVED, measured 2026-08-17, embed-EXCLUDING: GA4_TOTAL_PAGEVIEWS_TRAILING_365D
 * / ANNUAL_UNIQUE_USERS = 7.44 pageviews per user per year, the real,
 * site-only measured rate (no habitual-use multiplier, Byron 2026-08-17).
 * CEILING_VIEWS_PER_USER_MONTH below is a deliberately different, larger
 * figure - see its comment.
 */
export const VIEWS_PER_USER_YEAR = GA4_TOTAL_PAGEVIEWS_TRAILING_365D / ANNUAL_UNIQUE_USERS

/**
 * The at-scale traffic ceiling every 'traffic' line evaluates at s = 1.0,
 * and what the live slider scales toward: ~10M views/mo including embed
 * syndication and pass-through (tourist/search) traffic, not just
 * county-resident visits.
 */
export const EMBED_CEILING_VIEWS_PER_MONTH = 10000000

/**
 * DERIVED, CEILING-CALIBRATED: EMBED_CEILING_VIEWS_PER_MONTH /
 * SUMMIT_COUNTY_ADULTS (~23.2 views/user/month). The internal, embed-
 * INCLUSIVE rate trafficViewsPerMonth uses to turn adopters (the public,
 * users-first driver) into views (an internal traffic-cost unit), defined
 * so that adoptersAtShare(1) - every Summit County adult - produces EXACTLY
 * EMBED_CEILING_VIEWS_PER_MONTH, by construction.
 *
 * This is NOT the measured per-user view rate - that is VIEWS_PER_USER_YEAR
 * above (~7.44/yr, ~0.62/mo), a real, embed-excluding measurement.
 * CEILING_VIEWS_PER_USER_MONTH's annualized value (~278/yr) comes out
 * roughly 37x higher than that measured rate, because the ceiling has to
 * plan for embed syndication and pass-through (tourist, search) traffic
 * that a Summit County adoption share alone does not generate (Byron,
 * 2026-08-17): none of those viewers are necessarily Summit County
 * adopters, but every one of them costs server time, so the cost model
 * plans for them anyway.
 */
export const CEILING_VIEWS_PER_USER_MONTH = EMBED_CEILING_VIEWS_PER_MONTH / SUMMIT_COUNTY_ADULTS

/**
 * traffic(s): the driver value every 'traffic' cost line evaluates at
 * adoption share s. Two-step and users-first: adoptersAtShare(1) - every
 * Summit County adult, the ceiling population - times
 * CEILING_VIEWS_PER_USER_MONTH reconstructs the views ceiling, then share
 * scales that ceiling. Views remain the internal unit the traffic-cost
 * schedules actually respond to, derived FROM adopters via the
 * ceiling-calibrated rate above, never the other way around.
 *
 * Deliberately NOT `adoptersAtShare(share) * CEILING_VIEWS_PER_USER_MONTH`
 * (multiplying the SHARE-scaled adopter count by the rate): floating-point
 * division and multiplication do not round-trip exactly at every share, and
 * that ordering was measured to flip a handful of adoption shares' Math.ceil
 * boundaries by a dollar - a real difference from the current build, which
 * the "identical dollar figures" invariant this refactor exists to hold
 * does not allow. Scaling the reconstructed ceiling by share instead is
 * bit-for-bit identical to the plain `share * EMBED_CEILING_VIEWS_PER_MONTH`
 * an earlier draft used, verified across every adoption share from 1% to
 * 100% - only the derivation reads differently now, never the numbers.
 */
export function trafficViewsPerMonth(share: number): number {
  const viewsCeiling = adoptersAtShare(1) * CEILING_VIEWS_PER_USER_MONTH
  return share * viewsCeiling
}

/**
 * Documented lower reference ONLY - never rendered. County-resident traffic
 * alone at adoption share s, with no embed/pass-through allowance: at s=1.0
 * this is ~267k/mo, far below the 10M ceiling trafficViewsPerMonth uses,
 * because that ceiling includes syndicated and passthrough traffic this
 * function does not model.
 */
export function siteOnlyViewsPerMonth(share: number): number {
  return (adoptersAtShare(share) * VIEWS_PER_USER_YEAR) / 12
}

/**
 * MEASURED (approximate), 2026-08-17. GA4 pageviews, most recent complete
 * calendar month, after the 2026-08-12 page_view over-counting guard
 * landed. The driver value the Today column evaluates every 'traffic' line
 * at. A real measurement needs no derivation, so this stays a direct figure
 * rather than routing through adoptersAtShare - there is no "today adoption
 * share" to derive it from. Deliberately not surfaced as a headline figure
 * elsewhere on the page - active users are the headline now, see TIERS'
 * "today" label below - but this is the number the traffic schedules
 * actually evaluate Today against.
 */
export const TODAY_VIEWS_PER_MONTH = 2300

/**
 * Traffic tiers for the cost-table explorer, in display order. TODAY_INDEX is
 * the real bill; "At scale" is a modeled scenario (production architecture
 * assumed: MapLibre + OpenFreeMap map rendering, Vercel edge delivery).
 *
 * Two tiers on purpose (2026-08-17, Byron). Earlier drafts modeled 10x and
 * 100x intermediate steps; they read as precision the model doesn't have.
 * The honest story is the real bill and the worst-case stress test - full
 * region adoption, the MOST expensive scenario - with nothing in between as
 * FIXED reference points. The live "At this adoption" column (added
 * 2026-08-17) fills the space between them, driven by the adoption slider.
 *
 * Labels are USERS-FIRST (2026-08-17): active users are the one public
 * metric this page leads with, so both tier labels name users, not views.
 * The views figure still appears, parenthetically, on the at-scale tier -
 * the ceiling is still the cost stress test the traffic schedules evaluate
 * against - but it is no longer the headline. "Today" names the measured
 * 30-day active-user count (TODAY_MONTHLY_ACTIVE_USERS, rounded to the
 * nearest hundred so a single day's wobble doesn't read as false precision);
 * "At scale" names the ceiling population, Summit County's every adult, with
 * the views ceiling it implies in parentheses - derived from
 * EMBED_CEILING_VIEWS_PER_MONTH, never hand-typed.
 *
 * Declared here, after CEILING_VIEWS_PER_USER_MONTH and
 * TODAY_MONTHLY_ACTIVE_USERS above, rather than at the top of the file where
 * an earlier draft had it: both labels are derived expressions now, and a
 * const can only reference an identifier declared earlier in module
 * evaluation order.
 */
export const TIERS = [
  {
    key: 'today',
    label: 'Today',
    traffic: `about ${(Math.round(TODAY_MONTHLY_ACTIVE_USERS / 100) * 100).toLocaleString()} monthly active users`,
  },
  {
    key: 'region',
    label: 'At scale',
    traffic: `every adult in Summit County (~${EMBED_CEILING_VIEWS_PER_MONTH / 1_000_000}M views/mo served)`,
  },
] as const

/**
 * MEASURED, 2026-08-17 (Vercel usage dashboard, most recent complete 30-day
 * window). The denominator this baseline and SUPABASE_EGRESS_GB_BASELINE
 * below are both ratioed against to get a GB-per-pageview intensity:
 * re-measure both figures together at the next refresh so the pair stays
 * from the same window.
 */
export const USAGE_BASELINE_VIEWS = 19200

/** MEASURED, 2026-08-17. Vercel Fast Data Transfer, most recent complete 30-day window, at USAGE_BASELINE_VIEWS pageviews. */
export const VERCEL_TRANSFER_GB_BASELINE = 2.5

/** MEASURED, 2026-08-17. Supabase egress, most recent complete 30-day window, at USAGE_BASELINE_VIEWS pageviews. */
export const SUPABASE_EGRESS_GB_BASELINE = 1.8

/** DERIVED. GB of Vercel Fast Data Transfer per pageview: VERCEL_TRANSFER_GB_BASELINE / USAGE_BASELINE_VIEWS. */
export const VERCEL_GB_PER_VIEW = VERCEL_TRANSFER_GB_BASELINE / USAGE_BASELINE_VIEWS

/** DERIVED. GB of Supabase egress per pageview: SUPABASE_EGRESS_GB_BASELINE / USAGE_BASELINE_VIEWS. */
export const SUPABASE_GB_PER_VIEW = SUPABASE_EGRESS_GB_BASELINE / USAGE_BASELINE_VIEWS

/** MEASURED, 2026-08-17 (Supabase, confirmed subscriber rows). The driver value the Today column evaluates the 'subscribers' line at, and the numerator of SUBSCRIBER_CONVERSION below. */
export const TODAY_SUBSCRIBERS = 138

/**
 * DERIVED from two measured figures (TODAY_SUBSCRIBERS / ANNUAL_UNIQUE_USERS
 * = 4.4%), but the CONSTANCY of that ratio at other adoption shares is an
 * ASSUMPTION: nothing says the share of visitors who subscribe stays fixed
 * as the audience grows. Labeled assumed for that reason.
 */
export const SUBSCRIBER_CONVERSION = TODAY_SUBSCRIBERS / ANNUAL_UNIQUE_USERS

/** subscribers(s): the driver value the 'subscribers' cost line evaluates at adoption share s, derived from the same users-first adoptersAtShare(s) quantity trafficViewsPerMonth uses above. */
export function subscribersAtShare(share: number): number {
  return adoptersAtShare(share) * SUBSCRIBER_CONVERSION
}

/**
 * ASSUMED. Vercel Edge (CDN) requests generated per pageview: the HTML
 * document, the JS/CSS bundle, and a couple of API calls
 * (/api/events-first-page, /api/pageviews). No measured baseline exists for
 * this - Vercel's usage dashboard reports a total, not a per-pageview rate -
 * so this is a documented estimate, not a measurement. The model's
 * second-weakest spot after VERCEL_IMAGE_TRANSFORMATIONS_PER_MONTH below.
 */
export const VERCEL_EDGE_REQUESTS_PER_VIEW = 6

/**
 * ASSUMED. Vercel Function invocations per pageview. Most reads are served
 * from the CDN's edge cache rather than executing a function - both
 * /api/events-first-page (48-row head cache) and /api/pageviews (day-long
 * cache) are designed around that - so an actual invocation is the
 * exception, not the rule. Held low and documented rather than measured.
 */
export const VERCEL_FUNCTION_INVOCATIONS_PER_VIEW = 0.05

/**
 * ASSUMED. Unique source images refreshed across the event corpus per
 * month. Image transformations are billed per (source image, size) pair on
 * cache MISS/STALE (vercel.json: 31-day minimumCacheTTL), so this tracks the
 * event corpus turning over, NOT reader traffic - the reason this whole line
 * is a flat add-on rather than a traffic-scaled component. No telemetry
 * counts actual transformations, so this is the model's most speculative
 * figure; a future maintainer with real usage-dashboard numbers should
 * replace it.
 */
export const IMAGE_CORPUS_ESTIMATE = 1500

/** MEASURED, vercel.json `images.sizes`, checked 2026-08-17: 3 configured output sizes. */
export const VERCEL_IMAGE_SIZES = 3

/** MEASURED, vercel.json `images.formats`, checked 2026-08-17: avif and webp. */
export const VERCEL_IMAGE_FORMATS = 2

/** MEASURED, vercel.com/docs/image-optimization/limits-and-pricing, checked 2026-08-17: on-demand rate, low end of the $0.05-$0.0812/1k regional range. */
export const VERCEL_IMAGE_RATE_PER_1K = 0.05

/** DERIVED. Modeled image transformations per month: corpus x sizes x formats. */
export const VERCEL_IMAGE_TRANSFORMATIONS_PER_MONTH =
  IMAGE_CORPUS_ESTIMATE * VERCEL_IMAGE_SIZES * VERCEL_IMAGE_FORMATS

/** DERIVED, rounded up to the whole dollar. Vercel's flat, corpus-driven image-transformation add-on, the same at every adoption share - see COST_LINES' 'vercel' entry. */
export const VERCEL_IMAGE_TRANSFORM_MONTHLY =
  Math.ceil((VERCEL_IMAGE_TRANSFORMATIONS_PER_MONTH / 1000) * VERCEL_IMAGE_RATE_PER_1K)

/** MEASURED, resend.com/pricing, checked 2026-08-17. Context only - not used by the schedule below; see RESEND_PRO_PRICE's comment for why. */
export const RESEND_FREE_DAILY_CAP = 100

/** MEASURED, resend.com/pricing, checked 2026-08-17. Context only, same reason as RESEND_FREE_DAILY_CAP. */
export const RESEND_FREE_INCLUDED_EMAILS = 3000

/**
 * MEASURED, resend.com/pricing, checked 2026-08-17: Pro plan, $20/mo. This
 * schedule treats Pro as the permanent floor rather than branching on Free:
 * the weekly digest sends the whole list in one morning, so Free's
 * RESEND_FREE_DAILY_CAP (100/day) is the binding limit, not its monthly
 * cap, and subscribersAtShare(0.01) - the calculator slider's minimum
 * position - already exceeds 100. No reachable slider position uses Free,
 * so modeling the branch would add a conditional that never fires.
 */
export const RESEND_PRO_PRICE = 20

/** MEASURED, resend.com/pricing, checked 2026-08-17: Pro plan, 50,000 emails/mo included. */
export const RESEND_PRO_INCLUDED_EMAILS = 50000

/**
 * MEASURED, resend.com/pricing, checked 2026-08-17: $0.90 per 1,000 emails
 * beyond a paid plan's included volume. Scale ($90/mo, 100,000 included)
 * charges the SAME overage rate, so Pro + overage is cheaper than Scale at
 * every volume this model reaches (Pro's $20 base stays $70/mo below
 * Scale's $90 base, and the identical overage rate never closes that gap) -
 * Scale is not modeled for that reason.
 */
export const RESEND_OVERAGE_PER_1000_EMAILS = 0.90

/** Weeks per month (365.25 / 7 / 12), for the weekly digest's send rate. */
export const DIGEST_SENDS_PER_MONTH = 4.33

/** ASSUMED. Transactional email volume per month outside the weekly digest: subscribe confirmations, embed-request/feedback/pending-event notifications, preference changes (supabase/functions/subscribe, notify-embed-request, notify-feedback, notify-pending-event, preferences). No per-message telemetry exists, so this is a small, round, documented estimate. */
export const TRANSACTIONAL_EMAILS_PER_MONTH = 20

/** A cost line's driver: what its usage responds to. */
export type CostDriver = 'flat' | 'traffic' | 'subscribers'

/**
 * The bill's priority groups, in display order. The page renders a heading
 * row where each group starts, so a reader can see exactly where the core
 * technologies end and the discretionary lines begin (Byron, 2026-08-17).
 * COST_LINES must keep each group's lines contiguous and in this order.
 */
export const COST_GROUPS = [
  { key: 'core', label: 'Core technologies' },
  { key: 'nice', label: 'Nice to have' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'people', label: 'People' },
] as const

export type CostGroupKey = (typeof COST_GROUPS)[number]['key']

interface CostLineBase {
  /** Stable key (used as the React list key). */
  key: string
  /** Display name. Vendor lines link out via `url`; internal lines don't. */
  label: string
  /** Vendor pricing page, when the line is a vendor. */
  url?: string
  /** One-line plain-language description of what the money buys. */
  description: string
  /** Which priority group the line renders under; see COST_GROUPS. */
  group: CostGroupKey
}

/**
 * A line whose cost does not respond to reader traffic or the subscriber
 * list. Most flat lines carry the SAME number at flatToday and flatAtScale
 * (Claude Max, domain, maps, the GitHub Actions scraper line - nothing
 * about county adoption changes what they cost). The few that don't
 * (the proxy's headroom, and the three labor/marketing budgets) differ for
 * a reason unrelated to traffic - source-corpus growth, or "we've hired
 * part-time help" - so lineCostMonthly interpolates linearly between
 * flatToday and flatAtScale across the adoption share (Byron, 2026-08-17,
 * labeled modeled: more people served plausibly means proportionally more
 * human time). An earlier draft held flatToday until s=1.0 and stepped
 * once at the top, which was more literal about "did we hire someone" but
 * produced a 10x cost cliff on the slider's last tick that read as a bug.
 * Lines with equal figures are unaffected by the interpolation.
 */
export interface FlatCostLine extends CostLineBase {
  driver: 'flat'
  /** The real, current monthly bill for this line. */
  flatToday: number
  /** The modeled figure at full county adoption (s = 1.0). */
  flatAtScale: number
}

/**
 * One metered dimension of a traffic- or subscriber-driven line - e.g.
 * Vercel's Fast Data Transfer versus its Edge Requests each have their own
 * conversion ratio, included quota, and overage rate, so a line can declare
 * more than one of these.
 */
export interface MeteredComponent {
  /** Which vendor line item this is, for the next person reading the schedule. */
  label: string
  /** Native usage units generated per unit of the line's driver value (e.g. GB of egress per pageview). */
  perDriverUnit: number
  /** Native usage units added regardless of the driver value - a small, named, documented constant. Omit when there is none. */
  extraUsage?: number
  /** Usage included in planPrice, in the same native unit as perDriverUnit. */
  included: number
  /** Dollars charged per `rateUnit` of usage beyond `included`. */
  overageRate: number
  /** The unit overageRate is quoted per - 1 for "per GB", 1000000 for "per 1M requests", 1000 for "per 1k emails". */
  rateUnit: number
}

/** A line whose cost responds to monthly pageviews ('traffic') or the subscriber list ('subscribers'). */
/**
 * One rung of a stepped vendor add-on (Byron, 2026-08-17: "make it a clear
 * step. I want people to see at what volume these things scale"). Unlike a
 * metered component, a step is a discrete plan-shaped jump: the vendor
 * sells sizes, not units, so the model should bill sizes and the page
 * should SHOW the thresholds. Rendered as a visible strip under the line
 * in the cost table, with the step active at the current slider position
 * highlighted.
 */
export interface CostStep {
  /** Display name, usually the vendor's own size name (Micro, Small...). */
  label: string
  /**
   * Highest driver value (views/mo for traffic lines) this step covers;
   * null means it holds to the model's ceiling. Steps must be listed in
   * ascending threshold order, null last - the evaluator takes the first
   * step whose threshold covers the driver value.
   */
  upToDriverValue: number | null
  /** Dollars this step ADDS to the monthly bill (net of any plan credit). */
  monthlyExtra: number
}

export interface MeteredCostLine extends CostLineBase {
  driver: 'traffic' | 'subscribers'
  /** Monthly plan price at the tier this schedule uses as its floor (see each line's comment for why the floor is the paid tier, not Free). */
  planPrice: number
  components: MeteredComponent[]
  /**
   * A dollar amount added on top of the metered components regardless of
   * the driver value. Used exactly once, for Vercel's image
   * transformations, which are corpus-driven rather than traffic-driven -
   * see VERCEL_IMAGE_TRANSFORM_MONTHLY.
   */
  flatAddOn?: number
  /** Discrete plan-size steps added on top; see CostStep. Supabase compute today. */
  steps?: CostStep[]
}

export type CostLine = FlatCostLine | MeteredCostLine

/** The driver value a cost line evaluates at adoption share `share` (0..1). Flat lines interpret the share directly (see lineCostMonthly); traffic and subscriber lines convert it through trafficViewsPerMonth / subscribersAtShare. */
export function driverValueForShare(line: CostLine, share: number): number {
  switch (line.driver) {
    case 'traffic': return trafficViewsPerMonth(share)
    case 'subscribers': return subscribersAtShare(share)
    case 'flat': return share
  }
}

/** The driver value a cost line evaluates at TODAY - measured directly, not derived from a share. */
export function driverValueToday(line: CostLine): number {
  switch (line.driver) {
    case 'traffic': return TODAY_VIEWS_PER_MONTH
    case 'subscribers': return TODAY_SUBSCRIBERS
    // Flat lines interpret their driver value as a share; 0 reads as "not
    // at the s=1.0 ceiling", the same as any other sub-100% slider position.
    case 'flat': return 0
  }
}

/**
 * Evaluates one cost line's monthly bill at a given driver value: plan
 * price plus metered overage (or, for a flat line, whichever of its two
 * authored figures the driver value selects). Rounded up to the whole
 * dollar, the same "round against us" convention every other figure in this
 * file uses.
 */
export function lineCostMonthly(line: CostLine, driverValue: number): number {
  if (line.driver === 'flat') {
    // driverValue is the adoption share (0..1) for flat lines; clamp so a
    // caller can never extrapolate a budget past its authored at-scale
    // figure or below today's real bill.
    const share = Math.min(1, Math.max(0, driverValue))
    return Math.ceil(line.flatToday + (line.flatAtScale - line.flatToday) * share)
  }
  let total = line.planPrice
  for (const component of line.components) {
    const usage = driverValue * component.perDriverUnit + (component.extraUsage ?? 0)
    const overageUnits = Math.max(0, usage - component.included) / component.rateUnit
    total += overageUnits * component.overageRate
  }
  if (line.steps) total += line.steps[activeStepIndex(line.steps, driverValue)].monthlyExtra
  return Math.ceil(total + (line.flatAddOn ?? 0))
}

/**
 * Which step of a stepped line is active at a driver value: the first step
 * whose threshold covers it, the null-threshold (ceiling) step otherwise.
 * Exported because the cost table's step strip highlights the same index -
 * one lookup, so the billed step and the highlighted chip can never differ.
 */
export function activeStepIndex(steps: CostStep[], driverValue: number): number {
  const i = steps.findIndex(
    (s) => s.upToDriverValue !== null && driverValue <= s.upToDriverValue,
  )
  return i === -1 ? steps.length - 1 : i
}

/** A line's real, current monthly bill. */
export function lineMonthlyToday(line: CostLine): number {
  return lineCostMonthly(line, driverValueToday(line))
}

/** A line's modeled monthly bill at adoption share `share` (0..1) - what the live "At this adoption" column and the calculator's cost line both read. */
export function lineMonthlyAtShare(line: CostLine, share: number): number {
  return lineCostMonthly(line, driverValueForShare(line, share))
}

/**
 * The full monthly bill, in PRIORITY ORDER (Byron, 2026-08-17), not by
 * amount: first the core infrastructure that keeps the site up and the data
 * flowing, then nice-to-have services (email, maps), then marketing, then
 * the people lines (with the Claude Max tooling that stands in for them).
 * The page renders this array top to bottom, so a reader meets the
 * necessities before any discretionary line. Within a group, paid lines
 * come before $0 ones. $0 lines are listed on purpose: "this is free" is
 * half the transparency story, and keeping the line visible means a future
 * change is an amount edit, not a page redesign. Today's and At-scale's
 * dollar figures are never typed here - TIER_TOTALS below evaluates every
 * line through lineMonthlyToday / lineMonthlyAtShare, so the table and the
 * adoption slider read the same schedules.
 *
 * Today's column is verified against actual plan state: the Supabase org is
 * on the Pro plan and Vercel moved to Pro on 2026-08-08. Both traffic
 * schedules below use Pro as a FLOOR at every adoption share, never
 * modeling a downgrade to Free - this is a live production service, and the
 * org is already committed to Pro for reasons Free doesn't offer (no forced
 * pause after a week of inactivity, daily backups, higher connection
 * limits) regardless of usage volume.
 */
export const COST_LINES: CostLine[] = [
  // ── Core: the site does not run without these ──────────────────────────
  {
    key: 'supabase',
    group: 'core',
    label: 'Supabase',
    url: 'https://supabase.com/pricing',
    description: 'The database: every event, venue, and subscriber',
    driver: 'traffic',
    planPrice: 25,
    components: [
      // supabase.com/pricing, checked 2026-08-17: Pro is $25/mo with 250 GB
      // egress included, then $0.09/GB. DB size stays flat - the corpus
      // (events, venues) is small. Team ($599/mo) buys SSO and compliance
      // certifications, not a bigger egress allotment (same 250 GB / $0.09
      // schedule as Pro on the pricing-page compare table), so a
      // cost-minimizing schedule never selects it. Compute is NOT flat: it
      // steps - see `steps` below.
      { label: 'Egress', perDriverUnit: SUPABASE_GB_PER_VIEW, included: 250, overageRate: 0.09, rateUnit: 1 },
    ],
    // Database COMPUTE, as discrete size steps (Byron, 2026-08-17: the
    // earlier model held compute flat on Pro's included credit, which
    // understated cost at high adoption; and the steps must be VISIBLE -
    // "I want people to see at what volume these things scale". The page
    // renders this schedule as a chip strip under the line).
    //
    // PRICES are published: supabase.com/docs/guides/platform/compute-and-disk
    // (checked 2026-08-17): Micro ~$10/mo, Small ~$15, Medium ~$60, Large
    // ~$110. Each step's monthlyExtra is net of Pro's $10/mo compute
    // credit, which fully covers Micro - that is why today's real bill
    // shows no compute line item.
    //
    // THRESHOLDS are ASSUMED - Supabase publishes no views-to-size table.
    // The reasoning is connection capacity plus edge-cache offload: most
    // pageviews are served from Vercel's edge cache and never reach
    // Postgres, and the published pooler client caps step 200 (Micro) /
    // 400 (Small) / 600 (Medium) / 800 (Large), so the sizes are placed at
    // round order-of-magnitude traffic bands: Micro to 500k views/mo,
    // Small to 2M, Medium to 5M, Large to the 10M ceiling. Deliberately
    // conservative (steps come earlier than the caps likely require), so
    // the modeled bill errs high. Change a threshold here and the billed
    // step, the test guards, and the rendered strip all move together.
    steps: [
      { label: 'Micro', upToDriverValue: 500000, monthlyExtra: 0 },
      { label: 'Small', upToDriverValue: 2000000, monthlyExtra: 5 },
      { label: 'Medium', upToDriverValue: 5000000, monthlyExtra: 50 },
      { label: 'Large', upToDriverValue: null, monthlyExtra: 100 },
    ],
  },
  {
    key: 'vercel',
    group: 'core',
    label: 'Vercel',
    url: 'https://vercel.com/pricing',
    // No third-party CDN sits in front of this. A 2026-08-14 header check on
    // akronpulse.com returned `server: Vercel` with no Cloudflare markers, so
    // the earlier "behind a free CDN" phrasing described an architecture we
    // do not run. Vercel's own edge cache is included in this line's price.
    description: 'Hosting, edge delivery, and image optimization',
    driver: 'traffic',
    planPrice: 20,
    components: [
      // vercel.com/pricing + vercel.com/docs/manage-cdn-usage, both checked
      // 2026-08-17. Pro includes 1,000 GB Fast Data Transfer/mo then
      // $0.15/GB; 10M Edge Requests/mo then $2 per 1M; 1M Function
      // invocations/mo then $0.60 per 1M. Only Fast Data Transfer has a
      // measured per-view baseline (VERCEL_GB_PER_VIEW); edge requests and
      // invocations use the documented, ASSUMED per-view rates above -
      // there is no per-request export on Vercel's usage dashboard to
      // measure them from.
      { label: 'Fast data transfer', perDriverUnit: VERCEL_GB_PER_VIEW, included: 1000, overageRate: 0.15, rateUnit: 1 },
      { label: 'Edge requests', perDriverUnit: VERCEL_EDGE_REQUESTS_PER_VIEW, included: 10000000, overageRate: 2, rateUnit: 1000000 },
      { label: 'Function invocations', perDriverUnit: VERCEL_FUNCTION_INVOCATIONS_PER_VIEW, included: 1000000, overageRate: 0.60, rateUnit: 1000000 },
    ],
    // Image transformations are corpus-driven, not traffic-driven (billed
    // per source image per size, cached 31 days - vercel.json's
    // minimumCacheTTL), so this is a flat add-on rather than a fourth
    // metered component: it does not respond to the adoption slider at
    // all, at any position. See VERCEL_IMAGE_TRANSFORM_MONTHLY's comment
    // for the corpus estimate and why it is this model's least-grounded
    // figure - the documented weak spot ASSUMPTIONS calls out below.
    flatAddOn: VERCEL_IMAGE_TRANSFORM_MONTHLY,
  },
  {
    key: 'proxy',
    group: 'core',
    label: 'DataImpulse',
    url: 'https://docs.dataimpulse.com/proxies',
    // Named vendor + docs link on purpose (Byron, 2026-08-17) - same
    // treatment as every other vendor line; the residential rate is $1/GB.
    // Measured usage (provider's own log, checked 2026-08-17) is far LOWER
    // than this line: effective rate ~$1/GB, one nightly run ~166 proxied
    // requests at mostly tens-to-hundreds of KB - under a dollar a month.
    // Held at $5 anyway (Byron, 2026-08-17): usage-billed bandwidth is the
    // easiest line to spike (one new bot-challenged source, one asset-heavy
    // page), so the table carries deliberate headroom rather than the
    // measured floor. This errs against us, which is the right direction.
    // FLAT, not traffic-driven: scraping load tracks the SOURCE CORPUS
    // (how many sites we scrape), not reader traffic, so the at-scale
    // figure ($20) is headroom for a bigger source corpus, not a function
    // of reader adoption; like every flat line it interpolates linearly
    // across the slider (see FlatCostLine's comment).
    // Known fat worth trimming someday: the headless-browser sources pull
    // third-party assets (analytics, ad pixels, CDN fonts) through the
    // metered proxy; request-blocking those would cut billed bandwidth.
    description:
      'Residential proxy bandwidth ($1/GB) for the handful of sources that block datacenter traffic',
    driver: 'flat',
    flatToday: 5,
    flatAtScale: 20,
  },
  {
    key: 'domain',
    group: 'core',
    label: 'Domain',
    url: 'https://www.hover.com/',
    // Registrar corrected 2026-08-17: the domain is at Hover, not Cloudflare
    // - the old link named a registrar we don't use, and its "wholesale
    // renewal" framing priced a plan we aren't on. Verified from the Hover
    // dashboard: $18.99/yr renewal, auto-renew on = $1.58/mo, rounded UP to
    // the whole-dollar floor like every line here.
    description: 'akronpulse.com, registered at Hover ($18.99/yr)',
    driver: 'flat',
    flatToday: 2,
    flatAtScale: 2,
  },
  {
    key: 'workspace',
    group: 'core',
    label: 'Google Workspace',
    url: 'https://workspace.google.com/pricing',
    // Byron's stated monthly bill, 2026-09-02 - not a list-price derivation.
    description: 'Email for akronpulse.com (byron@ and intake@ mailboxes)',
    driver: 'flat',
    flatToday: 34,
    flatAtScale: 34,
  },
  {
    key: 'scrapers',
    group: 'core',
    label: 'Data collection',
    url: 'https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions',
    // Not "volunteer hardware": .github/workflows/nightly-scrape.yml runs
    // `runs-on: ubuntu-latest`, i.e. GitHub-hosted runners. They cost nothing
    // because the repository is public, which is a real vendor dependency and
    // belongs on a page that claims to publish the complete bill - see
    // ASSUMPTIONS.
    description: `${ACTIVE_SOURCE_COUNT} scrapers run nightly on GitHub Actions, free while the repository is public`,
    driver: 'flat',
    flatToday: 0,
    flatAtScale: 0,
  },
  // Claude Max sits with the core lines (Byron, 2026-08-17: "Claude should
  // be above email"): it is the tooling that keeps the scrapers and the
  // data quality alive, so it reads as operational, not discretionary. Its
  // description still points at the labor lines it stands in for, which
  // remain below.
  {
    key: 'claude',
    group: 'core',
    label: 'Claude Max',
    url: 'https://claude.com/pricing',
    description:
      'AI tooling: scraper upkeep, nightly data-quality review. This line is what stands in for the data administration and development lines below, which read $0 because nobody has been paid for that time',
    driver: 'flat',
    flatToday: 100,
    flatAtScale: 100,
  },
  // ── Nice to have: the site runs without these, readers would miss them ──
  {
    key: 'email',
    group: 'nice',
    label: 'Email digests',
    url: 'https://resend.com/pricing',
    description: 'Subscriber digests via Resend; grows with the subscriber list',
    driver: 'subscribers',
    planPrice: RESEND_PRO_PRICE,
    components: [
      {
        label: 'Emails',
        perDriverUnit: DIGEST_SENDS_PER_MONTH,
        extraUsage: TRANSACTIONAL_EMAILS_PER_MONTH,
        included: RESEND_PRO_INCLUDED_EMAILS,
        overageRate: RESEND_OVERAGE_PER_1000_EMAILS,
        rateUnit: 1000,
      },
    ],
  },
  {
    key: 'maps',
    group: 'nice',
    label: 'Maps',
    url: 'https://openfreemap.org',
    // OpenFreeMap is donation funded and publishes no SLA. Promising "free
    // and unlimited at any traffic" put a guarantee in our mouths that its
    // operator has never made, on a modeled 10M views/mo row.
    description: 'MapLibre + OpenFreeMap, free to use, community funded',
    driver: 'flat',
    flatToday: 0,
    flatAtScale: 0,
  },
  // ── Marketing ───────────────────────────────────────────────────────────
  {
    key: 'marketing',
    group: 'marketing',
    label: 'Marketing and advertising',
    // Today $0 is the truth: growth comes from partners, SEO, and word of
    // mouth, and a boosted post or a print run belongs in ONE_OFF_EXPENSES.
    // At scale, $500/mo is ~10% of the operating budget - the middle of the
    // 5-15% small-nonprofit norm - covering local social ads, event-season
    // print, and community sponsorships across the region. FLAT for the
    // same reason as data-admin and dev below.
    description:
      'Getting the word out: print, social, and event promotion. Nothing spent yet; the at-scale column budgets ~10% of operating costs',
    driver: 'flat',
    flatToday: 0,
    flatAtScale: 500,
  },
  // ── People: the labor lines (stood in for by Claude Max, in core above) ──
  {
    key: 'data-admin',
    group: 'people',
    label: 'Data administration',
    // Split from "development and upkeep" (Byron, 2026-08-17): tending the
    // DATA is a different job than building the software, and a funder
    // reading the at-scale scenario should see both named. At-scale labor
    // budgets (Byron, same day): $500 data administration, $2,500
    // development - building the software for a whole region is the bigger
    // job. Today stays $0 on both because that is the truth: nobody has
    // been paid. Interpolates linearly across the slider like every flat
    // line (see FlatCostLine's comment).
    description:
      "Curating the dataset: review queue, dedupe, venue and category fixes, partner listings. Nobody's been paid yet; the at-scale column budgets part-time paid work",
    driver: 'flat',
    flatToday: 0,
    flatAtScale: 500,
  },
  {
    key: 'dev',
    group: 'people',
    label: 'Development and upkeep',
    // At-scale derivation, so this number is hours × rate rather than a
    // guess: $2,500/mo ≈ 22-29 contractor hours at Midwest freelance rates
    // ($85-115/hr) - a fractional engineer at 5-7 hrs/week. That is the
    // credible floor for a region-scale service partners embed (implied
    // uptime + support), and it is only viable that lean because the Claude
    // Max line above carries the AI-assisted leverage. A half-FTE would
    // overshoot a product this automated; 2-3 hrs/week undershoots the
    // reliability claim. Flat, interpolating, same as data-admin above.
    description:
      "Building and maintaining the software: new features, bug fixes, infrastructure. Nobody's been paid yet; the at-scale column budgets a fractional engineer (~25 hours a month at regional contract rates)",
    driver: 'flat',
    flatToday: 0,
    flatAtScale: 2500,
  },
]

/** Formats a whole-dollar amount for display, e.g. money(173) -> "$173".
 *  The one place this page (and anywhere else that quotes a dollar figure
 *  derived from this module) formats money, so a comma convention or a
 *  cents decision only ever needs to change here. */
export const money = (n: number) => `$${n.toLocaleString()}`

/** Derived total per fixed tier: [today, at-scale], each an evaluation of every line's lineMonthlyToday / lineMonthlyAtShare(1). */
export const TIER_TOTALS: TierAmounts = [
  COST_LINES.reduce((sum, line) => sum + lineMonthlyToday(line), 0),
  COST_LINES.reduce((sum, line) => sum + lineMonthlyAtShare(line, 1), 0),
]

/** Today's whole bill: services + administration + marketing. */
export const MONTHLY_TOTAL = TIER_TOTALS[TODAY_INDEX]

/** Labor + promotion lines - everything that is NOT a vendor service. One
 *  list, so a future overhead line is added HERE and every derived split
 *  below follows (the previous filter hardcoded the old 'admin' key and
 *  would have silently misfiled its replacements as services). */
const OVERHEAD_KEYS = ['data-admin', 'dev', 'marketing'] as const

/** Today's vendor services only (everything except overhead). */
export const SERVICES_TOTAL = COST_LINES
  .filter(l => !(OVERHEAD_KEYS as readonly string[]).includes(l.key))
  .reduce((sum, l) => sum + lineMonthlyToday(l), 0)

/** Today's non-service overhead (labor + marketing) for the stat breakdown. */
export const OVERHEAD_TOTAL = MONTHLY_TOTAL - SERVICES_TOTAL

/**
 * One cost group's monthly total at an adoption share: the sum of
 * lineMonthlyAtShare over every COST_LINES entry in that group. /friends
 * renders the four COST_GROUPS through this so its "whole bill at this
 * adoption" can never disagree with the /financials cost table, which
 * evaluates the same lines one at a time. test-financials-model.js pins
 * that the four groups sum to the full total at every share.
 */
export function groupMonthlyAtShare(groupKey: CostGroupKey, share: number): number {
  return COST_LINES
    .filter(l => l.group === groupKey)
    .reduce((sum, l) => sum + lineMonthlyAtShare(l, share), 0)
}

/**
 * Local spending facilitated per year at an adoption share: adults at that
 * share, each attending ADOPTION_OUTINGS_PER_USER extra thing(s) a year at
 * AEP6_LOCAL_SPEND_PER_OUTING. Both adoption sliders (/financials and
 * /friends) read this one function so they can never announce different
 * dollar figures for the same slider position.
 */
export function facilitatedSpendAtShare(share: number): number {
  return Math.round(SUMMIT_COUNTY_ADULTS * share * ADOPTION_OUTINGS_PER_USER * AEP6_LOCAL_SPEND_PER_OUTING)
}

// ── Local spending facilitated: adoption calculator ─────────────────────────
// Akron Pulse doesn't sell anything, so there is no revenue line on this
// page. What there is instead is a measured audience and an interactive
// CALCULATOR: the reader picks an adoption share of Summit County's adults
// on a slider, and the page computes the local spending one extra outing
// per person facilitates. The sourced scenarios below are the calculator's
// preset anchors, each labeled with its own assumption and its own source.
//
// History, both 2026-08-17: a single "at scale" modeled figure invited the
// wrong question ("is that number right?") instead of the right one ("which
// adoption level do you find plausible?"), so it became a rendered ladder of
// these scenarios; Byron then rejected the ladder's four-cards-of-rows
// presentation the same day and chose the calculator, which answers the
// right question more directly - the reader literally picks the assumption,
// so no one can accuse the page of picking a flattering one. See
// docs/economic-impact-research.md for the sourced research memo behind
// every input.
//
// The metric is LOCAL SPENDING FACILITATED: money that changes hands at
// Summit County venues and businesses when Akron Pulse helps someone attend
// something. The model and its figures never wear the looser "economic
// impact" label; the page's opening paragraph (authored verbatim by Byron,
// 2026-08-17) uses the phrase once as plain prose AFTER defining the
// precise metric, which is the one sanctioned exception - do not spread it
// to figure labels or headings. Precise language carries the accuracy; this
// model does not run a second argument about how much of that spending is
// net-new to the county versus reallocated from elsewhere in it. That
// argument is real and belongs in docs/economic-impact-research.md §5; it is
// deliberately not reproduced here.
//
// Cost and this section are still NOT modeled on the same axis. The cost
// model above budgets for TRAFFIC: the at-scale ceiling assumes ~10M
// views/mo, a figure that includes large partner-embed audiences syndicated
// onto other platforms, plus tourists and search traffic passing through.
// None of those viewers are necessarily local, but every one of them costs
// server time, so the cost model has to plan for them anyway. This section
// counts something narrower and harder to inflate: people who could
// physically attend a local event.
//
// Every rung after "Today" assumes the same local spend per outing: $29.77
// per person, excluding admission, the LOCAL-ATTENDEE figure from Americans
// for the Arts' AEP6 study (the national all-attendee figure is higher, at
// $38.46; local-attendee is the right one because Akron Pulse's audience is
// overwhelmingly county residents, not visitors passing through). No AEP6
// study region exists for Akron or Summit County itself, so this is a
// national figure applied locally, and the page says so. A widely-circulated
// "$27.18 Cleveland" figure is Cleveland, TENNESSEE, not Ohio - never use it.
//
// Reach for "Today" is MEASURED and goes stale fast. Every adoption share,
// outing rate, and spend figure on every other rung is ASSUMED or MODELED
// from published research and should almost never change; changing one is a
// claim about the world, not a routine data refresh.

/** Last day of the GA4 windows above and below. Guarded for staleness by the model test. */
export const REACH_MEASURED_THROUGH = '2026-08-17'

/**
 * DERIVED from TODAY_MONTHLY_ACTIVE_USERS above - same GA4 measurement
 * (totalUsers, last 30 days ending REACH_MEASURED_THROUGH), kept as its own
 * name because this section reads it as reach CONTEXT for the impact
 * ladder, not as the users-first traffic driver TIERS names it as; deriving
 * rather than re-typing the figure means the two can never drift apart.
 * Context, not an input to the model: about 91% of the trailing year's
 * traffic arrived in this 30-day window behind a single
 * news5cleveland.com referral, and that spike is already decaying (549
 * users on 08-14, then 136, then 118). ANNUAL_UNIQUE_USERS therefore
 * understates the current run rate, and this figure overstates the steady
 * state. The page states both, plainly, rather than picking whichever one
 * flatters.
 */
export const LAST_30D_USERS = TODAY_MONTHLY_ACTIVE_USERS

/**
 * ASSUMED, and the load-bearing input in the "Today" rung of the ladder.
 * Share of annual unique users who attend one outing a year they would
 * otherwise have missed. No measurement exists for this; it is the number
 * most worth arguing with, and the page labels it that way.
 */
export const OUTING_CONVERSION = 0.10

/**
 * ASSUMED. "Today" rung's local spend per outing: parking plus something
 * small. Deliberately conservative - not a ticket price, not a night out.
 */
export const SPEND_PER_OUTING = 25

/**
 * MODELED. Local (in-county) attendee spend per outing, excluding admission.
 * Americans for the Arts, AEP6 (Oct 2023, FY2022 data) - see AEP6_SOURCE.
 * Used for every ladder rung above "Today": these rungs model a county
 * that has adopted Akron Pulse as its standard calendar, so the published
 * local-attendee figure is the right spend assumption, not the deliberately
 * low $25 "Today" figure above.
 */
export const AEP6_LOCAL_SPEND_PER_OUTING = 29.77

// Preset levels rewritten AGAIN 2026-08-17 (Byron, superseding both the
// Nextdoor/library comparisons and the civic-habit anchors that replaced
// them for a few hours): the chips are now PLAIN NAMED LEVELS - Today
// (measured, derived, moves as the site grows), then Small 15%, Medium 30%,
// Large 50%, Optimistic 75%, Everyone 100%. No external-brand comparison to
// defend or go stale; the only sourced inputs left in the calculator are
// the adult count (Census) and the spend figure (AEP6). The slider's FLOOR
// is Today - 0% cannot be reached ("no adoption" is not a scenario this
// page entertains), and nobody can scroll below where the site already is.

/**
 * DERIVED, from measurement. Today's actual adoption share: measured annual
 * unique users over Summit County's adults (~0.7% at the 2026-08-17
 * measurement). This is the slider's floor and the Today chip's position,
 * and it MOVES: re-measure ANNUAL_UNIQUE_USERS and today's floor climbs
 * with it, so the page always shows where the site actually is.
 */
export const TODAY_ADOPTION_SHARE = ANNUAL_UNIQUE_USERS / SUMMIT_COUNTY_ADULTS

/** ASSUMED. Named adoption levels (Byron, 2026-08-17): round, plainly stated, no external comparison. */
export const SMALL_ADOPTION_SHARE = 0.15
export const MEDIUM_ADOPTION_SHARE = 0.30
export const LARGE_ADOPTION_SHARE = 0.50
export const OPTIMISTIC_ADOPTION_SHARE = 0.75

/**
 * ASSUMED. Outings per user per year for every adoption-ladder rung above
 * "Today": one outing a user would otherwise have missed. Simpler and more
 * conservative than a fractional conversion rate - each rung's users attend
 * exactly one additional thing a year, never more.
 */
export const ADOPTION_OUTINGS_PER_USER = 1

// ── Adoption slider (shared by /financials and /friends) ────────────────────
// The slider FLOOR is Today (Byron, 2026-08-17): 0% is not a scenario the
// site entertains, and nobody can model less adoption than has already been
// measured. Derived from the measured share, so the floor climbs as the site
// grows; clamped to 1 because the range input is integer-stepped.
export const SLIDER_MIN_PERCENT = Math.max(1, Math.round(TODAY_ADOPTION_SHARE * 100))

// Starting slider position: Today - the page opens where the site actually
// is, the most conservative position that exists, and the reader moves it
// up themselves or not at all.
export const DEFAULT_ADOPTION_PERCENT = SLIDER_MIN_PERCENT

// One analytics hit per settled slider position, not one per tick of a drag.
export const SLIDER_SETTLE_MS = 800

/** aria-valuetext for both adoption sliders, one wording. */
export function adoptionValueText(percent: number): string {
  return `${percent}% of adults, about ${money(facilitatedSpendAtShare(percent / 100))} a year`
}

/** A cited source: a label and the URL it links to. Every non-"assumed" input below carries one. */
export interface ImpactSource {
  label: string
  url: string
}

export const CENSUS_SOURCE: ImpactSource = {
  label: 'Census QuickFacts, Summit County, OH',
  url: 'https://www.census.gov/quickfacts/fact/table/summitcountyohio/PST045225',
}
// (The preset-anchor sources that briefly lived here - Nextdoor/library,
// then Edison podcasts / Pew local news / Pew broadband - left with their
// scenarios on 2026-08-17. The named levels carry no external comparison,
// so CENSUS_SOURCE and AEP6_SOURCE are the calculator's only citations.)
export const AEP6_SOURCE: ImpactSource = {
  label: 'Americans for the Arts, AEP6 study findings',
  url: 'https://aep6.americansforthearts.org/study-findings',
}

/**
 * The page's provenance vocabulary. Fixed at these four words on purpose -
 * they match the fin-prov chip already used elsewhere on this page. Do not
 * add a fifth; map a new input onto the closest of these instead.
 */
export type Provenance = 'measured' | 'derived' | 'modeled' | 'assumed'

export interface ImpactScenario {
  key: string
  label: string
  /** True only for the ceiling rung. Always rendered as a ceiling, never a forecast. */
  isCeiling?: boolean
  /** Measured annual users - "Today" only. */
  measuredUsers?: number
  usersProvenance: Provenance
  usersNote: string
  usersSource?: ImpactSource
  /** Share of Summit County adults assumed to use Akron Pulse - every rung but "Today". */
  shareOfAdults?: number
  outingsPerUser: number
  outingsProvenance: Provenance
  spendPerOuting: number
  spendProvenance: Provenance
  spendNote: string
  spendSource?: ImpactSource
}

/**
 * THE one array. A future edit to a scenario's adoption share, outing rate,
 * or spend figure happens exactly here; every rendered number and the guard
 * tests in scripts/tests/test-financials-impact-model.js derive from it.
 */
export const IMPACT_SCENARIOS: ImpactScenario[] = [
  {
    key: 'today',
    label: 'Today',
    measuredUsers: ANNUAL_UNIQUE_USERS,
    // shareOfAdults ALSO set (2026-08-17): Today is a slider chip now, and
    // the slider's floor - see TODAY_ADOPTION_SHARE. The ladder row still
    // computes from measuredUsers with the deliberately low Today
    // assumptions below; the chip snaps the slider to the same share, where
    // the calculator applies its own (1 outing x AEP6) model. Both are
    // honest: one is what we measure, the other is what the model says
    // about the same number of people.
    shareOfAdults: TODAY_ADOPTION_SHARE,
    usersProvenance: 'measured',
    usersNote: `Google Analytics, trailing 365 days through ${REACH_MEASURED_THROUGH}.`,
    outingsPerUser: OUTING_CONVERSION,
    outingsProvenance: 'assumed',
    spendPerOuting: SPEND_PER_OUTING,
    spendProvenance: 'assumed',
    spendNote: 'Parking and something small. Not a ticket price, not a night out. Picked low on purpose.',
  },
  {
    key: 'small',
    label: 'Small',
    shareOfAdults: SMALL_ADOPTION_SHARE,
    usersProvenance: 'assumed',
    usersNote:
      `${Math.round(SMALL_ADOPTION_SHARE * 100)}% of Summit County's adults use Akron Pulse at ` +
      'least once a year. A named level, stated plainly, not a comparison to anything.',
    outingsPerUser: ADOPTION_OUTINGS_PER_USER,
    outingsProvenance: 'assumed',
    spendPerOuting: AEP6_LOCAL_SPEND_PER_OUTING,
    spendProvenance: 'modeled',
    spendNote: 'Local-attendee spending per outing, excluding admission.',
    spendSource: AEP6_SOURCE,
  },
  {
    key: 'medium',
    label: 'Medium',
    shareOfAdults: MEDIUM_ADOPTION_SHARE,
    usersProvenance: 'assumed',
    usersNote:
      `${Math.round(MEDIUM_ADOPTION_SHARE * 100)}% of Summit County's adults use Akron Pulse at ` +
      'least once a year. A named level, stated plainly, not a comparison to anything.',
    outingsPerUser: ADOPTION_OUTINGS_PER_USER,
    outingsProvenance: 'assumed',
    spendPerOuting: AEP6_LOCAL_SPEND_PER_OUTING,
    spendProvenance: 'modeled',
    spendNote: 'Local-attendee spending per outing, excluding admission.',
    spendSource: AEP6_SOURCE,
  },
  {
    key: 'large',
    label: 'Large',
    shareOfAdults: LARGE_ADOPTION_SHARE,
    usersProvenance: 'assumed',
    usersNote:
      `${Math.round(LARGE_ADOPTION_SHARE * 100)}% of Summit County's adults use Akron Pulse at ` +
      'least once a year. A named level, stated plainly, not a comparison to anything.',
    outingsPerUser: ADOPTION_OUTINGS_PER_USER,
    outingsProvenance: 'assumed',
    spendPerOuting: AEP6_LOCAL_SPEND_PER_OUTING,
    spendProvenance: 'modeled',
    spendNote: 'Local-attendee spending per outing, excluding admission.',
    spendSource: AEP6_SOURCE,
  },
  {
    key: 'optimistic',
    label: 'Optimistic',
    shareOfAdults: OPTIMISTIC_ADOPTION_SHARE,
    usersProvenance: 'assumed',
    usersNote:
      `${Math.round(OPTIMISTIC_ADOPTION_SHARE * 100)}% of Summit County's adults use Akron Pulse at ` +
      'least once a year. The name says what it is.',
    outingsPerUser: ADOPTION_OUTINGS_PER_USER,
    outingsProvenance: 'assumed',
    spendPerOuting: AEP6_LOCAL_SPEND_PER_OUTING,
    spendProvenance: 'modeled',
    spendNote: 'Local-attendee spending per outing, excluding admission.',
    spendSource: AEP6_SOURCE,
  },
  {
    key: 'ceiling',
    label: 'Everyone',
    isCeiling: true,
    shareOfAdults: 1,
    usersProvenance: 'derived',
    usersNote:
      "Every adult in Summit County. This is a ceiling, not a forecast: it requires every adult in " +
      'the county to use Akron Pulse and attend one thing they would otherwise have missed.',
    usersSource: CENSUS_SOURCE,
    outingsPerUser: ADOPTION_OUTINGS_PER_USER,
    outingsProvenance: 'assumed',
    spendPerOuting: AEP6_LOCAL_SPEND_PER_OUTING,
    spendProvenance: 'modeled',
    spendNote: 'Local-attendee spending per outing, excluding admission.',
    spendSource: AEP6_SOURCE,
  },
]

export interface ComputedImpactScenario extends ImpactScenario {
  /**
   * Unrounded users. Kept internally so the facilitated-spend figure is
   * computed from the precise adult share, not from an already-rounded
   * headcount - the same "derive from raw inputs, not rounded intermediates"
   * rule the old LOCAL_SPEND_ENABLED_BY_TIER followed.
   */
  usersUnrounded: number
  users: number
  outings: number
  facilitated: number
}

/**
 * DERIVED. The computed scenarios: the calculator's preset anchors plus the
 * measured Today figure. Every scenario is computed straight from
 * IMPACT_SCENARIOS - reach x outings-per-user x spend - never hand-typed, so
 * editing one input in the array above is the only edit a future adoption or
 * spend change needs.
 */
export const IMPACT_LADDER: ComputedImpactScenario[] = IMPACT_SCENARIOS.map((s) => {
  const usersUnrounded = s.measuredUsers ?? SUMMIT_COUNTY_ADULTS * (s.shareOfAdults ?? 0)
  return {
    ...s,
    usersUnrounded,
    users: Math.round(usersUnrounded),
    outings: Math.round(usersUnrounded * s.outingsPerUser),
    facilitated: Math.round(usersUnrounded * s.outingsPerUser * s.spendPerOuting),
  }
})

/** One preset pill on an adoption slider: a cited IMPACT_LADDER rung. */
export interface AdoptionPreset {
  key: string
  /** Integer slider position, clamped to the same floor as SLIDER_MIN_PERCENT. */
  percent: number
  label: string
  isCeiling: boolean
}

/**
 * The preset pills both adoption sliders (/financials and /friends) snap to:
 * every IMPACT_LADDER rung that carries a share of adults, as an integer
 * percent. Today is deliberately not a pill - see IMPACT_TODAY's comment.
 * Defined once here so the two pages can never offer different anchors.
 */
export const ADOPTION_PRESETS: AdoptionPreset[] = IMPACT_LADDER
  .filter((s) => s.shareOfAdults != null)
  .map((s) => ({
    key: s.key,
    percent: Math.max(1, Math.round((s.shareOfAdults ?? 0) * 100)),
    label: s.label,
    isCeiling: s.isCeiling === true,
  }))

/**
 * Cents per Summit County resident per year for a given annual dollar
 * figure, rounded UP to the nearest tenth of a cent - the same "round
 * against us" convention the whole-dollar cost lines already use. This is
 * the no-assumption framing: one census figure, zero modeling.
 */
export function centsPerResident(annualDollars: number): number {
  return Math.ceil((annualDollars / SUMMIT_COUNTY_POPULATION) * 1000) / 10
}

/**
 * What the reader has to take on trust, stated plainly and rendered in the
 * page footnote. Anything on the page that is a model rather than a bill or a
 * measurement belongs in this list. Add to it rather than quietly rounding a
 * modeled number into the prose.
 */
export const ASSUMPTIONS: string[] = [
  'Vercel overage rates are quoted list prices, not a bill we have received at that volume.',
  'Every tier above today is a usage model, not a bill we have received.',
  'Plan prices come from public vendor pricing pages, not from an invoice.',
  'Email costs assume the subscriber list grows roughly in step with traffic, and that the ratio of subscribers to annual users measured today (4.4%) holds at every adoption level - nothing guarantees that constancy.',
  // Replaces a flat guarantee that used to sit under the cost table ("spend
  // caps on every metered service mean ... never a surprise bill"). Nothing
  // in this repo configures or verifies a spend cap, and Vercel Pro's spend
  // management is opt-in and off by default, so the honest version is an
  // assumption that errs against us rather than a promise about an account
  // nobody can audit from here.
  'No spend cap is assumed on any metered service, so a traffic spike could bill above the tier shown.',
  // Surfaced by the Data collection line: the nightly scrape runs on
  // GitHub-hosted runners (.github/workflows/nightly-scrape.yml,
  // `runs-on: ubuntu-latest`), which are free for public repositories only.
  'GitHub Actions minutes are free only while this repository stays public; a private fork would pay for the nightly scrape.',
  // The one metered service that has ALREADY produced a surprise overage.
  // Event images come from hundreds of scraped hosts (vercel.json allows any
  // hostname on purpose - that is where event photos live), so the pool of
  // billable source images tracks the event corpus, not our own assets.
  // vercel.json caps the blast radius (three sizes, 31-day cache TTL), but
  // the exposure is structural.
  'Vercel image optimization is usage-metered per source image, and event images come from hundreds of external hosts. The cost line for it is a corpus estimate (1,500 unique source images refreshed a month, 3 sizes, 2 formats), not a measurement - the model\'s least-grounded figure.',
  'Vercel\'s edge-requests-per-pageview (6) and function-invocations-per-pageview (0.05) have no measured baseline either; both are documented estimates.',
  // Resend's free tier is 3,000 emails/month AND 100/day. The weekly digest
  // sends the whole list in one morning, so the DAILY cap is the binding
  // one. Confirmed subscribers hit 138 on 2026-08-17, past the 100/day
  // ceiling in a single send - this already happened, it is not a future risk.
  "The email line moved off Resend's free tier before 2026-08-17: 138 confirmed subscribers exceed the 100-sends-a-day cap the weekly digest hits in one send, so the $20/mo Pro plan is the real cost now, and stays the modeled floor at every adoption share on the slider.",
  // scripts/lib/http.js routes bot-challenged scrapers through a residential
  // proxy (SCRAPER_PROXY_URL, opt-in per source). Usage-billed bandwidth has
  // no plan price to quote; measured usage is under $1/month but the line
  // deliberately carries headroom because metered lines spike easiest.
  'The scraper proxy line is budgeted above its measured usage (about $1 per gigabyte, well under a gigabyte a month) as deliberate headroom; the at-scale figure is modeled and, like the labor budgets, only applies at full (100%) adoption on the slider - proxy load tracks the source corpus, not readers.',
  // Local spending facilitated ladder (2026-08-17, replacing a single
  // modeled figure). See the "Local spending facilitated" block above for
  // the full derivation and docs/economic-impact-research.md for the
  // sourced research memo behind it.
  'Local spending facilitated is a model, not a measurement, and none of that money comes to Akron Pulse.',
  "Today's outing rate (one in ten annual users attending an outing they would otherwise have missed) and its $25 local spend are both assumed, not measured; they are the load-bearing inputs in the Today rung and the numbers most worth arguing with.",
  'Every rung above Today assumes $29.77 in local spending per person per outing, excluding admission, the local-attendee figure from Americans for the Arts\' AEP6 study. No AEP6 study region exists for Akron or Summit County specifically, so this is a national published figure applied locally.',
  'The preset adoption levels (Small 15%, Medium 30%, Large 50%, Optimistic 75%) are named assumptions, stated plainly, compared to nothing; only Today is measured, and it doubles as the slider floor, so the calculator cannot model a world with less adoption than the site already has.',
  'The ceiling rung assumes every adult in Summit County uses Akron Pulse and attends one outing a year they would otherwise have missed. It is a ceiling, not a forecast.',
  'The measured reach figure is young and spiky: about 91% of the trailing year of traffic arrived in the last 30 days behind one referral (news5cleveland.com) that is already decaying.',
]

// ── One-off expenses ─────────────────────────────────────────────────────────
// Non-recurring purchases (equipment, printing, a table at a community event).
// Append entries as they happen; the page lists them individually and shows
// the running year total next to the monthly bill.

export interface OneOffExpense {
  /** ISO date of the purchase, e.g. '2026-08-14'. */
  date: string
  label: string
  /** Whole dollars. */
  amount: number
}

export const ONE_OFF_EXPENSES: OneOffExpense[] = [
  // Sum of every 2026 Claude invoice OUTSIDE the monthly Max plan, from the
  // account's invoice history (checked 2026-08-17): credit top-ups of
  // 3 × $48.04 and $21.35, plus $86.77 (May 28) and $148.04 (Aug 9) -
  // everything except the two $106.75 plan renewals ($100 + 6.75% Ohio
  // sales tax). As-billed the sum is $400.28, tax included - carried here as
  // $401 per the whole-dollar round-UP convention. Dated May 28, when the
  // spending started (first top-ups May 26-28); the amount aggregates
  // through Aug 9. Extend the amount (and this note) if more credits are
  // purchased later in the year.
  {
    date: '2026-05-28',
    label: 'Extra Claude tokens used to increase early stage development velocity',
    amount: 401,
  },
]

/** One-off spend in the current calendar year. */
export function oneOffTotalForYear(year: number = new Date().getFullYear()): number {
  return ONE_OFF_EXPENSES
    .filter(e => e.date.startsWith(String(year)))
    .reduce((sum, e) => sum + e.amount, 0)
}

/**
 * Cost lines a fork actually has to pay for: the paid infrastructure, with no
 * AI tooling and no administration. scripts/tests/test-financials-model.js
 * asserts every key here exists in COST_LINES, so a renamed line fails the
 * suite instead of silently dropping out of the fork figure.
 */
export const FORK_INFRA_KEYS = ['supabase', 'vercel', 'domain'] as const

/**
 * What another community would pay in infrastructure to run a fork at our
 * current scale (Supabase Pro + Vercel Pro + domain, no AI tooling, no admin).
 *
 * DERIVED from COST_LINES via lineMonthlyToday, never hand-copied. This was
 * a literal 46 until 2026-08-14, which meant changing Supabase from 25 to 35
 * left the fork figure reading 46 and rendering wrong on the page with every
 * gate green.
 *
 * This is the paid-plan figure, NOT a floor. A fork genuinely starts at $0:
 * both Supabase and Vercel have free tiers that comfortably hold a calendar
 * this size, and the page says so. Quoting the paid figure as the starting
 * price told exactly the wrong story to the small community most likely to
 * fork this.
 */
export const FORK_INFRA_MONTHLY = COST_LINES
  .filter(l => (FORK_INFRA_KEYS as readonly string[]).includes(l.key))
  .reduce((sum, l) => sum + lineMonthlyToday(l), 0)

/**
 * Sustained-traffic threshold for embed reporting: steady usage, not a
 * one-time referral.
 *
 * NOMINATION SIGNAL ONLY - nothing on the public page renders from it.
 * The original design auto-published any domain crossing this threshold
 * onto /financials, which meant a partner could discover themselves listed
 * rather than agreeing to it (decided against 2026-08-17, with the first
 * real partner live). The public list is EMBED_PARTNERS below: consented
 * and hand-maintained. This policy remains because api/pageviews.js still
 * reports sustained hosts (useful for spotting who to ASK), and
 * scripts/tests/test-financials-model.js asserts its constants equal the
 * API's MIN_VIEWS / MIN_WEEKS / WINDOW_DAYS so the pair cannot drift.
 */
export const EMBED_PARTNER_POLICY = {
  minViews: 100,
  minWeeks: 2,
  windowDays: 30,
} as const

/**
 * The public embed-partner list - every entry is here by AGREEMENT, never
 * by traffic alone. Ask the partner before adding them; remove on request
 * without argument. Order is the order they joined.
 */
export interface EmbedPartner {
  /** Display name, as the partner styles it. */
  name: string
  /** Bare host, shown as the secondary line. */
  host: string
  /** The page carrying the embed (or the site root if they'd rather). */
  url: string
}

export const EMBED_PARTNERS: EmbedPartner[] = [
  {
    name: 'Everyday Akron',
    host: 'everydayakron.com',
    url: 'https://everydayakron.com/akron-area-guides/greater-akron-area-events/',
  },
  {
    name: 'Akron Podcast',
    host: 'akronpodcast.com',
    url: 'https://www.akronpodcast.com/akron-events/',
  },
]
