/**
 * test-friends-page-guards.js - cheap guards on the /friends support ask.
 *
 * Mirrors test-financials-page-guards.js's approach: textual checks, no
 * bundler, no DOM. What this page (and its mentions elsewhere) can silently
 * get wrong:
 *
 *   1. The checkout link pointing somewhere other than Square, which would
 *      send card data to code we do not control.
 *   2. Copy claiming Akron Pulse is a "nonprofit" / "charitable" org, or
 *      claiming a contribution IS tax-deductible without qualification -
 *      Akron Pulse is not a registered charity, and either is a false claim
 *      to a supporter. A truthful negation ("is not tax-deductible") is
 *      fine and is exactly what the FAQ answer states, so the
 *      tax-deductible check requires the negator to sit in the SAME clause
 *      as the phrase (no sentence/clause punctuation between them), rather
 *      than banning the phrase outright. The one thing that check has to
 *      special-case is the FAQ's own <dt> - "Is this tax-deductible?" is a
 *      bare interrogative with no negator anywhere near it, and a question
 *      is not a claim, so a match immediately followed by "?" is allowed
 *      regardless of what precedes it.
 *   3. /friends becoming linked while it is a soft launch (Byron,
 *      2026-09-02), or dropping out of the sitemap / prerender list, or
 *      /friends/thank-you leaking into either (it is a redirect target).
 *   4. vercel.json missing the noindex header for /friends/thank-you, or
 *      gaining one for /friends itself.
 *   5. The outbound Square link missing target="_blank" or the shared rel.
 *   6. FRIEND_LINK_REL silently losing noopener/noreferrer.
 *   7. FRIENDS entries with a bad key/date/kind, or ACTIVE_FRIENDS and
 *      PAST_FRIENDS drifting out of sync with each other.
 *   8. A hand-typed dollar figure creeping into friends.ts.
 *   9. A dollar figure, the AEP6 spend, or the outings assumption typed
 *      into FriendsPage.tsx instead of derived from financials.ts; the
 *      shared slider rules drifting back into FinancialsPage.css; or the
 *      retired FRIEND_TIERS exports reappearing in friends.ts.
 *   10. /friends is branded exactly like /financials (maintainer request,
 *       later round): a fin- class either page renders that resolves to
 *       nothing in src/styles/openbooks.css (typo, or a class that never
 *       got moved), openbooks.css not imported from src/App.tsx, or
 *       FinancialsPage.css still carrying a copy of a class that should
 *       have MOVED to openbooks.css instead.
 *
 * friends.ts is TypeScript, which this Node build CAN import directly
 * (native type stripping, no flag needed) - EXCEPT that it imports from
 * '@/lib/financials' via the Vite path alias, which node's bare ESM
 * resolver cannot follow outside a bundler. financials.ts itself has no
 * such alias import, so it loads directly with no trouble, which is what
 * the impact describe block below relies on to confirm groupMonthlyAtShare
 * and COST_GROUPS exist on the live model.
 * Every other check below stays textual, same approach as
 * test-financials-model.js and test-sponsors-registry.js.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function read(relPath) {
  return readFileSync(new URL(relPath, `file://${ROOT}`), 'utf8')
}

const friendsLib = read('src/lib/friends.ts')
const friendsPage = read('src/pages/FriendsPage.tsx')
const openbooksCss = read('src/styles/openbooks.css')
const appTsx = read('src/App.tsx')
const financialsCss = read('src/pages/FinancialsPage.css')
const pulseSpineTsx = read('src/components/PulseSpine.tsx')
const thankYouPage = read('src/pages/FriendsThankYouPage.tsx')
const financialsPage = read('src/pages/FinancialsPage.tsx')
const aboutPage = read('src/pages/AboutPage.tsx')
const footer = read('src/components/Footer.tsx')

/** Strips /* *\/ block comments (CSS, JS, and JSX {/* *\/}). Neither
 *  FriendsPage.tsx nor FriendsPage.css has a // line comment, so a
 *  block-comment-only strip is enough and avoids the risk of a // strip
 *  truncating a line that happens to contain "https://" inside a string. */
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('the checkout link goes to Square', () => {
  it('FRIEND_CHECKOUT_URL host is exactly square.link', () => {
    const match = friendsLib.match(/export const FRIEND_CHECKOUT_URL = '([^']+)'/)
    assert.ok(match, 'src/lib/friends.ts must export FRIEND_CHECKOUT_URL as a quoted string')
    const host = new URL(match[1]).host
    assert.equal(host, 'square.link', `FRIEND_CHECKOUT_URL host is "${host}", expected "square.link"`)
  })
})

describe('the outbound rel is safe', () => {
  // Mirrors test-financials-page-guards.js's SPONSOR_LINK_REL check
  // (lines 44-56): assert the VALUE, not just that a constant exists,
  // so the rel that actually renders is the rel this test verified.
  it('FRIEND_LINK_REL contains noopener and noreferrer', () => {
    const rel = friendsLib.match(/export const FRIEND_LINK_REL = '([^']+)'/)?.[1]
    assert.ok(rel, 'src/lib/friends.ts must export FRIEND_LINK_REL as a quoted string')
    assert.match(rel, /\bnoopener\b/, 'FRIEND_LINK_REL must contain noopener')
    assert.match(rel, /\bnoreferrer\b/, 'FRIEND_LINK_REL must contain noreferrer')
  })
})

describe('no false charity claims', () => {
  // Plain substring bans: Akron Pulse is not a registered charity, so
  // claiming either status anywhere is simply wrong, negated or not.
  const FORBIDDEN_SUBSTRINGS = ['nonprofit', 'non-profit', 'charitable']

  // tax-deductible is different: "is not tax-deductible" (the FAQ's
  // actual, truthful answer) must pass, while an unqualified "is
  // tax-deductible" claim must fail - even one that happens to share a
  // paragraph with an unrelated "not" elsewhere. So the negator must sit in
  // the SAME clause as the phrase: no sentence or clause punctuation
  // between them. "not a charity, so what you send is tax-deductible" must
  // still fail; "is not tax-deductible" must pass. A bare interrogative
  // ("Is this tax-deductible?") is allowed - the FAQ's <dt> asks the
  // question with no negator anywhere near it, and a question is not a
  // claim.
  const TAX_DEDUCTIBLE_RE = /tax[- ]deductible/gi
  const NEGATED_BEFORE = /\b(not|isn'?t|never|no)\b[^.,;?!]{0,25}$/i

  const FILES = [
    ['src/lib/friends.ts', friendsLib],
    ['src/pages/FriendsPage.tsx', friendsPage],
    ['src/pages/FriendsThankYouPage.tsx', thankYouPage],
    ['src/pages/FinancialsPage.tsx', financialsPage],
    ['src/pages/AboutPage.tsx', aboutPage],
    ['src/components/Footer.tsx', footer],
  ]

  for (const [label, content] of FILES) {
    it(`${label} contains none of ${FORBIDDEN_SUBSTRINGS.join(', ')}`, () => {
      const lower = content.toLowerCase()
      for (const word of FORBIDDEN_SUBSTRINGS) {
        assert.ok(!lower.includes(word), `${label} contains forbidden word "${word}"`)
      }
    })

    it(`${label} never claims tax-deductibility without a same-clause negation`, () => {
      for (const match of content.matchAll(TAX_DEDUCTIBLE_RE)) {
        const before = content.slice(Math.max(0, match.index - 60), match.index)
        const after = content.slice(match.index + match[0].length)
        const isQuestion = /^\s*\?/.test(after)
        assert.ok(
          isQuestion || NEGATED_BEFORE.test(before),
          `${label} claims tax-deductibility without an adjacent negation near: "` +
            `${content.slice(Math.max(0, match.index - 80), match.index + 80).trim()}"`,
        )
      }
    })
  }
})

describe('/friends is a SOFT LAUNCH: unlinked but indexable (Byron, 2026-09-02)', () => {
  // Byron hands the URL to people personally until the public launch, which
  // is soon. So: nothing on the site links to /friends and /financials does
  // not list Friends, but the page IS in the sitemap and prerender list and
  // is NOT noindexed, so launching is only a matter of adding links back.
  // /friends/thank-you stays out of both and noindexed regardless: it is a
  // post-checkout redirect target, not a landing page.
  const listArray = (file, name) => {
    const src = read(file)
    const match = src.match(new RegExp(`const ${name} = \\[[\\s\\S]*?\\n\\]`))
    assert.ok(match, `could not locate the ${name} array in ${file}`)
    return match[0]
  }

  it('no page or component links to /friends, and /financials does not render the Friends registry', () => {
    for (const rel of ['src/components/Footer.tsx', 'src/components/Header.tsx', 'src/pages/AboutPage.tsx', 'src/pages/FinancialsPage.tsx']) {
      const src = read(rel)
      assert.ok(!/to=["']\/friends["']/.test(src) && !/href=["']\/friends["']/.test(src),
        `${rel} links to /friends; the page is a soft launch and must stay unlinked`)
    }
    assert.ok(!/ACTIVE_FRIENDS|FriendChip/.test(read('src/pages/FinancialsPage.tsx')),
      'FinancialsPage.tsx renders the Friends registry; that waits for the public launch')
  })

  it('/friends is in the sitemap and prerender list; /friends/thank-you is in neither', () => {
    for (const [file, name] of [['scripts/prerender.js', 'ROUTES'], ['api/sitemap.xml.js', 'STATIC_ROUTES']]) {
      const arr = listArray(file, name)
      assert.ok(/['"]\/friends['"]/.test(arr), `${name} in ${file} must list /friends`)
      assert.ok(!/['"]\/friends\/thank-you['"]/.test(arr), `${name} in ${file} must not list /friends/thank-you`)
    }
  })

  it('/friends is not noindexed; /friends/thank-you is', () => {
    assert.ok(!/<SEO[\s\S]*?\bnoindex\b[\s\S]*?\/>/.test(friendsPage), 'FriendsPage.tsx must not pass noindex to <SEO>')
    const vercelJson = JSON.parse(read('vercel.json'))
    assert.ok(!vercelJson.headers.some((h) => h.source === '/friends' || h.source === '/friends/(.*)'),
      'vercel.json must not send X-Robots-Tag for /friends itself')
    const rule = vercelJson.headers.find((h) => h.source === '/friends/thank-you')
    assert.ok(rule, 'vercel.json headers must include a rule whose source is "/friends/thank-you"')
    const robotsHeader = rule.headers.find((h) => h.key === 'X-Robots-Tag')
    assert.ok(robotsHeader && /\bnoindex\b/.test(robotsHeader.value), 'X-Robots-Tag for /friends/thank-you must include noindex')
  })
})

describe('the outbound checkout anchor is disclosed and opens in a new tab', () => {
  it('FriendsPage.tsx has an anchor with target="_blank" and rel={FRIEND_LINK_REL}', () => {
    const anchors = [...friendsPage.matchAll(/<a\s[^>]*>/g)].map((m) => m[0])
    const checkoutAnchors = anchors.filter((a) => /href=\{FRIEND_CHECKOUT_URL\}/.test(a))
    assert.ok(checkoutAnchors.length > 0, 'no anchor with href={FRIEND_CHECKOUT_URL} found in FriendsPage.tsx')
    for (const a of checkoutAnchors) {
      assert.match(a, /target="_blank"/, `checkout anchor missing target="_blank": ${a}`)
      assert.match(a, /rel=\{FRIEND_LINK_REL\}/, `checkout anchor missing rel={FRIEND_LINK_REL}: ${a}`)
    }
  })
})

describe('FRIENDS registry shape', () => {
  // Same textual-extraction approach as test-sponsors-registry.js's
  // SPONSORS array, applied to the empty-by-default FRIENDS array.
  const arrayMatch = friendsLib.match(/export const FRIENDS:\s*Friend\[\]\s*=\s*\[([\s\S]*?)\n?\]\s*\n/)
  assert.ok(arrayMatch, 'could not locate the FRIENDS array in src/lib/friends.ts - this guard needs updating, not deleting')

  const field = (entry, name) => entry.match(new RegExp(`${name}:\\s*'([^']*)'`))?.[1]
  const entries = arrayMatch[1]
    .split(/\n {2}\{\n/)
    .slice(1)
    .map((entry) => ({
      key: field(entry, 'key'),
      name: field(entry, 'name'),
      since: field(entry, 'since'),
      until: field(entry, 'until'),
      kind: field(entry, 'kind'),
    }))

  const YM = /^\d{4}-\d{2}$/
  const KINDS = ['monthly', 'one_time']

  it('registry parsing did not silently swallow entries', () => {
    const declaredKeys = [...arrayMatch[1].matchAll(/key:\s*'([^']+)'/g)].length
    assert.equal(
      entries.length,
      declaredKeys,
      `parsed ${entries.length} friends but found ${declaredKeys} key: declarations - the textual ` +
        'extractor is out of step with the file\'s formatting',
    )
  })

  it('keys are unique', () => {
    const keys = entries.map((f) => f.key)
    assert.equal(new Set(keys).size, keys.length, 'duplicate key in FRIENDS - keys are never reused')
  })

  it('every since is YYYY-MM', () => {
    for (const f of entries) {
      assert.match(f.since, YM, `friend '${f.key}': since '${f.since}' must be YYYY-MM`)
    }
  })

  it('every until, when present, is YYYY-MM and not before since', () => {
    for (const f of entries) {
      if (f.until == null) continue
      assert.match(f.until, YM, `friend '${f.key}': until '${f.until}' must be YYYY-MM`)
      assert.ok(f.until >= f.since, `friend '${f.key}': until '${f.until}' is before since '${f.since}'`)
    }
  })

  it('kind, when present, is monthly or one_time', () => {
    for (const f of entries) {
      if (f.kind == null) continue
      assert.ok(
        KINDS.includes(f.kind),
        `friend '${f.key}': kind '${f.kind}' must be one of ${KINDS.join(', ')}`,
      )
    }
  })

  it('ACTIVE_FRIENDS and PAST_FRIENDS partition FRIENDS with no overlap', () => {
    // With FRIENDS empty today, testing the derived exports against real
    // data would prove nothing (see test-sponsors-registry.js's own note on
    // why its validator carries fixtures). What DOES hold regardless of how
    // many entries exist is the partition rule itself: ACTIVE_FRIENDS is
    // exactly "no until" and PAST_FRIENDS is exactly "has until", so every
    // entry lands in exactly one of the two and neither can ever overlap.
    // Checked on the source, which is the one place this invariant can be
    // verified for free, at any registry size.
    assert.match(
      friendsLib,
      /ACTIVE_FRIENDS:\s*Friend\[\]\s*=\s*FRIENDS\s*\n\s*\.filter\(f => !f\.until\)/,
      'ACTIVE_FRIENDS must filter FRIENDS on !f.until',
    )
    assert.match(
      friendsLib,
      /PAST_FRIENDS:\s*Friend\[\]\s*=\s*FRIENDS\s*\n\s*\.filter\(f => f\.until\)/,
      'PAST_FRIENDS must filter FRIENDS on f.until',
    )
    // Applied to today's real entries too, empty or not: every parsed entry
    // must be classifiable as exactly one of active/past by that same rule.
    for (const f of entries) {
      const isActive = f.until == null
      assert.ok(isActive || f.until, `friend '${f.key}' is neither active nor past - impossible given the filters above`)
    }
  })
})

describe('friends.ts has no hardcoded dollar figure', () => {
  it('contains no \\$\\d[\\d,]* literal', () => {
    const literals = friendsLib.match(/\$\d[\d,]*/g) ?? []
    assert.deepEqual(
      literals,
      [],
      `src/lib/friends.ts hardcodes ${literals.join(', ')}. Every dollar figure must come from ` +
        'src/lib/financials.ts, never be typed here.',
    )
  })
})

describe('/friends is branded exactly like /financials via the shared openbooks.css', () => {
  // /friends and /friends/thank-you now render the SAME fin- classes
  // /financials does (maintainer request: identical column, spine, and
  // section/card/chip chrome), so the old "no fin- class in FriendsPage"
  // guard is inverted: every fin- class either page's JSX actually renders
  // must resolve to a real selector in the one shared stylesheet, not to
  // nothing (a typo) and not to a second, page-local copy (drift).
  function finClassesReferenced(source) {
    const classes = new Set()
    for (const attr of source.matchAll(/className="([^"]*)"/g)) {
      for (const cls of attr[1].split(/\s+/)) {
        if (cls.startsWith('fin-')) classes.add(cls)
      }
    }
    return classes
  }

  const openbooksCode = stripBlockComments(openbooksCss)

  for (const [label, source] of [
    ['src/pages/FriendsPage.tsx', friendsPage],
    ['src/pages/FriendsThankYouPage.tsx', thankYouPage],
  ]) {
    it(`every fin- class ${label} renders is defined in src/styles/openbooks.css`, () => {
      const used = finClassesReferenced(source)
      assert.ok(used.size > 0, `${label} should render at least one fin- class now that /friends matches /financials`)
      for (const cls of used) {
        const selector = new RegExp(`\\.${cls}\\b`)
        assert.match(
          openbooksCode,
          selector,
          `${label} renders className="${cls}" but src/styles/openbooks.css defines no .${cls} selector - ` +
            'either it is a typo, or this class still needs to be moved into openbooks.css',
        )
      }
    })
  }

  it('src/App.tsx imports openbooks.css', () => {
    assert.match(
      appTsx,
      /import\s+'@\/styles\/openbooks\.css'/,
      'src/App.tsx must import openbooks.css globally, next to forms.css - both /financials and ' +
        '/friends are lazy routes, so a page-local-only import would leave whichever loads second ' +
        'unstyled on a cold visit (the exact bug forms.css itself was created to fix)',
    )
  })

  it('FinancialsPage.css no longer defines .fin-body or .fin-card (proves the move, not a copy)', () => {
    const code = stripBlockComments(financialsCss)
    assert.ok(
      !/\.fin-body\b/.test(code),
      'FinancialsPage.css still defines .fin-body - it should have been MOVED to openbooks.css, not copied, ' +
        'leaving a second, driftable definition behind',
    )
    assert.ok(
      !/\.fin-card\b/.test(code),
      'FinancialsPage.css still defines .fin-card - it should have been MOVED to openbooks.css, not copied',
    )
  })

  it('src/components/PulseSpine.tsx imports its own PulseSpine.css', () => {
    assert.match(
      pulseSpineTsx,
      /import\s+'\.\/PulseSpine\.css'/,
      'PulseSpine.tsx must import PulseSpine.css itself (PageHero precedent: component-owned CSS)',
    )
  })
})

describe('the consent policy replaced the old anonymous-by-default claim', () => {
  it('src/lib/friends.ts docblock does not say "anonymous by default"', () => {
    assert.ok(
      !/anonymous by default/i.test(friendsLib),
      'src/lib/friends.ts must not claim a Friend contribution is "anonymous by default" - the ' +
        'FRIENDS registry + consent policy superseded that claim, and the two cannot both be true',
    )
  })
})

describe('/friends "Massive local economic impact" is computed, never typed', () => {
  // Same rule the financials-page guard enforces: every dollar on the page
  // is interpolated from src/lib/financials.ts. A literal here is copy that
  // will quietly stop matching the model the moment an assumption moves.
  it('FriendsPage.tsx contains no $<digits> literal', () => {
    const literals = friendsPage.match(/\$\d[\d,]*/g) ?? []
    assert.deepEqual(literals, [], `src/pages/FriendsPage.tsx hardcodes ${literals.join(', ')}`)
  })

  it('does not hardcode the AEP6 per-outing spend or the outings-per-user assumption', () => {
    assert.ok(!/29\.77/.test(friendsPage), 'FriendsPage.tsx hardcodes 29.77; use AEP6_LOCAL_SPEND_PER_OUTING')
    assert.ok(!/>\s*\$?30\s*</.test(friendsPage), 'FriendsPage.tsx hardcodes "30" in JSX text; use AEP6_LOCAL_SPEND_PER_OUTING')
    for (const name of ['AEP6_LOCAL_SPEND_PER_OUTING', 'ADOPTION_OUTINGS_PER_USER', 'groupMonthlyAtShare', 'facilitatedSpendAtShare']) {
      assert.ok(friendsPage.includes(name), `FriendsPage.tsx must derive its figures from ${name}`)
    }
  })

  it('renders every COST_GROUPS group through groupMonthlyAtShare (the model still exposes both)', async () => {
    const financials = await import(new URL('src/lib/financials.ts', `file://${ROOT}`))
    assert.equal(typeof financials.groupMonthlyAtShare, 'function')
    assert.ok(Array.isArray(financials.COST_GROUPS) && financials.COST_GROUPS.length === 4, 'expected exactly four cost groups')
    assert.ok(/COST_GROUPS\.map\(/.test(friendsPage), 'FriendsPage.tsx must map COST_GROUPS rather than list groups by hand')
  })

  it('the shared slider row rules moved to openbooks.css and out of FinancialsPage.css', () => {
    const openbooks = read('src/styles/openbooks.css')
    const finCss = read('src/pages/FinancialsPage.css').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const cls of ['.fin-calc__slider-row', '.fin-calc__label', '.fin-calc__slider', '.fin-calc__pct']) {
      assert.ok(openbooks.includes(`${cls} {`), `${cls} must be defined in openbooks.css`)
      assert.ok(!finCss.includes(`${cls} {`), `${cls} must no longer be defined in FinancialsPage.css`)
    }
  })

  it('both adoption sliders come from the one AdoptionControls component and useAdoptionSlider hook', () => {
    const finPage = read('src/pages/FinancialsPage.tsx')
    for (const [label, src] of [['FriendsPage.tsx', friendsPage], ['FinancialsPage.tsx', finPage]]) {
      assert.ok(src.includes("from '@/components/AdoptionControls'"), `${label} must render AdoptionControls`)
      assert.ok(src.includes("from '@/hooks/useAdoptionSlider'"), `${label} must take its state from useAdoptionSlider`)
      assert.ok(!/className="fin-calc__slider-row"/.test(src), `${label} renders its own slider row; use AdoptionControls`)
      assert.ok(!/className="fin-calc__preset"/.test(src), `${label} renders its own preset pills; use AdoptionControls`)
      assert.ok(!/IMPACT_CALC_ADJUSTED/.test(src), `${label} fires impact_calc_adjusted itself; the hook owns that`)
    }
    const controls = read('src/components/AdoptionControls.tsx')
    assert.ok(controls.includes('ADOPTION_PRESETS'), 'AdoptionControls must render ADOPTION_PRESETS from financials.ts')
    assert.ok(!/IMPACT_LADDER\s*\n?\s*\.filter/.test(finPage), 'FinancialsPage.tsx rebuilds the presets locally; use ADOPTION_PRESETS')
  })

  it('friends.ts no longer exports the retired tier list', () => {
    assert.ok(!/FRIEND_TIERS|tierFrom\(|FRIENDS_TO_COVER_SERVICES|FRIEND_UNIT_AMOUNT/.test(friendsLib),
      'src/lib/friends.ts still carries the tier exports the impact section replaced')
  })
})
