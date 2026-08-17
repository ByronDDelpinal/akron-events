/**
 * test-financials-model.js — structural guards on the /financials cost model.
 *
 * src/lib/financials.ts is the committed methodology for a page whose entire
 * value is being right about money. Nothing else in the repo checks it, and
 * every failure mode here is silent in the browser:
 *
 *   1. A tier amount dropped from a `monthly` array shifts every later tier's
 *      number one column left and the page renders it without complaint.
 *   2. A stale PRICES_VERIFIED turns a factual claim ("verified against
 *      vendor pricing pages") into a false one, gradually, with no signal.
 *   3. EMBED_PARTNER_POLICY (what the page TELLS the reader qualifies a site
 *      as an embed partner) and MIN_VIEWS/MIN_WEEKS/WINDOW_DAYS in
 *      api/pageviews.js (what actually qualifies one) used to be kept in step
 *      by a comment in each file saying "keep these in sync". This test is
 *      that comment, made enforceable.
 *
 * financials.ts is TypeScript, which node can't import, so its values are
 * extracted textually — same approach as test-manifest-sync.js. The
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
  'https://resend.com/pricing',
  'https://www.cloudflare.com/products/registrar/',
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
const costBlock = section('export const COST_LINES', '\n]\n')
const policyBlock = section('export const EMBED_PARTNER_POLICY', '} as const')

const tierKeys = [...tiersBlock.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1])

const costLines = []
for (const entry of costBlock.split(/\n {2}\{\n/).slice(1)) {
  const key = entry.match(/key:\s*'([^']+)'/)?.[1]
  if (!key) continue
  const monthlyRaw = entry.match(/monthly:\s*\[([^\]]*)\]/)?.[1]
  assert.ok(monthlyRaw != null, `cost line '${key}' has no monthly: [...] array`)
  costLines.push({
    key,
    monthly: monthlyRaw.split(',').map((s) => s.trim()).filter(Boolean),
  })
}

/**
 * Every `key:` declared inside the COST_LINES block, however it is formatted.
 * The split above only recognises an entry that opens as exactly "\n  {\n",
 * so a line written on one line, or indented four spaces, is silently folded
 * into its neighbour and every rule below skips it — a cost line that gets
 * CHEAPER as traffic grows sailed through this file, tsc and eslint that way.
 * Comparing the two counts is the same non-vacuity cross-check that already
 * defends test-sponsors-registry.js.
 */
const declaredCostKeys = [...costBlock.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1])

/** FORK_INFRA_KEYS as written in the module (see the FORK_INFRA_MONTHLY sum). */
const forkInfraKeys = [
  ...(src.match(/export const FORK_INFRA_KEYS = \[([^\]]*)\]/)?.[1] ?? '')
    .matchAll(/'([^']+)'/g),
].map((m) => m[1])

const num = (name) => {
  const m = src.match(new RegExp(`export const ${name} = (-?\\d+)`))
  assert.ok(m, `${FINANCIALS_REL} must export a numeric ${name}`)
  return Number(m[1])
}

const TODAY_INDEX = num('TODAY_INDEX')
const DEFAULT_TIER_INDEX = num('DEFAULT_TIER_INDEX')

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
    // Without this, every assertion below is only as good as the file's
    // indentation. A well-typed line that gets cheaper at scale, written on
    // one line or indented four spaces, was invisible to this whole suite
    // while still rendering on the page.
    assert.deepEqual(
      costLines.map((l) => l.key),
      declaredCostKeys,
      `parsed ${costLines.length} cost lines but found ${declaredCostKeys.length} key: ` +
        `declarations in ${FINANCIALS_REL}. The textual extractor only recognises an entry that ` +
        'opens as exactly "\\n  {\\n"; anything else is folded into its neighbour and skips every ' +
        'rule in this file. Reformat the entry to match the rest of the array (two-space indent, ' +
        'brace on its own line) — do not relax this check.',
    )
  })

  it('FORK_INFRA_KEYS all name real cost lines', () => {
    // FORK_INFRA_MONTHLY is a filter+sum over COST_LINES. A renamed or
    // removed line does not error, it just quietly drops out of the fork
    // figure the page quotes to other communities.
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

  it('every cost line has one amount per tier', () => {
    for (const line of costLines) {
      assert.equal(
        line.monthly.length,
        tierKeys.length,
        `cost line '${line.key}' has ${line.monthly.length} amounts for ${tierKeys.length} tiers. ` +
          'A missing amount silently shifts every later tier one column left and the page renders it anyway.',
      )
    }
  })

  it('every amount is a non-negative whole dollar figure', () => {
    for (const line of costLines) {
      for (const [i, raw] of line.monthly.entries()) {
        assert.match(
          raw,
          /^\d+$/,
          `cost line '${line.key}' tier ${i} is '${raw}'. Amounts are whole, non-negative dollars: ` +
            'no cents, no negatives, no expressions.',
        )
      }
    }
  })
})

describe('tier indices', () => {
  it('TODAY_INDEX points at the real "today" tier', () => {
    assert.equal(
      tierKeys[TODAY_INDEX],
      'today',
      `TIERS[TODAY_INDEX] is '${tierKeys[TODAY_INDEX]}', not 'today'. Every headline stat, the ` +
        'cost-per-event math, and the sponsor ask read this index as the real current bill.',
    )
  })

  it('both index constants are in range', () => {
    assert.ok(
      TODAY_INDEX >= 0 && TODAY_INDEX < tierKeys.length,
      `TODAY_INDEX ${TODAY_INDEX} is outside TIERS (0..${tierKeys.length - 1})`,
    )
    assert.ok(
      DEFAULT_TIER_INDEX >= 0 && DEFAULT_TIER_INDEX < tierKeys.length,
      `DEFAULT_TIER_INDEX ${DEFAULT_TIER_INDEX} is outside TIERS (0..${tierKeys.length - 1})`,
    )
  })
})

describe('per-line amounts across tiers', () => {
  it('no line gets cheaper as traffic grows', () => {
    for (const line of costLines) {
      const amounts = line.monthly.map(Number)
      for (let i = 1; i < amounts.length; i++) {
        assert.ok(
          amounts[i] >= amounts[i - 1],
          `cost line '${line.key}' drops from $${amounts[i - 1]} at tier ${i - 1} (${tierKeys[i - 1]}) ` +
            `to $${amounts[i]} at tier ${i} (${tierKeys[i]}).\n` +
            'ESCAPE HATCH: a line genuinely CAN get cheaper at scale (a volume discount, a plan ' +
            'change, dropping a vendor). If that is what happened, change this assertion ' +
            'deliberately and record the reason in the failure message, and add the reason to ' +
            `ASSUMPTIONS in ${FINANCIALS_REL}. Do NOT reorder or renumber the tiers to dodge it.`,
        )
      }
    }
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
        `against the vendor pricing pages, correct any amount that moved, THEN bump the date:\n` +
        PRICING_URLS.map((u) => `  - ${u}`).join('\n') +
        '\nBe honest about what this check is: it enforces a CADENCE, not honesty. Bumping the ' +
        'date is exactly what makes it pass, so nothing here can tell a re-checked page from an ' +
        'unchecked one. It only guarantees somebody is asked the question twice a year.',
    )
  })
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
