/**
 * financials.ts — single source of truth for the public /financials page.
 *
 * Every figure on that page that is NOT queried live (event counts come from
 * Supabase, traffic from /api/pageviews) lives here, so updating the numbers
 * is one file edit.
 *
 * THIS MODULE IS THE COMMITTED METHODOLOGY. An earlier draft pointed readers
 * at a Word document under docs/, but docs/ is gitignored project-wide, so
 * that pointer resolved to nothing for every reader including future
 * maintainers. The model now lives here in full: the per-tier amounts, what
 * each line buys, what is measured versus modeled (ASSUMPTIONS below), and
 * when vendor prices were last checked (PRICES_VERIFIED). Re-verify vendor
 * prices against the linked pricing pages before each funding cycle and bump
 * PRICES_VERIFIED when you do — and only when you actually did.
 */

import { ACTIVE_SCRAPERS } from '../../scripts/manifest.js'

/**
 * Human-readable date the vendor prices were last checked.
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
export const PRICES_VERIFIED = 'July 8, 2026'

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
 * whole point — the previous draft used a bare `0` for both meanings, and the
 * two are not the same idea even when they hold the same value.
 */
export const DEFAULT_TIER_INDEX = 1

/**
 * Traffic tiers for the cost-table explorer, in display order. TODAY_INDEX is
 * the real bill; "At scale" is a modeled scenario (production architecture
 * assumed: MapLibre + OpenFreeMap map rendering, Vercel edge delivery).
 *
 * Two tiers on purpose (2026-08-17, Byron). Earlier drafts modeled 10x and
 * 100x intermediate steps; they read as precision the model doesn't have.
 * The honest story is the real bill and the worst-case stress test — full
 * region adoption, the MOST expensive scenario — with nothing in between.
 *
 * The "today" traffic label reads "under 10k views/mo" rather than a point
 * estimate on purpose. Measured GA4 pageviews are roughly 2,300/month, and
 * GA4 was over-counting until the 2026-08-12 page_view guard landed, so any
 * specific number here would overstate reality by several times on the one
 * page that cannot afford to overstate anything. An upper bound is honest.
 */
export const TIERS = [
  { key: 'today',  label: 'Today',    traffic: 'under 10k views/mo' },
  { key: 'region', label: 'At scale', traffic: '~10M views/mo, full region adoption' },
] as const

/** Number of modeled tiers — every CostLine.monthly must have this length. */
export type TierAmounts = [number, number]

export interface CostLine {
  /** Stable key (used as the React list key). */
  key: string
  /** Display name. Vendor lines link out via `url`; internal lines don't. */
  label: string
  /** Vendor pricing page, when the line is a vendor. */
  url?: string
  /** One-line plain-language description of what the money buys. */
  description: string
  /** Monthly cost in whole dollars at each tier, aligned with TIERS. */
  monthly: TierAmounts
}

/**
 * How many scrapers actually run every night, DERIVED from
 * scripts/manifest.js rather than typed in as prose.
 *
 * The previous copy said "90+", which was stale by more than fifty sources
 * the day it shipped. A count in a sentence is a registry pair held together
 * by nobody, so this one reads the registry.
 */
export const ACTIVE_SOURCE_COUNT = ACTIVE_SCRAPERS.length

/**
 * The full monthly bill, largest first ($0 lines after the paid ones).
 * $0 lines are listed on purpose: "this is free" is half the transparency
 * story, and keeping the line visible means a future change is an amount
 * edit, not a page redesign. Per-tier amounts come from the usage model
 * described in ASSUMPTIONS; totals per tier are derived, never hand-written.
 *
 * Today's column is verified against actual plan state: the Supabase org is
 * on the Pro plan and Vercel moved to Pro on 2026-08-08.
 */
export const COST_LINES: CostLine[] = [
  {
    key: 'claude',
    label: 'Claude Max',
    url: 'https://claude.com/pricing',
    description:
      'AI tooling: scraper upkeep, nightly data-quality review. This line is what stands in for the data administration and development lines below, which read $0 because nobody has been paid for that time',
    monthly: [100, 100],
  },
  {
    key: 'supabase',
    label: 'Supabase',
    url: 'https://supabase.com/pricing',
    description: 'The database: every event, venue, and subscriber',
    monthly: [25, 271],
  },
  {
    key: 'vercel',
    label: 'Vercel',
    url: 'https://vercel.com/pricing',
    // No third-party CDN sits in front of this. A 2026-08-14 header check on
    // akronpulse.com returned `server: Vercel` with no Cloudflare markers, so
    // the earlier "behind a free CDN" phrasing described an architecture we
    // do not run. Vercel's own edge cache is included in this line's price.
    description: 'Hosting, edge delivery, and image optimization',
    monthly: [20, 968],
  },
  {
    key: 'proxy',
    label: 'DataImpulse',
    url: 'https://docs.dataimpulse.com/proxies',
    // Named vendor + docs link on purpose (Byron, 2026-08-17) — same
    // treatment as every other vendor line; the residential rate is $1/GB.
    // Measured usage (provider's own log, checked 2026-08-17) is far LOWER
    // than this line: effective rate ~$1/GB, one nightly run ~166 proxied
    // requests at mostly tens-to-hundreds of KB — under a dollar a month.
    // Held at $5 anyway (Byron, 2026-08-17): usage-billed bandwidth is the
    // easiest line to spike (one new bot-challenged source, one asset-heavy
    // page), so the table carries deliberate headroom rather than the
    // measured floor. This errs against us, which is the right direction.
    // Known fat worth trimming someday: the headless-browser sources pull
    // third-party assets (analytics, ad pixels, CDN fonts) through the
    // metered proxy; request-blocking those would cut billed bandwidth.
    description:
      'Residential proxy bandwidth ($1/GB) for the handful of sources that block datacenter traffic. Measured usage is under $1; held at $5 for headroom',
    monthly: [5, 20],
  },
  {
    key: 'domain',
    label: 'Domain',
    url: 'https://www.hover.com/',
    // Registrar corrected 2026-08-17: the domain is at Hover, not Cloudflare
    // — the old link named a registrar we don't use, and its "wholesale
    // renewal" framing priced a plan we aren't on. Verified from the Hover
    // dashboard: $18.99/yr renewal, auto-renew on = $1.58/mo, rounded UP to
    // the whole-dollar floor like every line here.
    description: 'akronpulse.com, registered at Hover ($18.99/yr)',
    monthly: [2, 2],
  },
  {
    key: 'data-admin',
    label: 'Data administration',
    // Split from "development and upkeep" (Byron, 2026-08-17): tending the
    // DATA is a different job than building the software, and a funder
    // reading the at-scale scenario should see both named. At-scale labor
    // budgets (Byron, same day): $500 data administration, $2,500
    // development — building the software for a whole region is the bigger
    // job. Today stays $0 on both because that is the truth.
    description:
      "Curating the dataset: review queue, dedupe, venue and category fixes, partner listings. Nobody's been paid yet; the at-scale column budgets part-time paid work",
    monthly: [0, 500],
  },
  {
    key: 'dev',
    label: 'Development and upkeep',
    // At-scale derivation, so this number is hours × rate rather than a
    // guess: $2,500/mo ≈ 22-29 contractor hours at Midwest freelance rates
    // ($85-115/hr) — a fractional engineer at 5-7 hrs/week. That is the
    // credible floor for a region-scale service partners embed (implied
    // uptime + support), and it is only viable that lean because the Claude
    // Max line above carries the AI-assisted leverage. A half-FTE would
    // overshoot a product this automated; 2-3 hrs/week undershoots the
    // reliability claim.
    description:
      "Building and maintaining the software: new features, bug fixes, infrastructure. Nobody's been paid yet; the at-scale column budgets a fractional engineer (~25 hours a month at regional contract rates)",
    monthly: [0, 2500],
  },
  {
    key: 'marketing',
    label: 'Marketing and advertising',
    // Today $0 is the truth: growth comes from partners, SEO, and word of
    // mouth, and a boosted post or a print run belongs in ONE_OFF_EXPENSES.
    // At scale, $500/mo is ~10% of the operating budget — the middle of the
    // 5-15% small-nonprofit norm — covering local social ads, event-season
    // print, and community sponsorships across the region.
    description:
      'Getting the word out: print, social, and event promotion. Nothing spent yet; the at-scale column budgets ~10% of operating costs',
    monthly: [0, 500],
  },
  {
    key: 'maps',
    label: 'Maps',
    url: 'https://openfreemap.org',
    // OpenFreeMap is donation funded and publishes no SLA. Promising "free
    // and unlimited at any traffic" put a guarantee in our mouths that its
    // operator has never made, on a modeled 10M views/mo row.
    description: 'MapLibre + OpenFreeMap, free to use, community funded',
    monthly: [0, 0],
  },
  {
    key: 'email',
    label: 'Email digests',
    url: 'https://resend.com/pricing',
    description: 'Subscriber digests via Resend; grows with the subscriber list',
    monthly: [0, 385],
  },
  {
    key: 'scrapers',
    label: 'Data collection',
    url: 'https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions',
    // Not "volunteer hardware": .github/workflows/nightly-scrape.yml runs
    // `runs-on: ubuntu-latest`, i.e. GitHub-hosted runners. They cost nothing
    // because the repository is public, which is a real vendor dependency and
    // belongs on a page that claims to publish the complete bill — see
    // ASSUMPTIONS.
    description: `${ACTIVE_SOURCE_COUNT} scrapers run nightly on GitHub Actions, free while the repository is public`,
    monthly: [0, 0],
  },
]

/** Derived total per tier, aligned with TIERS. */
export const TIER_TOTALS: TierAmounts = COST_LINES.reduce<TierAmounts>(
  (totals, line) => totals.map((t, i) => t + line.monthly[i]) as TierAmounts,
  [0, 0],
)

/** Today's whole bill: services + administration + marketing. */
export const MONTHLY_TOTAL = TIER_TOTALS[TODAY_INDEX]

/** Labor + promotion lines — everything that is NOT a vendor service. One
 *  list, so a future overhead line is added HERE and every derived split
 *  below follows (the previous filter hardcoded the old 'admin' key and
 *  would have silently misfiled its replacements as services). */
const OVERHEAD_KEYS = ['data-admin', 'dev', 'marketing'] as const

/** Today's vendor services only (everything except overhead). */
export const SERVICES_TOTAL = COST_LINES
  .filter(l => !(OVERHEAD_KEYS as readonly string[]).includes(l.key))
  .reduce((sum, l) => sum + l.monthly[TODAY_INDEX], 0)

/** Today's non-service overhead (labor + marketing) for the stat breakdown. */
export const OVERHEAD_TOTAL = MONTHLY_TOTAL - SERVICES_TOTAL

/**
 * What the reader has to take on trust, stated plainly and rendered in the
 * page footnote. Anything on the page that is a model rather than a bill or a
 * measurement belongs in this list. Add to it rather than quietly rounding a
 * modeled number into the prose.
 */
export const ASSUMPTIONS: string[] = [
  'Vercel overage rates are modeled, not quoted.',
  'Every tier above today is a usage model, not a bill we have received.',
  'Plan prices come from public vendor pricing pages, not from an invoice.',
  'Email costs assume the subscriber list grows roughly in step with traffic.',
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
  // hostname on purpose — that is where event photos live), so the pool of
  // billable source images tracks the event corpus, not our own assets.
  // vercel.json caps the blast radius (three sizes, 31-day cache TTL), but
  // the exposure is structural.
  'Vercel image optimization is usage-metered per source image, and event images come from hundreds of external hosts; it has produced an overage before and is the likeliest line to spike.',
  // Resend's free tier is 3,000 emails/month AND 100/day. The weekly digest
  // sends the whole list in one morning, so the DAILY cap is the binding
  // one: at ~100 subscribers the email line flips from $0 to the paid plan.
  // The list is in the nineties as this is written — this is the next real
  // bill, not a distant one.
  'The email line reads $0 on a free tier that allows 100 sends per day; the weekly digest crosses that at about 100 subscribers, which is imminent.',
  // scripts/lib/http.js routes bot-challenged scrapers through a residential
  // proxy (SCRAPER_PROXY_URL, opt-in per source). Usage-billed bandwidth has
  // no plan price to quote; measured usage is under $1/month but the line
  // deliberately carries headroom because metered lines spike easiest.
  'The scraper proxy line is budgeted above its measured usage (about $1 per gigabyte, well under a gigabyte a month) as deliberate headroom; the at-scale figure is modeled.',
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
  // 3 × $48.04 and $21.35, plus $86.77 (May 28) and $148.04 (Aug 9) —
  // everything except the two $106.75 plan renewals ($100 + 6.75% Ohio
  // sales tax). As-billed the sum is $400.28, tax included — carried here as
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
 * DERIVED from COST_LINES, never hand-copied. This was a literal 46 until
 * 2026-08-14, which meant changing Supabase from 25 to 35 left the fork
 * figure reading 46 and rendering wrong on the page with every gate green.
 *
 * This is the paid-plan figure, NOT a floor. A fork genuinely starts at $0:
 * both Supabase and Vercel have free tiers that comfortably hold a calendar
 * this size, and the page says so. Quoting the paid figure as the starting
 * price told exactly the wrong story to the small community most likely to
 * fork this.
 */
export const FORK_INFRA_MONTHLY = COST_LINES
  .filter(l => (FORK_INFRA_KEYS as readonly string[]).includes(l.key))
  .reduce((sum, l) => sum + l.monthly[TODAY_INDEX], 0)

/**
 * Sustained-traffic threshold for embed reporting: steady usage, not a
 * one-time referral.
 *
 * NOMINATION SIGNAL ONLY — nothing on the public page renders from it.
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
 * The public embed-partner list — every entry is here by AGREEMENT, never
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
