/**
 * test-financials-model.js - structural guards on the /financials cost model.
 *
 * src/lib/financials.ts is the committed methodology for a page whose entire
 * value is being right about money. Nothing else in the repo checks it, and
 * every failure mode here is silent in the browser:
 *
 *   1. A cost line missing a field its driver needs (a flat line without
 *      flatAtScale, a metered line without a component) throws at runtime
 *      instead of failing loudly here.
 *   2. A stale PRICES_VERIFIED turns a factual claim ("verified against
 *      vendor pricing pages") into a false one, gradually, with no signal.
 *   3. EMBED_PARTNER_POLICY (what the page TELLS the reader qualifies a site
 *      as an embed partner) and MIN_VIEWS/MIN_WEEKS/WINDOW_DAYS in
 *      api/pageviews.js (what actually qualifies one) used to be kept in step
 *      by a comment in each file saying "keep these in sync". This test is
 *      that comment, made enforceable.
 *   4. Rewritten 2026-08-17 for the driver-based cost model that replaced a
 *      two-point `monthly: [today, atScale]` array per line
 *      (cost-model-spec.md). The old array-shape guards are gone; in their
 *      place this file reimplements lineCostMonthly/driverValueForShare from
 *      financials.ts's exported constants and the parsed COST_LINES schedule,
 *      so it can assert the things a hand-typed two-point array used to make
 *      trivial: totals never decrease as adoption rises, and the live
 *      slider's s=1.0 and "today" evaluations land on the same numbers the
 *      table's fixed Today/At-scale columns show.
 *
 * financials.ts is TypeScript, which node can't import, so its values are
 * extracted textually - same approach as test-manifest-sync.js. The
 * api/pageviews.js side IS import-safe (no top-level side effects) and is
 * imported directly, so the check compares a real value against the text.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MIN_VIEWS, MIN_WEEKS, WINDOW_DAYS } from '../../api/pageviews.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FINANCIALS_REL = 'src/lib/financials.ts'
const src = fs.readFileSync(path.join(ROOT, FINANCIALS_REL), 'utf8')

/** Vendor pricing pages to re-check when PRICES_VERIFIED goes stale. */
const PRICING_URLS = [
  'https://claude.com/pricing',
  'https://supabase.com/pricing',
  'https://vercel.com/pricing',
  'https://vercel.com/docs/image-optimization/limits-and-pricing',
  'https://resend.com/pricing',
  'https://www.hover.com/',
]

const MAX_PRICE_AGE_DAYS = 180

// ── Textual extraction ──────────────────────────────────────────────────────

function section(startMarker, endMarker) {
  const i = src.indexOf(startMarker)
  assert.notEqual(i, -1, `marker not found in ${FINANCIALS_REL}: ${startMarker}`)
  const j = src.indexOf(endMarker, i)
  assert.notEqual(j, -1, `end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(i, j)
}

const tiersBlock = section('export const TIERS = [', '] as const')
const costBlock = section('export const COST_LINES: CostLine[] = [', '\n]\n')
const policyBlock = section('export const EMBED_PARTNER_POLICY', '} as const')

const tierKeys = [...tiersBlock.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1])

/** Every top-level `export const NAME = <number-literal>` in the file. */
const num = (name) => {
  const m = src.match(new RegExp(`export const ${name} = (-?\\d+(?:\\.\\d+)?)`))
  assert.ok(m, `${FINANCIALS_REL} must export a numeric ${name}`)
  return Number(m[1])
}

// ── Literal (measured/assumed) inputs ───────────────────────────────────────

const ANNUAL_UNIQUE_USERS = num('ANNUAL_UNIQUE_USERS')
const TODAY_MONTHLY_ACTIVE_USERS = num('TODAY_MONTHLY_ACTIVE_USERS')
const SUMMIT_COUNTY_POPULATION = num('SUMMIT_COUNTY_POPULATION')
const SUMMIT_COUNTY_ADULT_SHARE = num('SUMMIT_COUNTY_ADULT_SHARE')
const GA4_TOTAL_PAGEVIEWS_TRAILING_365D = num('GA4_TOTAL_PAGEVIEWS_TRAILING_365D')
const EMBED_CEILING_VIEWS_PER_MONTH = num('EMBED_CEILING_VIEWS_PER_MONTH')
const TODAY_VIEWS_PER_MONTH = num('TODAY_VIEWS_PER_MONTH')
const USAGE_BASELINE_VIEWS = num('USAGE_BASELINE_VIEWS')
const VERCEL_TRANSFER_GB_BASELINE = num('VERCEL_TRANSFER_GB_BASELINE')
const SUPABASE_EGRESS_GB_BASELINE = num('SUPABASE_EGRESS_GB_BASELINE')
const TODAY_SUBSCRIBERS = num('TODAY_SUBSCRIBERS')
const VERCEL_EDGE_REQUESTS_PER_VIEW = num('VERCEL_EDGE_REQUESTS_PER_VIEW')
const VERCEL_FUNCTION_INVOCATIONS_PER_VIEW = num('VERCEL_FUNCTION_INVOCATIONS_PER_VIEW')
const IMAGE_CORPUS_ESTIMATE = num('IMAGE_CORPUS_ESTIMATE')
const VERCEL_IMAGE_SIZES = num('VERCEL_IMAGE_SIZES')
const VERCEL_IMAGE_FORMATS = num('VERCEL_IMAGE_FORMATS')
const VERCEL_IMAGE_RATE_PER_1K = num('VERCEL_IMAGE_RATE_PER_1K')
const RESEND_FREE_DAILY_CAP = num('RESEND_FREE_DAILY_CAP')
const RESEND_FREE_INCLUDED_EMAILS = num('RESEND_FREE_INCLUDED_EMAILS')
const RESEND_PRO_PRICE = num('RESEND_PRO_PRICE')
const RESEND_PRO_INCLUDED_EMAILS = num('RESEND_PRO_INCLUDED_EMAILS')
const RESEND_OVERAGE_PER_1000_EMAILS = num('RESEND_OVERAGE_PER_1000_EMAILS')
const DIGEST_SENDS_PER_MONTH = num('DIGEST_SENDS_PER_MONTH')
const TRANSACTIONAL_EMAILS_PER_MONTH = num('TRANSACTIONAL_EMAILS_PER_MONTH')

// ── Derived expressions ─────────────────────────────────────────────────────
// Each of these is an expression in the source, not a literal (like
// SUMMIT_COUNTY_ADULTS elsewhere in this suite) - assert the exact source
// text so a future edit can't silently swap the formula, then recompute it
// here the same way financials.ts does.

function assertDerived(name, expectedExpr) {
  // Allow the expression to sit on the same line as `=` OR wrap to the next
  // line (financials.ts wraps the longer ones for readability) - \s+
  // between `=` and the expression covers both layouts.
  const re = new RegExp(`export const ${name} =\\s+${expectedExpr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  assert.match(
    src,
    re,
    `${name} must stay derived as \`${expectedExpr}\`, not a hand-typed literal - a future price or ` +
      'baseline edit would silently stop moving this value.',
  )
}

assertDerived('SUMMIT_COUNTY_ADULTS', 'Math.round(SUMMIT_COUNTY_POPULATION * SUMMIT_COUNTY_ADULT_SHARE)')
const SUMMIT_COUNTY_ADULTS = Math.round(SUMMIT_COUNTY_POPULATION * SUMMIT_COUNTY_ADULT_SHARE)

assertDerived('CEILING_VIEWS_PER_USER_MONTH', 'EMBED_CEILING_VIEWS_PER_MONTH / SUMMIT_COUNTY_ADULTS')
const CEILING_VIEWS_PER_USER_MONTH = EMBED_CEILING_VIEWS_PER_MONTH / SUMMIT_COUNTY_ADULTS

assertDerived('VIEWS_PER_USER_YEAR', 'GA4_TOTAL_PAGEVIEWS_TRAILING_365D / ANNUAL_UNIQUE_USERS')
const VIEWS_PER_USER_YEAR = GA4_TOTAL_PAGEVIEWS_TRAILING_365D / ANNUAL_UNIQUE_USERS

assertDerived('VERCEL_GB_PER_VIEW', 'VERCEL_TRANSFER_GB_BASELINE / USAGE_BASELINE_VIEWS')
const VERCEL_GB_PER_VIEW = VERCEL_TRANSFER_GB_BASELINE / USAGE_BASELINE_VIEWS

assertDerived('SUPABASE_GB_PER_VIEW', 'SUPABASE_EGRESS_GB_BASELINE / USAGE_BASELINE_VIEWS')
const SUPABASE_GB_PER_VIEW = SUPABASE_EGRESS_GB_BASELINE / USAGE_BASELINE_VIEWS

assertDerived('SUBSCRIBER_CONVERSION', 'TODAY_SUBSCRIBERS / ANNUAL_UNIQUE_USERS')
const SUBSCRIBER_CONVERSION = TODAY_SUBSCRIBERS / ANNUAL_UNIQUE_USERS

assertDerived(
  'VERCEL_IMAGE_TRANSFORMATIONS_PER_MONTH',
  'IMAGE_CORPUS_ESTIMATE * VERCEL_IMAGE_SIZES * VERCEL_IMAGE_FORMATS',
)
const VERCEL_IMAGE_TRANSFORMATIONS_PER_MONTH = IMAGE_CORPUS_ESTIMATE * VERCEL_IMAGE_SIZES * VERCEL_IMAGE_FORMATS

assert.match(
  src,
  /export const VERCEL_IMAGE_TRANSFORM_MONTHLY =\s*\n\s*Math\.ceil\(\(VERCEL_IMAGE_TRANSFORMATIONS_PER_MONTH \/ 1000\) \* VERCEL_IMAGE_RATE_PER_1K\)/,
  'VERCEL_IMAGE_TRANSFORM_MONTHLY must stay Math.ceil((VERCEL_IMAGE_TRANSFORMATIONS_PER_MONTH / 1000) * VERCEL_IMAGE_RATE_PER_1K)',
)
const VERCEL_IMAGE_TRANSFORM_MONTHLY = Math.ceil((VERCEL_IMAGE_TRANSFORMATIONS_PER_MONTH / 1000) * VERCEL_IMAGE_RATE_PER_1K)

/** Every named constant a COST_LINES component field may reference by identifier. */
const KNOWN = {
  SUPABASE_GB_PER_VIEW,
  VERCEL_GB_PER_VIEW,
  VERCEL_EDGE_REQUESTS_PER_VIEW,
  VERCEL_FUNCTION_INVOCATIONS_PER_VIEW,
  VERCEL_IMAGE_TRANSFORM_MONTHLY,
  RESEND_PRO_PRICE,
  RESEND_PRO_INCLUDED_EMAILS,
  RESEND_OVERAGE_PER_1000_EMAILS,
  DIGEST_SENDS_PER_MONTH,
  TRANSACTIONAL_EMAILS_PER_MONTH,
}

function resolve(token) {
  if (token == null) return undefined
  const t = token.trim()
  if (/^-?[\d.]+$/.test(t)) return Number(t)
  assert.ok(t in KNOWN, `unresolvable identifier '${t}' in a COST_LINES entry - add it to KNOWN`)
  return KNOWN[t]
}

// ── COST_LINES parsing ──────────────────────────────────────────────────────

const declaredCostKeys = [...costBlock.matchAll(/\n {4}key:\s*'([^']+)'/g)].map((m) => m[1])

const rawEntries = costBlock.split(/\n {2}\{\n/).slice(1)

const costLines = rawEntries.map((entry) => {
  const key = entry.match(/key:\s*'([^']+)'/)?.[1]
  assert.ok(key, `a COST_LINES entry has no key: ${entry.slice(0, 80)}...`)
  const driver = entry.match(/driver:\s*'([^']+)'/)?.[1]
  assert.ok(driver, `cost line '${key}' has no driver:`)

  if (driver === 'flat') {
    const flatToday = resolve(entry.match(/flatToday:\s*([\w.]+)/)?.[1])
    const flatAtScale = resolve(entry.match(/flatAtScale:\s*([\w.]+)/)?.[1])
    assert.ok(Number.isFinite(flatToday), `flat cost line '${key}' has no numeric flatToday`)
    assert.ok(Number.isFinite(flatAtScale), `flat cost line '${key}' has no numeric flatAtScale`)
    return { key, driver, flatToday, flatAtScale }
  }

  assert.ok(
    driver === 'traffic' || driver === 'subscribers',
    `cost line '${key}' has an unrecognised driver '${driver}'`,
  )
  const planPrice = resolve(entry.match(/planPrice:\s*([\w.]+)/)?.[1])
  assert.ok(Number.isFinite(planPrice), `metered cost line '${key}' has no numeric planPrice`)

  const componentsBlock = entry.match(/components:\s*\[([\s\S]*?)\n {4}\],?\n/)?.[1] ?? ''
  const componentEntries = [...componentsBlock.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1])
  assert.ok(componentEntries.length > 0, `metered cost line '${key}' has no components`)

  const components = componentEntries.map((c) => {
    const perDriverUnit = resolve(c.match(/perDriverUnit:\s*([\w.]+)/)?.[1])
    const extraUsageRaw = c.match(/extraUsage:\s*([\w.]+)/)?.[1]
    const included = resolve(c.match(/included:\s*([\w.]+)/)?.[1])
    const overageRate = resolve(c.match(/overageRate:\s*([\w.]+)/)?.[1])
    const rateUnit = resolve(c.match(/rateUnit:\s*([\w.]+)/)?.[1])
    for (const [fieldName, value] of Object.entries({ perDriverUnit, included, overageRate, rateUnit })) {
      assert.ok(Number.isFinite(value), `cost line '${key}' has a component with a non-numeric ${fieldName}`)
    }
    return {
      perDriverUnit,
      extraUsage: extraUsageRaw != null ? resolve(extraUsageRaw) : undefined,
      included,
      overageRate,
      rateUnit,
    }
  })

  const flatAddOnRaw = entry.match(/flatAddOn:\s*([\w.]+)/)?.[1]
  const flatAddOn = flatAddOnRaw != null ? resolve(flatAddOnRaw) : undefined

  // Stepped add-ons (Supabase compute, 2026-08-17): parsed the same way the
  // components are, so a threshold or price edit in financials.ts flows into
  // this file's reimplementation without anyone re-typing it here.
  const stepsBlock = entry.match(/steps:\s*\[([\s\S]*?)\n {4}\],?\n/)?.[1]
  const steps = stepsBlock
    ? [...stepsBlock.matchAll(/\{([^{}]*)\}/g)].map((m) => {
        const s = m[1]
        const label = s.match(/label:\s*'([^']+)'/)?.[1]
        const upToRaw = s.match(/upToDriverValue:\s*([\w.]+|null)/)?.[1]
        const monthlyExtra = resolve(s.match(/monthlyExtra:\s*([\w.]+)/)?.[1])
        assert.ok(label, `cost line '${key}' has a step with no label`)
        assert.ok(upToRaw != null, `cost line '${key}' step '${label}' has no upToDriverValue`)
        assert.ok(Number.isFinite(monthlyExtra), `cost line '${key}' step '${label}' has a non-numeric monthlyExtra`)
        return { label, upToDriverValue: upToRaw === 'null' ? null : resolve(upToRaw), monthlyExtra }
      })
    : undefined

  return { key, driver, planPrice, components, flatAddOn, steps }
})

// ── Reimplementation of financials.ts's evaluator ───────────────────────────
// Mirrors lineCostMonthly / driverValueForShare / driverValueToday exactly,
// operating on the parsed schedule above instead of imported TS.

function adoptersAtShare(share) {
  return SUMMIT_COUNTY_ADULTS * share
}
function trafficViewsPerMonth(share) {
  // Mirrors financials.ts's trafficViewsPerMonth exactly, including the
  // floating-point-safe ordering (scale the reconstructed views ceiling by
  // share, rather than multiplying adoptersAtShare(share) by
  // CEILING_VIEWS_PER_USER_MONTH directly) - see that function's comment for
  // why the naive ordering flips a Math.ceil boundary on some shares.
  const viewsCeiling = adoptersAtShare(1) * CEILING_VIEWS_PER_USER_MONTH
  return share * viewsCeiling
}
function subscribersAtShare(share) {
  return adoptersAtShare(share) * SUBSCRIBER_CONVERSION
}
function driverValueForShare(line, share) {
  if (line.driver === 'traffic') return trafficViewsPerMonth(share)
  if (line.driver === 'subscribers') return subscribersAtShare(share)
  return share
}
function driverValueToday(line) {
  if (line.driver === 'traffic') return TODAY_VIEWS_PER_MONTH
  if (line.driver === 'subscribers') return TODAY_SUBSCRIBERS
  return 0
}
function lineCostMonthly(line, driverValue) {
  if (line.driver === 'flat') {
    // Mirrors financials.ts's lineCostMonthly exactly: driverValue is the
    // adoption share (0..1) for flat lines, linearly interpolated between
    // flatToday and flatAtScale, clamped to [0, 1] - NOT a step function
    // that only moves at s=1. An earlier version of this reimplementation
    // used a step (driverValue >= 1 ? flatAtScale : flatToday), left over
    // from the two-point model this file's own header says it replaced;
    // that stale step function is why an earlier draft of the invariant
    // tests below failed at fractional shares even though the real page was
    // correct - fixed here, not in financials.ts.
    const share = Math.min(1, Math.max(0, driverValue))
    return Math.ceil(line.flatToday + (line.flatAtScale - line.flatToday) * share)
  }
  let total = line.planPrice
  for (const c of line.components) {
    const usage = driverValue * c.perDriverUnit + (c.extraUsage ?? 0)
    const overageUnits = Math.max(0, usage - c.included) / c.rateUnit
    total += overageUnits * c.overageRate
  }
  if (line.steps) total += line.steps[activeStepIndex(line.steps, driverValue)].monthlyExtra
  return Math.ceil(total + (line.flatAddOn ?? 0))
}
// Mirrors financials.ts's activeStepIndex exactly.
function activeStepIndex(steps, driverValue) {
  const i = steps.findIndex((s) => s.upToDriverValue !== null && driverValue <= s.upToDriverValue)
  return i === -1 ? steps.length - 1 : i
}
function lineMonthlyToday(line) {
  return lineCostMonthly(line, driverValueToday(line))
}
function lineMonthlyAtShare(line, share) {
  return lineCostMonthly(line, driverValueForShare(line, share))
}

const todayTotal = () => costLines.reduce((sum, l) => sum + lineMonthlyToday(l), 0)
const totalAtShare = (share) => costLines.reduce((sum, l) => sum + lineMonthlyAtShare(l, share), 0)

/** FORK_INFRA_KEYS as written in the module (see the FORK_INFRA_MONTHLY sum). */
const forkInfraKeys = [
  ...(src.match(/export const FORK_INFRA_KEYS = \[([^\]]*)\]/)?.[1] ?? '')
    .matchAll(/'([^']+)'/g),
].map((m) => m[1])

const PRICES_VERIFIED = src.match(/export const PRICES_VERIFIED = '([^']+)'/)?.[1]

const policy = {
  minViews: Number(policyBlock.match(/minViews:\s*(\d+)/)?.[1]),
  minWeeks: Number(policyBlock.match(/minWeeks:\s*(\d+)/)?.[1]),
  windowDays: Number(policyBlock.match(/windowDays:\s*(\d+)/)?.[1]),
}

// ── Assertions ───────────────────────────────────────────────────────────────

describe('financials cost model shape', () => {
  it('parsed a plausible model', () => {
    assert.ok(tierKeys.length >= 2, `parsed only ${tierKeys.length} TIERS entries`)
    assert.ok(costLines.length >= 5, `parsed only ${costLines.length} COST_LINES entries`)
  })

  it('parsing did not silently swallow a cost line', () => {
    assert.deepEqual(
      costLines.map((l) => l.key),
      declaredCostKeys,
      `parsed ${costLines.length} cost lines but found ${declaredCostKeys.length} key: ` +
        `declarations in ${FINANCIALS_REL}. The textual extractor only recognises an entry that ` +
        'opens as exactly "\\n  {\\n"; anything else is folded into its neighbour and skips every ' +
        'rule in this file. Reformat the entry to match the rest of the array (two-space indent, ' +
        'brace on its own line) - do not relax this check.',
    )
  })

  it('FORK_INFRA_KEYS all name real cost lines', () => {
    assert.ok(forkInfraKeys.length > 0, `${FINANCIALS_REL} must export FORK_INFRA_KEYS`)
    for (const key of forkInfraKeys) {
      assert.ok(
        declaredCostKeys.includes(key),
        `FORK_INFRA_KEYS names '${key}', which is not a COST_LINES key (have: ` +
          `${declaredCostKeys.join(', ')}). FORK_INFRA_MONTHLY sums the matching lines, so an ` +
          'unmatched key silently lowers the fork estimate instead of failing.',
      )
    }
  })

  it('every flat line has flatAtScale >= flatToday', () => {
    // The generalized "no line gets cheaper as adoption grows" guard for
    // flat lines: their driver ignores the slider except at the s=1.0
    // ceiling, so the only ordering that can ever be violated is this one.
    for (const l of costLines.filter((l) => l.driver === 'flat')) {
      assert.ok(
        l.flatAtScale >= l.flatToday,
        `flat cost line '${l.key}' has flatAtScale (${l.flatAtScale}) below flatToday ` +
          `(${l.flatToday}). ESCAPE HATCH: a line genuinely CAN get cheaper at scale (a volume ` +
          `discount, a plan change); if that is what happened, change this assertion deliberately ` +
          `and record the reason in ASSUMPTIONS in ${FINANCIALS_REL}.`,
      )
    }
  })

  it('every metered component has a non-negative overage rate and included quota', () => {
    for (const l of costLines.filter((l) => l.driver !== 'flat')) {
      for (const c of l.components) {
        assert.ok(c.included >= 0, `cost line '${l.key}' has a component with a negative included quota`)
        assert.ok(c.overageRate >= 0, `cost line '${l.key}' has a component with a negative overageRate`)
        assert.ok(c.rateUnit > 0, `cost line '${l.key}' has a component with a non-positive rateUnit`)
      }
    }
  })
})

describe('tier indices', () => {
  it("TIERS[0] is 'today'", () => {
    assert.equal(tierKeys[0], 'today', `TIERS[0] is '${tierKeys[0]}', not 'today'`)
  })
})

describe('totals recompute from the schedules, never decrease as adoption rises', () => {
  it('the total at s = 1.0 (the ceiling) is the largest total on the slider', () => {
    // Sampled, not exhaustive - every 'traffic'/'subscribers' component's
    // usage is driverValue * perDriverUnit + extraUsage, monotonic
    // non-decreasing in driverValue, and driverValue itself is monotonic
    // non-decreasing in share; flat lines step exactly once, upward, at
    // s = 1.0 (asserted above). A monotonic sum of monotonic functions is
    // monotonic, but this samples a fine grid as a concrete cross-check
    // rather than trusting that reasoning alone.
    const samples = []
    for (let pct = 1; pct <= 100; pct++) samples.push(totalAtShare(pct / 100))
    for (let i = 1; i < samples.length; i++) {
      assert.ok(
        samples[i] >= samples[i - 1],
        `cost total drops from $${samples[i - 1]} at ${i}% adoption to $${samples[i]} at ${i + 1}% - ` +
          'the live "At this adoption" column must never show a lower bill as the slider moves up.',
      )
    }
    assert.equal(samples[samples.length - 1], totalAtShare(1), 'the s=1.0 total must be the sampled ceiling')
  })

  it('the evaluation at s = 1.0 equals the At-scale total every line produces on its own', () => {
    // Re-derives the same number two ways: once via the grand total, once
    // by summing each line's own lineMonthlyAtShare(line, 1) - catches a
    // reducer bug that a single top-level assertion could miss.
    const bySum = costLines.reduce((sum, l) => sum + lineMonthlyAtShare(l, 1), 0)
    assert.equal(totalAtShare(1), bySum)
  })

  it('the evaluation at measured "today" driver values equals the Today total', () => {
    const bySum = costLines.reduce((sum, l) => sum + lineMonthlyToday(l), 0)
    assert.equal(todayTotal(), bySum)
  })

  it('Today never exceeds At scale', () => {
    assert.ok(
      todayTotal() <= totalAtShare(1),
      `Today's total ($${todayTotal()}) exceeds the At-scale total ($${totalAtShare(1)}) - the ` +
        'ceiling scenario must never be cheaper than the real bill.',
    )
  })
})

describe('users-first refactor (2026-08-17) changed the vocabulary, not the dollars', () => {
  // Pins the exact totals the pre-refactor model produced, so a future edit
  // to adoptersAtShare / trafficViewsPerMonth / CEILING_VIEWS_PER_USER_MONTH
  // that reorders the arithmetic (even one that is algebraically equivalent)
  // gets caught here rather than shipping a page that quietly renders a
  // different dollar figure than the committed model. NEXTDOOR_ADOPTION_SHARE
  // (0.15) and LIBRARY_ADOPTION_SHARE (0.48) are the calculator's two
  // non-ceiling presets - both were verified by hand against the pre-refactor
  // build before this test was written; see the commit's PR description for
  // the esbuild-bundled before/after grid diff (0 differences across every
  // integer adoption share from 1% to 100%).
  it('Today totals exactly $173/mo', () => {
    assert.equal(todayTotal(), 173, `Today's total is $${todayTotal()}, expected $173`)
  })

  // Pins re-baselined 2026-08-17 when the Supabase COMPUTE steps landed (a
  // deliberate model change, not drift): +$5 at 15% (Small), +$50 at 48%
  // (Medium), +$100 at 100% (Large), each net of Pro's $10 compute credit.
  // Pre-step values were 701 / 1917 / 3926.
  it('s = 0.15 (Nextdoor-level adoption) totals exactly $706/mo', () => {
    assert.equal(totalAtShare(0.15), 706, `total at s=0.15 is $${totalAtShare(0.15)}, expected $706`)
  })

  it('s = 0.48 (library-level adoption) totals exactly $1,967/mo', () => {
    assert.equal(totalAtShare(0.48), 1967, `total at s=0.48 is $${totalAtShare(0.48)}, expected $1,967`)
  })

  it('s = 1.0 (the ceiling) totals exactly $4,026/mo, matching TIER_TOTALS', () => {
    assert.equal(totalAtShare(1), 4026, `total at s=1.0 is $${totalAtShare(1)}, expected $4,026`)
  })

  it('CEILING_VIEWS_PER_USER_MONTH round-trips to EMBED_CEILING_VIEWS_PER_MONTH within rounding', () => {
    // "Within rounding", not exact equality: CEILING_VIEWS_PER_USER_MONTH is
    // EMBED_CEILING_VIEWS_PER_MONTH / SUMMIT_COUNTY_ADULTS, so multiplying it
    // back by SUMMIT_COUNTY_ADULTS is a division-then-multiplication
    // round-trip that floating-point arithmetic does not guarantee lands on
    // the exact original integer, only very close to it.
    const roundTripped = CEILING_VIEWS_PER_USER_MONTH * SUMMIT_COUNTY_ADULTS
    assert.ok(
      Math.abs(roundTripped - EMBED_CEILING_VIEWS_PER_MONTH) < 1,
      `CEILING_VIEWS_PER_USER_MONTH * SUMMIT_COUNTY_ADULTS is ${roundTripped}, expected within 1 of ` +
        `EMBED_CEILING_VIEWS_PER_MONTH (${EMBED_CEILING_VIEWS_PER_MONTH})`,
    )
  })

  it('trafficViewsPerMonth(1) equals EMBED_CEILING_VIEWS_PER_MONTH exactly', () => {
    // 100% adoption is the one point on the curve this derivation is
    // calibrated to hit exactly, by construction - see trafficViewsPerMonth's
    // comment in financials.ts.
    assert.equal(trafficViewsPerMonth(1), EMBED_CEILING_VIEWS_PER_MONTH)
  })
})

describe('PRICES_VERIFIED freshness', () => {
  it('parses as a date and is under 180 days old', () => {
    assert.ok(PRICES_VERIFIED, `${FINANCIALS_REL} must export PRICES_VERIFIED as a quoted string`)
    const verified = new Date(PRICES_VERIFIED)
    assert.ok(
      !Number.isNaN(verified.getTime()),
      `PRICES_VERIFIED '${PRICES_VERIFIED}' in ${FINANCIALS_REL} does not parse as a date`,
    )
    const ageDays = Math.floor((Date.now() - verified.getTime()) / 86400000)
    assert.ok(
      ageDays <= MAX_PRICE_AGE_DAYS,
      `PRICES_VERIFIED in ${FINANCIALS_REL} is ${ageDays} days old (limit ${MAX_PRICE_AGE_DAYS}).\n` +
        'The /financials page tells readers these prices were verified on that date. Re-check them ' +
        `against the vendor pricing pages, correct any schedule that moved, THEN bump the date:\n` +
        PRICING_URLS.map((u) => `  - ${u}`).join('\n') +
        '\nBe honest about what this check is: it enforces a CADENCE, not honesty. Bumping the ' +
        'date is exactly what makes it pass, so nothing here can tell a re-checked page from an ' +
        'unchecked one. It only guarantees somebody is asked the question twice a year.',
    )
  })
})

describe('driver inputs are plausible', () => {
  it('SUBSCRIBER_CONVERSION is a fraction between 0 and 1', () => {
    assert.ok(SUBSCRIBER_CONVERSION > 0 && SUBSCRIBER_CONVERSION < 1, `SUBSCRIBER_CONVERSION is ${SUBSCRIBER_CONVERSION}`)
  })

  it('TODAY_SUBSCRIBERS exceeds the Resend free-tier daily cap', () => {
    // The email schedule treats Pro as a permanent floor because Free's
    // 100/day cap is already exceeded today - if that ever stops being
    // true this guard catches it before the schedule's own comment goes stale.
    assert.ok(
      TODAY_SUBSCRIBERS > RESEND_FREE_DAILY_CAP,
      `TODAY_SUBSCRIBERS (${TODAY_SUBSCRIBERS}) no longer exceeds RESEND_FREE_DAILY_CAP ` +
        `(${RESEND_FREE_DAILY_CAP}) - the 'email' cost line's comment claims Free is never reachable; ` +
        're-check that claim before touching the schedule.',
    )
  })

  it('subscribersAtShare(0.01), the calculator slider\'s minimum, also exceeds the daily cap', () => {
    assert.ok(
      subscribersAtShare(0.01) > RESEND_FREE_DAILY_CAP,
      'the email schedule assumes no reachable slider position uses the Free tier; recompute if this fails',
    )
  })

  it('RESEND_FREE_INCLUDED_EMAILS is a documented context figure, not the binding constraint', () => {
    // Context only (see its comment in financials.ts) - the DAILY cap binds
    // before this monthly one ever does, since the digest sends the whole
    // list in one morning. Asserted here so the figure stays a real,
    // plausible Resend Free number even though the schedule never reads it.
    assert.ok(RESEND_FREE_INCLUDED_EMAILS > RESEND_FREE_DAILY_CAP * 28, `RESEND_FREE_INCLUDED_EMAILS (${RESEND_FREE_INCLUDED_EMAILS}) looks implausibly low next to the daily cap`)
  })

  it('TODAY_VIEWS_PER_MONTH is positive and below the at-scale ceiling', () => {
    assert.ok(TODAY_VIEWS_PER_MONTH > 0, 'TODAY_VIEWS_PER_MONTH must be positive')
    assert.ok(
      TODAY_VIEWS_PER_MONTH < EMBED_CEILING_VIEWS_PER_MONTH,
      'TODAY_VIEWS_PER_MONTH must stay below the modeled at-scale ceiling',
    )
  })

  it('TODAY_MONTHLY_ACTIVE_USERS is positive and below the adult population ceiling', () => {
    assert.ok(TODAY_MONTHLY_ACTIVE_USERS > 0, 'TODAY_MONTHLY_ACTIVE_USERS must be positive')
    assert.ok(
      TODAY_MONTHLY_ACTIVE_USERS < SUMMIT_COUNTY_ADULTS,
      'TODAY_MONTHLY_ACTIVE_USERS must stay below SUMMIT_COUNTY_ADULTS - the users-first "today" tier ' +
        'label cannot claim more active users than the county has adults',
    )
  })

  it('CEILING_VIEWS_PER_USER_MONTH is a plausible, embed-inclusive views-per-user rate, well above the measured site-only rate', () => {
    assert.ok(
      CEILING_VIEWS_PER_USER_MONTH > 0 && CEILING_VIEWS_PER_USER_MONTH < 1000,
      `CEILING_VIEWS_PER_USER_MONTH is ${CEILING_VIEWS_PER_USER_MONTH}`,
    )
    // Ceiling-calibrated, not measured - see its comment in financials.ts.
    // It is expected to sit well above VIEWS_PER_USER_YEAR / 12 (the
    // measured, embed-excluding monthly rate): the gap is embed syndication
    // and pass-through traffic the ceiling has to plan for.
    assert.ok(
      CEILING_VIEWS_PER_USER_MONTH > (VIEWS_PER_USER_YEAR / 12) * 10,
      'CEILING_VIEWS_PER_USER_MONTH should be at least an order of magnitude above the measured, ' +
        'embed-excluding monthly rate (VIEWS_PER_USER_YEAR / 12) - if it is not, the two constants ' +
        'may have been accidentally conflated',
    )
  })

  it('VIEWS_PER_USER_YEAR is a plausible pageviews-per-user figure', () => {
    assert.ok(VIEWS_PER_USER_YEAR > 0 && VIEWS_PER_USER_YEAR < 100, `VIEWS_PER_USER_YEAR is ${VIEWS_PER_USER_YEAR}`)
  })
})

describe('stepped cost schedules (Supabase compute, 2026-08-17)', () => {
  const stepped = costLines.filter((l) => l.steps)

  it('supabase carries a compute step schedule', () => {
    assert.ok(
      stepped.some((l) => l.key === 'supabase'),
      'the supabase line lost its compute steps - the model would again hold compute flat at every adoption level',
    )
  })

  for (const line of stepped) {
    it(`'${line.key}' steps ascend in threshold and never decrease in price`, () => {
      line.steps.forEach((s, i) => {
        if (i < line.steps.length - 1) {
          assert.ok(
            s.upToDriverValue !== null,
            `step '${s.label}' has a null threshold but is not last - only the final step may hold to the ceiling`,
          )
          const next = line.steps[i + 1]
          if (next.upToDriverValue !== null) {
            assert.ok(
              next.upToDriverValue > s.upToDriverValue,
              `step '${next.label}' threshold does not ascend past '${s.label}'`,
            )
          }
        } else {
          assert.equal(s.upToDriverValue, null, `the final step '${s.label}' must hold to the ceiling (null)`)
        }
        if (i > 0) {
          assert.ok(
            s.monthlyExtra >= line.steps[i - 1].monthlyExtra,
            `step '${s.label}' is cheaper than the smaller '${line.steps[i - 1].label}' - a bigger size cannot cost less`,
          )
        }
      })
    })

    it(`'${line.key}' today lands on the first step at no extra cost`, () => {
      // Today's real bill must not grow a modeled compute add-on: the first
      // step is the size the project actually runs, covered by the plan.
      const i = activeStepIndex(line.steps, driverValueToday(line))
      assert.equal(i, 0, `today's driver value lands on step '${line.steps[i].label}', expected '${line.steps[0].label}'`)
      assert.equal(line.steps[0].monthlyExtra, 0, 'the first step must cost nothing extra today')
    })
  }
})

describe('embed-partner policy stays in sync with api/pageviews.js', () => {
  it('EMBED_PARTNER_POLICY equals the server-side thresholds', () => {
    assert.deepEqual(
      policy,
      { minViews: MIN_VIEWS, minWeeks: MIN_WEEKS, windowDays: WINDOW_DAYS },
      `EMBED_PARTNER_POLICY in ${FINANCIALS_REL} (what /financials TELLS the reader qualifies a ` +
        'site as an embed partner) disagrees with MIN_VIEWS/MIN_WEEKS/WINDOW_DAYS in ' +
        'api/pageviews.js (what actually qualifies one). Change both, or the page states a rule ' +
        'the server does not apply.',
    )
  })
})
