/**
 * test-financials-impact-model.js - structural guards on the /financials
 * "What it's worth" adoption ladder (src/lib/financials.ts, "Local spending
 * facilitated: adoption ladder" section).
 *
 * Rewritten 2026-08-17 for the ladder that replaced a single "at scale"
 * modeled figure (maintainer decision, after reviewing
 * docs/economic-impact-research.md, a sourced research memo). Same rationale
 * as test-financials-model.js: financials.ts is the committed methodology
 * for a page whose entire value is being right about money, and every
 * failure mode here is silent in the browser. Specific to the ladder:
 *
 *   1. REACH_MEASURED_THROUGH going stale turns "measured" into a claim
 *      nobody re-checked. Reach moves far faster than vendor prices (a press
 *      referral alone 6x'd it in three weeks), so this uses a much shorter
 *      window than PRICES_VERIFIED's 180 days.
 *   2. A future edit could give a ladder rung a shareOfAdults above 1.0,
 *      which would publish an audience larger than the county's adult
 *      population - the exact failure mode the design doc this model
 *      replaces (docs/economic-impact-model.md) documents rejecting for the
 *      cost table's traffic tier, and the exact thing the maintainer's
 *      ceiling-row instruction exists to prevent.
 *   3. IMPACT_LADDER must stay computed from IMPACT_SCENARIOS via .map(...),
 *      never hand-typed as a literal array - the same "derivation, not a
 *      literal" guard that protects FORK_INFRA_MONTHLY and TIER_TOTALS
 *      elsewhere in this file.
 *   4. The rendered dollar figures must match hand-recomputed arithmetic, so
 *      a reader multiplying the numbers on the page gets the same answer the
 *      code does.
 *
 * financials.ts is TypeScript, which node can't import, so values are
 * extracted textually and the model is recomputed here - same approach as
 * test-financials-model.js.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FINANCIALS_REL = 'src/lib/financials.ts'
const src = fs.readFileSync(path.join(ROOT, FINANCIALS_REL), 'utf8')

const MAX_REACH_AGE_DAYS = 45

// ── Textual extraction ──────────────────────────────────────────────────────

const num = (name) => {
  const m = src.match(new RegExp(`export const ${name} = (-?\\d+(?:\\.\\d+)?)`))
  assert.ok(m, `${FINANCIALS_REL} must export a numeric ${name}`)
  return Number(m[1])
}

const ANNUAL_UNIQUE_USERS = num('ANNUAL_UNIQUE_USERS')
const TODAY_MONTHLY_ACTIVE_USERS = num('TODAY_MONTHLY_ACTIVE_USERS')
const SUMMIT_COUNTY_POPULATION = num('SUMMIT_COUNTY_POPULATION')
const SUMMIT_COUNTY_ADULT_SHARE = num('SUMMIT_COUNTY_ADULT_SHARE')
const OUTING_CONVERSION = num('OUTING_CONVERSION')
const SPEND_PER_OUTING = num('SPEND_PER_OUTING')
const AEP6_LOCAL_SPEND_PER_OUTING = num('AEP6_LOCAL_SPEND_PER_OUTING')
const SMALL_ADOPTION_SHARE = num('SMALL_ADOPTION_SHARE')
const MEDIUM_ADOPTION_SHARE = num('MEDIUM_ADOPTION_SHARE')
const LARGE_ADOPTION_SHARE = num('LARGE_ADOPTION_SHARE')
const OPTIMISTIC_ADOPTION_SHARE = num('OPTIMISTIC_ADOPTION_SHARE')
const ADOPTION_OUTINGS_PER_USER = num('ADOPTION_OUTINGS_PER_USER')

const REACH_MEASURED_THROUGH = src.match(/export const REACH_MEASURED_THROUGH = '([^']+)'/)?.[1]

// SUMMIT_COUNTY_ADULTS is `Math.round(SUMMIT_COUNTY_POPULATION * SUMMIT_COUNTY_ADULT_SHARE)` in the
// source, not a literal - recompute it the same way rather than relaxing num() to match expressions.
const SUMMIT_COUNTY_ADULTS = Math.round(SUMMIT_COUNTY_POPULATION * SUMMIT_COUNTY_ADULT_SHARE)
// TODAY_ADOPTION_SHARE is `ANNUAL_UNIQUE_USERS / SUMMIT_COUNTY_ADULTS` in the source (derived so the
// slider floor climbs with measured reach) - recompute it the same way rather than relaxing num().
const TODAY_ADOPTION_SHARE = ANNUAL_UNIQUE_USERS / SUMMIT_COUNTY_ADULTS

// LAST_30D_USERS is `TODAY_MONTHLY_ACTIVE_USERS` in the source (2026-08-17
// users-first refactor) - the same GA4 measurement kept under a second name
// for this section's reach-context prose, not a re-typed literal. Assert the
// derivation stays that identifier reference, then resolve it the same way.
assert.match(
  src,
  /export const LAST_30D_USERS = TODAY_MONTHLY_ACTIVE_USERS/,
  `${FINANCIALS_REL} must keep LAST_30D_USERS derived as \`TODAY_MONTHLY_ACTIVE_USERS\`, not a ` +
    'hand-typed literal - the two names the same measured figure, and a hand-typed literal here ' +
    'could silently drift from the users-first traffic driver.',
)
const LAST_30D_USERS = TODAY_MONTHLY_ACTIVE_USERS

function section(startMarker, endMarker) {
  const i = src.indexOf(startMarker)
  assert.notEqual(i, -1, `marker not found in ${FINANCIALS_REL}: ${startMarker}`)
  const j = src.indexOf(endMarker, i)
  assert.notEqual(j, -1, `end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(i, j)
}

const scenariosBlock = section('export const IMPACT_SCENARIOS: ImpactScenario[] = [', '\n]\n')

const declaredScenarioKeys = [...scenariosBlock.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1])

const scenarios = []
for (const entry of scenariosBlock.split(/\n {2}\{\n/).slice(1)) {
  const key = entry.match(/key:\s*'([^']+)'/)?.[1]
  if (!key) continue
  scenarios.push({
    key,
    isCeiling: /isCeiling:\s*true/.test(entry),
    measuredUsers: entry.match(/measuredUsers:\s*([A-Za-z_][\w.]*|[\d.]+)/)?.[1],
    shareOfAdults: entry.match(/shareOfAdults:\s*([A-Za-z_][\w.]*|[\d.]+)/)?.[1],
    outingsPerUser: entry.match(/outingsPerUser:\s*([A-Za-z_][\w.]*|[\d.]+)/)?.[1],
    spendPerOuting: entry.match(/spendPerOuting:\s*([A-Za-z_][\w.]*|[\d.]+)/)?.[1],
  })
}

/** Resolve a raw extracted token (a literal number or a known constant name) to a number. */
const KNOWN = {
  ANNUAL_UNIQUE_USERS,
  OUTING_CONVERSION,
  SPEND_PER_OUTING,
  AEP6_LOCAL_SPEND_PER_OUTING,
  SMALL_ADOPTION_SHARE,
  MEDIUM_ADOPTION_SHARE,
  LARGE_ADOPTION_SHARE,
  OPTIMISTIC_ADOPTION_SHARE,
  TODAY_ADOPTION_SHARE,
  ADOPTION_OUTINGS_PER_USER,
}
function resolve(token) {
  if (token == null) return undefined
  if (/^-?[\d.]+$/.test(token)) return Number(token)
  assert.ok(token in KNOWN, `unresolvable token '${token}' in an IMPACT_SCENARIOS entry - add it to KNOWN`)
  return KNOWN[token]
}

// Recompute the ladder the same way IMPACT_LADDER does in financials.ts.
const ladder = scenarios.map((s) => {
  const measuredUsers = resolve(s.measuredUsers)
  const shareOfAdults = resolve(s.shareOfAdults) ?? 0
  const usersUnrounded = measuredUsers ?? SUMMIT_COUNTY_ADULTS * shareOfAdults
  const outingsPerUser = resolve(s.outingsPerUser)
  const spendPerOuting = resolve(s.spendPerOuting)
  return {
    key: s.key,
    isCeiling: s.isCeiling,
    shareOfAdults,
    usersUnrounded,
    users: Math.round(usersUnrounded),
    outings: Math.round(usersUnrounded * outingsPerUser),
    facilitated: Math.round(usersUnrounded * outingsPerUser * spendPerOuting),
  }
})

describe('adoption ladder inputs', () => {
  it('financials.ts exports every scalar input the ladder needs', () => {
    for (const [name, value] of Object.entries({
      ANNUAL_UNIQUE_USERS,
      LAST_30D_USERS,
      SUMMIT_COUNTY_POPULATION,
      SUMMIT_COUNTY_ADULT_SHARE,
      OUTING_CONVERSION,
      SPEND_PER_OUTING,
      AEP6_LOCAL_SPEND_PER_OUTING,
      SMALL_ADOPTION_SHARE,
      MEDIUM_ADOPTION_SHARE,
      LARGE_ADOPTION_SHARE,
      OPTIMISTIC_ADOPTION_SHARE,
      TODAY_ADOPTION_SHARE,
      ADOPTION_OUTINGS_PER_USER,
    })) {
      assert.ok(Number.isFinite(value), `${name} did not parse as a number in ${FINANCIALS_REL}`)
    }
    assert.ok(REACH_MEASURED_THROUGH, `${FINANCIALS_REL} must export REACH_MEASURED_THROUGH as a quoted string`)
  })

  it('OUTING_CONVERSION is a plausible share, not a raw percentage or a typo', () => {
    // Written as a fraction (0.10), not "10". A stray "10" here would make
    // every reader ten annual outings, not one in ten annual users.
    assert.ok(
      OUTING_CONVERSION > 0 && OUTING_CONVERSION < 1,
      `OUTING_CONVERSION is ${OUTING_CONVERSION}, expected a fraction between 0 and 1`,
    )
  })

  it('SPEND_PER_OUTING is a positive whole dollar figure', () => {
    assert.ok(SPEND_PER_OUTING > 0, 'SPEND_PER_OUTING must be positive')
    assert.equal(SPEND_PER_OUTING, Math.round(SPEND_PER_OUTING), 'SPEND_PER_OUTING must be a whole dollar figure')
  })

  it('the adoption-share inputs are plausible shares, not raw percentages', () => {
    for (const [name, value] of Object.entries({
      SUMMIT_COUNTY_ADULT_SHARE,
      SMALL_ADOPTION_SHARE,
      MEDIUM_ADOPTION_SHARE,
      LARGE_ADOPTION_SHARE,
      OPTIMISTIC_ADOPTION_SHARE,
      TODAY_ADOPTION_SHARE,
    })) {
      assert.ok(value > 0 && value <= 1, `${name} is ${value}, expected a fraction between 0 and 1`)
    }
  })

  it('AEP6_LOCAL_SPEND_PER_OUTING is a positive dollar figure', () => {
    assert.ok(AEP6_LOCAL_SPEND_PER_OUTING > 0, 'AEP6_LOCAL_SPEND_PER_OUTING must be positive')
  })
})

describe('REACH_MEASURED_THROUGH freshness', () => {
  it('parses as a date and is under 45 days old', () => {
    const measured = new Date(REACH_MEASURED_THROUGH)
    assert.ok(
      !Number.isNaN(measured.getTime()),
      `REACH_MEASURED_THROUGH '${REACH_MEASURED_THROUGH}' in ${FINANCIALS_REL} does not parse as a date`,
    )
    const ageDays = Math.floor((Date.now() - measured.getTime()) / 86400000)
    assert.ok(
      ageDays <= MAX_REACH_AGE_DAYS,
      `REACH_MEASURED_THROUGH in ${FINANCIALS_REL} is ${ageDays} days old (limit ${MAX_REACH_AGE_DAYS}).\n` +
        'Reach moves far faster than vendor prices (a single press referral moved it 6x in three weeks). ' +
        'Pull a fresh GA4 totalUsers figure for the trailing 365 days (property 538991588) and update ' +
        'ANNUAL_UNIQUE_USERS, LAST_30D_USERS and this date together. Do not touch OUTING_CONVERSION, ' +
        'SPEND_PER_OUTING, or any adoption-ladder input during a routine refresh - changing those is a ' +
        'separate, justified decision.',
    )
  })
})

describe('the ladder parsed every declared scenario', () => {
  it('parsing did not silently swallow a scenario', () => {
    assert.deepEqual(
      scenarios.map((s) => s.key),
      declaredScenarioKeys,
      `parsed ${scenarios.length} scenarios but found ${declaredScenarioKeys.length} key: declarations ` +
        `in ${FINANCIALS_REL}. The textual extractor only recognises an entry that opens as exactly ` +
        '"\\n  {\\n"; anything else is folded into its neighbour and skips every rule in this file.',
    )
    assert.ok(scenarios.length >= 4, `parsed only ${scenarios.length} IMPACT_SCENARIOS entries, expected at least 4`)
  })

  it('IMPACT_SCENARIOS contains a Today rung and a ceiling rung', () => {
    assert.ok(scenarios.some((s) => s.key === 'today'), 'IMPACT_SCENARIOS must contain a "today" rung')
    assert.equal(
      scenarios.filter((s) => s.isCeiling).length,
      1,
      'IMPACT_SCENARIOS must contain exactly one scenario with isCeiling: true',
    )
  })
})

describe('the ceiling rung never exceeds the adult population', () => {
  it('no rung\'s shareOfAdults exceeds 1.0', () => {
    // A shareOfAdults above 1.0 on any rung would publish an audience larger
    // than the county's adult population - the exact failure the ceiling
    // row exists to sit at the top of, not past.
    for (const s of scenarios) {
      if (s.shareOfAdults == null) continue
      const share = resolve(s.shareOfAdults)
      assert.ok(Number.isFinite(share), `IMPACT_SCENARIOS entry '${s.key}' has an unresolvable shareOfAdults`)
      assert.ok(
        share <= 1,
        `IMPACT_SCENARIOS entry '${s.key}' has shareOfAdults ${share}, which exceeds 1.0 (100% of ` +
          'Summit County adults). No rung may claim more users than the county has adults.',
      )
    }
  })

  it('the ceiling rung\'s computed users equals SUMMIT_COUNTY_ADULTS, never more', () => {
    const ceiling = ladder.find((s) => s.isCeiling)
    assert.ok(ceiling, 'no ceiling scenario found in the recomputed ladder')
    assert.ok(
      ceiling.users <= SUMMIT_COUNTY_ADULTS,
      `ceiling rung users (${ceiling.users}) exceeds SUMMIT_COUNTY_ADULTS (${SUMMIT_COUNTY_ADULTS})`,
    )
    assert.ok(
      ceiling.users <= SUMMIT_COUNTY_POPULATION,
      `ceiling rung users (${ceiling.users}) exceeds SUMMIT_COUNTY_POPULATION (${SUMMIT_COUNTY_POPULATION})`,
    )
  })

  it('every rung\'s computed users stays within the adult population', () => {
    for (const s of ladder) {
      assert.ok(
        s.users <= SUMMIT_COUNTY_ADULTS,
        `IMPACT_SCENARIOS entry '${s.key}' computes ${s.users} users, which exceeds ` +
          `SUMMIT_COUNTY_ADULTS (${SUMMIT_COUNTY_ADULTS})`,
      )
    }
  })
})

describe('derived values are computed, not hand-typed', () => {
  it('IMPACT_LADDER is derived from IMPACT_SCENARIOS via .map', () => {
    assert.match(
      src,
      /export const IMPACT_LADDER: ComputedImpactScenario\[\] = IMPACT_SCENARIOS\.map\(/,
      'IMPACT_LADDER must stay a .map() over IMPACT_SCENARIOS, never a literal array - a hand-typed ' +
        'array can drift from the scenario inputs silently, exactly like the bug that made TIER_TOTALS ' +
        'and FORK_INFRA_MONTHLY always-derived above it.',
    )
  })

  it('SUMMIT_COUNTY_ADULTS is derived from SUMMIT_COUNTY_POPULATION, never hand-typed', () => {
    assert.match(
      src,
      /export const SUMMIT_COUNTY_ADULTS = Math\.round\(SUMMIT_COUNTY_POPULATION \* SUMMIT_COUNTY_ADULT_SHARE\)/,
      'SUMMIT_COUNTY_ADULTS must stay Math.round(SUMMIT_COUNTY_POPULATION * SUMMIT_COUNTY_ADULT_SHARE), ' +
        'never a literal number.',
    )
  })

  it('the headline dollar figures match hand-recomputed arithmetic', () => {
    const today = ladder.find((s) => s.key === 'today')
    assert.ok(today, 'no "today" scenario found in the recomputed ladder')
    const expectedTodayFacilitated = Math.round(ANNUAL_UNIQUE_USERS * OUTING_CONVERSION * SPEND_PER_OUTING)
    assert.equal(
      today.facilitated,
      expectedTodayFacilitated,
      'the "today" rung\'s facilitated figure must equal ANNUAL_UNIQUE_USERS x OUTING_CONVERSION x SPEND_PER_OUTING',
    )
    assert.ok(today.facilitated > 0, 'today\'s local spending facilitated figure must be positive')

    const ceiling = ladder.find((s) => s.isCeiling)
    assert.ok(
      ceiling.facilitated >= today.facilitated,
      'the ceiling rung\'s facilitated figure must not be smaller than today\'s',
    )

    // Rungs should read in increasing order of adoption (and therefore
    // facilitated spend) top to bottom - the whole point of a ladder.
    for (let i = 1; i < ladder.length; i++) {
      assert.ok(
        ladder[i].facilitated >= ladder[i - 1].facilitated,
        `IMPACT_SCENARIOS entry '${ladder[i].key}' facilitates less than the rung above it ` +
          `('${ladder[i - 1].key}'); the ladder must read as increasing adoption top to bottom.`,
      )
    }
  })
})

describe('email digest pricing reflects the confirmed subscriber count', () => {
  it("the 'email' cost line is a subscribers-driven schedule priced on Resend Pro, not free", () => {
    // Resend's free tier caps at 100 sends/day; the weekly digest sends the
    // whole list in one morning. Confirmed subscribers (Supabase, checked
    // 2026-08-17) are TODAY_SUBSCRIBERS (138), past that cap, so the
    // schedule's planPrice must be the paid Resend Pro price, not $0 - see
    // test-financials-model.js for the full schedule-shape and
    // never-cheaper-than-today guards.
    const emailEntry = src.match(/key: 'email',[\s\S]*?driver: '(\w+)',\s*planPrice: (\w+),/)
    assert.ok(emailEntry, `could not find the 'email' COST_LINES entry in ${FINANCIALS_REL}`)
    const [, driver, planPriceToken] = emailEntry
    assert.equal(driver, 'subscribers', "the 'email' cost line must declare driver: 'subscribers'")
    assert.notEqual(
      planPriceToken,
      '0',
      "the 'email' cost line's planPrice reads a literal 0, but confirmed subscribers (138) exceed " +
        "Resend's 100-sends-a-day free-tier cap in a single weekly digest send. Re-check " +
        'https://resend.com/pricing and point planPrice at the paid tier again.',
    )

    const resendProPrice = Number(src.match(/export const RESEND_PRO_PRICE = (\d+)/)?.[1])
    assert.ok(resendProPrice > 0, 'RESEND_PRO_PRICE must be a positive, paid plan price')

    const todaySubscribers = Number(src.match(/export const TODAY_SUBSCRIBERS = (\d+)/)?.[1])
    const resendFreeDailyCap = Number(src.match(/export const RESEND_FREE_DAILY_CAP = (\d+)/)?.[1])
    assert.ok(
      todaySubscribers > resendFreeDailyCap,
      `TODAY_SUBSCRIBERS (${todaySubscribers}) must exceed RESEND_FREE_DAILY_CAP ` +
        `(${resendFreeDailyCap}) for the schedule's "Free is never reachable" comment to hold.`,
    )
  })
})
