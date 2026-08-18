/**
 * test-financials-page-guards.js - cheap guards on the /financials page itself.
 *
 * Three things about this page are easy to break in an ordinary edit and
 * invisible when you look at the rendered result:
 *
 *   1. A sponsor link without rel="... nofollow sponsored" turns a thank-you
 *      into a purchased backlink. That is an undisclosed paid link to a search
 *      engine, and it quietly makes sponsorship worth more than a thank-you,
 *      which is exactly the boundary src/lib/sponsors.ts exists to hold.
 *   2. A hardcoded dollar figure in the copy. Every amount on this page must
 *      be interpolated from src/lib/financials.ts, or the pitch drifts away
 *      from the real bill the moment a price changes - on the one page whose
 *      entire premise is that its numbers are true.
 *   3. The route dropping out of the sitemap OR out of the prerender list.
 *      /financials is a page we WANT crawled; this is the inverse of the /day
 *      and /d/ exclusions asserted in test-day-plan-guards.js, and it checks
 *      BOTH lists exactly as that test does. A sitemap entry with no
 *      prerender entry is worse than no entry at all: it invites Googlebot to
 *      a URL that serves the empty #root shell (scripts/prerender.js §why).
 *
 * All checks are textual - no bundler, no DOM.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function read(relPath) {
  return readFileSync(new URL(relPath, `file://${ROOT}`), 'utf8')
}

const PAGE_REL = 'src/pages/FinancialsPage.tsx'
const page = read(PAGE_REL)
const sponsorsModule = read('src/lib/sponsors.ts')

const declaredRel = sponsorsModule.match(/export const SPONSOR_LINK_REL =\s*'([^']+)'/)?.[1] ?? ''

describe('sponsor links are disclosed, not sold', () => {
  it('SPONSOR_LINK_REL declares nofollow, sponsored, noopener and noreferrer', () => {
    const rel = sponsorsModule.match(/export const SPONSOR_LINK_REL =\s*'([^']+)'/)?.[1]
    assert.ok(rel, 'src/lib/sponsors.ts must export SPONSOR_LINK_REL as a quoted string')
    assert.match(rel, /\bnofollow\b/, 'SPONSOR_LINK_REL must contain nofollow')
    assert.match(rel, /\bsponsored\b/, 'SPONSOR_LINK_REL must contain sponsored')
    // noopener/noreferrer are normally enforced by eslint's
    // react/jsx-no-target-blank, but that rule cannot follow a constant, so
    // the sponsor anchor carries a justified inline disable and this
    // assertion is what actually holds the line.
    assert.match(rel, /\bnoopener\b/, 'SPONSOR_LINK_REL must contain noopener')
    assert.match(rel, /\bnoreferrer\b/, 'SPONSOR_LINK_REL must contain noreferrer')
  })

  it('every sponsor anchor on the page carries it', () => {
    const anchors = [...page.matchAll(/<a\s[^>]*>/g)].map((m) => m[0])
    // Anchors that point at a supporter's own site: either the sponsor chip
    // itself or anything reading a field off a sponsor record. The mailto CTA
    // is deliberately excluded - it goes to us, not out to a sponsor.
    const sponsorAnchors = anchors.filter(
      (a) => /className="fin-sponsor"/.test(a) || /href=\{sponsor\./.test(a),
    )
    assert.ok(
      sponsorAnchors.length > 0,
      `no sponsor anchor found in ${PAGE_REL}. If the sponsors section was removed, remove this ` +
        'guard deliberately; do not let it pass vacuously.',
    )
    for (const a of sponsorAnchors) {
      const relAttr = a.match(/rel=(\{[^}]+\}|"[^"]+")/)?.[1]
      assert.ok(relAttr, `sponsor anchor has no rel attribute: ${a}`)
      if (relAttr.startsWith('{')) {
        // Resolving ANY expression to SPONSOR_LINK_REL's value would pass
        // `rel={SOME_OTHER_REL}` - the constant this test can actually read
        // has to be the one the JSX names.
        assert.equal(
          relAttr,
          '{SPONSOR_LINK_REL}',
          `sponsor anchor uses rel=${relAttr}, an expression this guard cannot follow. Use ` +
            'rel={SPONSOR_LINK_REL} so the value asserted above is the value that renders: ' + a,
        )
      }
      const relValue = relAttr.startsWith('{') ? declaredRel : relAttr.slice(1, -1)
      assert.match(relValue, /\bnofollow\b/, `sponsor anchor rel is missing nofollow: ${a}`)
      assert.match(relValue, /\bsponsored\b/, `sponsor anchor rel is missing sponsored: ${a}`)
    }
  })
})

/**
 * Dollar literals the page is allowed to contain, each one a prose statement
 * about free-ness rather than a figure that can drift:
 *   - "$0 so far this year" (the empty one-off expenses state)
 *   - "costs $0 to start on free tiers" (the fork card)
 * Nothing else. Add to this set only with a reason, never to silence a
 * failure.
 *
 * The scan covers the whole file, comments included. That is deliberate: a
 * figure quoted in a code comment goes stale exactly as silently as one in
 * the copy, and it is what the next maintainer reads before editing.
 */
const ALLOWED_DOLLAR_LITERALS = new Set(['$0'])

describe('every dollar figure comes from the financials module', () => {
  it('the page contains no hardcoded dollar amount', () => {
    // \$\d[\d,]* - NOT \$\d{2,}. The page renders amounts through
    // toLocaleString(), so its own format for the top tier total is "$1,725",
    // which \$\d{2,} does not match at all: a human copy-pasting a stale
    // figure would paste exactly the string this guard used to ignore. The
    // comma class closes that, and starting at one digit closes "$9" too.
    const literals = (page.match(/\$\d[\d,]*/g) ?? []).filter(
      (l) => !ALLOWED_DOLLAR_LITERALS.has(l),
    )
    assert.deepEqual(
      literals,
      [],
      `${PAGE_REL} hardcodes ${literals.join(', ')}. Interpolate from src/lib/financials.ts ` +
        '(MONTHLY_TOTAL, SERVICES_TOTAL, FORK_INFRA_MONTHLY, ...) instead - a literal here goes ' +
        'stale the next time a price moves and nobody notices, because the page still renders.',
    )
  })

  it('reads its data from the shared modules, with no inline copy', () => {
    assert.match(page, /from '@\/lib\/financials'/, `${PAGE_REL} must import from @/lib/financials`)
    assert.match(page, /from '@\/lib\/sponsors'/, `${PAGE_REL} must import from @/lib/sponsors`)
    assert.ok(
      !/^\s*const (SPONSORS|COST_LINES|TIERS|TIER_TOTALS)\b/m.test(page),
      `${PAGE_REL} declares its own copy of a registry that already lives in src/lib/. Two copies ` +
        'means one of them is wrong and the page shows whichever it imported.',
    )
  })
})

describe('/financials is crawlable', () => {
  it('api/sitemap.xml.js STATIC_ROUTES includes /financials', () => {
    const src = read('api/sitemap.xml.js')
    const match = src.match(/const STATIC_ROUTES = \[[\s\S]*?\n\]/)
    assert.ok(
      match,
      'could not locate the STATIC_ROUTES array in api/sitemap.xml.js - guard test needs updating, not deleting',
    )
    assert.ok(
      /['"]\/financials['"]/.test(match[0]),
      'STATIC_ROUTES must contain "/financials" - the open-books page is one we want indexed',
    )
  })

  it('scripts/prerender.js ROUTES includes /financials', () => {
    const src = read('scripts/prerender.js')
    const match = src.match(/const ROUTES = \[[\s\S]*?\n\]/)
    assert.ok(
      match,
      'could not locate the ROUTES array in scripts/prerender.js - guard test needs updating, not deleting',
    )
    assert.ok(
      /['"]\/financials['"]/.test(match[0]),
      'ROUTES must contain "/financials". The sitemap advertises this URL to Google; without a ' +
        'prerender entry the crawler gets the empty #root shell with one generic <title>, which ' +
        'is the exact failure scripts/prerender.js exists to prevent. Sitemap and prerender are ' +
        'a pair - adding a route to one without the other is worse than adding it to neither.',
    )
  })
})
