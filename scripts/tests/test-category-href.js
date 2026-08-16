/**
 * test-category-href.js — pure-logic unit tests for the category-badge click
 * target builder (src/lib/categoryHref.ts): the "one category, everything else
 * cleared" URL rule, non-filter params surviving, embed lock preservation and
 * the four embed/taxonomy inert cases, the already-the-sole-filter no-op, and
 * the festival-umbrella branch. Node imports the .ts module directly via type
 * stripping (same pattern as test-event-href.js) — categoryHref keeps RELATIVE
 * imports with explicit extensions for exactly this reason.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveCategoryBadgeHref } from '../../src/lib/categoryHref.ts'
import { FESTIVALS } from '../../src/lib/festivalsData.js'
import { FESTIVAL_UMBRELLA_TAG } from '../../src/lib/browseVisibility.js'

const INERT = { kind: 'inert' }
// Inert case 5 only — the badge is the filter the visitor is already on, which
// the component surfaces as aria-current="true".
const INERT_CURRENT = { kind: 'inert', current: true }

/** Site context: no embed. */
function site(search, pathname = '/', tags = null) {
  return { pathname, search, embed: null, tags }
}

/**
 * Plain-object embed fixture. resolveCategoryBadgeHref only reads
 * `categories`, `features.filter` and `lockedKeys`, so a minimal shape keeps
 * these tests free of embedConfig's Vite-only import graph (same trick as
 * test-event-href.js's `{ target: 'inline' }` fixtures).
 */
function embedCfg({ categories = ['music', 'visual-art'], filter = true, lockedKeys = [] } = {}) {
  return { categories, features: { filter }, lockedKeys }
}

function embedCtx(search, opts = {}, pathname = '/embed', tags = null) {
  return { pathname, search, embed: embedCfg(opts), tags }
}

// ── Site: the URL rule ──────────────────────────────────────────────────
describe('resolveCategoryBadgeHref: site grid target', () => {
  it('clears every other filter and keeps one category', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('?q=jazz&date=today&exclude=music&sort=latest')),
      { kind: 'link', href: '/?categories=music' },
    )
  })

  it('drops an exclude of the SAME slug — no special case needed', () => {
    // "Move the category from excluded to included" falls out of the rule:
    // `exclude` is a FILTER_PARAM_KEY, so it is dropped wholesale.
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('?exclude=music,food')),
      { kind: 'link', href: '/?categories=music' },
    )
  })

  it('clears the full filter key set (intent/from/to/price/audience/tod)', () => {
    const search = '?intent=date-night&from=2026-01-01&to=2026-02-01&price=free&audience=no-kids&tod=evening'
    assert.deepEqual(
      resolveCategoryBadgeHref('comedy', site(search)),
      { kind: 'link', href: '/?categories=comedy' },
    )
  })

  it('NON-filter params survive (view stays put)', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('?view=map')),
      { kind: 'link', href: '/?view=map&categories=music' },
    )
  })

  it('empty search yields a clean single-param URL', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('')),
      { kind: 'link', href: '/?categories=music' },
    )
  })

  it('normalizes a bare (no ?) search the same way', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('view=map')),
      { kind: 'link', href: '/?view=map&categories=music' },
    )
  })

  it('always targets the grid, never the current pathname (event detail page)', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('film', site('', '/events/some-slug/abc-123')),
      { kind: 'link', href: '/?categories=film' },
    )
  })

  it('replaces a multi-category selection with the single clicked slug', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('?categories=music,visual-art')),
      { kind: 'link', href: '/?categories=music' },
    )
  })
})

// ── Inert case 1/2: taxonomy ────────────────────────────────────────────
describe('resolveCategoryBadgeHref: taxonomy guards', () => {
  it('unknown slug is inert', () => {
    assert.deepEqual(resolveCategoryBadgeHref('not-a-category', site('')), INERT)
    assert.deepEqual(resolveCategoryBadgeHref('festival-umbrella', site('')), INERT)
  })

  it('empty slug is inert', () => {
    assert.deepEqual(resolveCategoryBadgeHref('', site('')), INERT)
  })

  it("'other' is a valid category but NOT filterable — inert", () => {
    assert.deepEqual(resolveCategoryBadgeHref('other', site('')), INERT)
  })

  it('every other canonical slug does link', () => {
    for (const slug of ['music', 'theater', 'film', 'comedy', 'visual-art', 'food',
      'sports', 'fitness', 'outdoors', 'learning', 'market', 'civic', 'games']) {
      assert.deepEqual(
        resolveCategoryBadgeHref(slug, site('')),
        { kind: 'link', href: `/?categories=${slug}` },
        `${slug} should link`,
      )
    }
  })
})

// ── Inert case 5: already the sole active filter ────────────────────────
describe('resolveCategoryBadgeHref: already-the-sole-filter no-op', () => {
  it('exactly this category and nothing else → inert', () => {
    assert.deepEqual(resolveCategoryBadgeHref('music', site('?categories=music')), INERT_CURRENT)
  })

  it('this category PLUS another filter → still a link (not sole)', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('?q=jazz&categories=music')),
      { kind: 'link', href: '/?categories=music' },
    )
  })

  it('this category alongside a second category → link (not sole)', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('?categories=music,visual-art')),
      { kind: 'link', href: '/?categories=music' },
    )
  })

  it('sole filter but a non-filter param present → inert (that param survives)', () => {
    assert.deepEqual(resolveCategoryBadgeHref('music', site('?view=map&categories=music')), INERT_CURRENT)
  })

  // '%20' in a UTM value canonicalises to '+', so the raw-string compare
  // missed and the current filter's own pill went live. Non-filter params are
  // preserved verbatim in the target, so the two sides must agree on encoding.
  it("no-op holds when a non-filter param carries '%20'", () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('?categories=music&utm_campaign=summer%20fest')),
      INERT_CURRENT,
    )
  })

  it("a '%20' URL that is NOT the sole filter still links, canonically encoded", () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('?q=jazz&categories=music&utm_campaign=summer%20fest')),
      { kind: 'link', href: '/?categories=music&utm_campaign=summer+fest' },
    )
  })

  it('same params on a DIFFERENT pathname → link (we are not on the grid)', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('?categories=music', '/events/music')),
      { kind: 'link', href: '/?categories=music' },
    )
  })
})

// ── Embed ───────────────────────────────────────────────────────────────
describe('resolveCategoryBadgeHref: embed', () => {
  const CONFIG = '?theme=mint&place=highland-square&features=filter,tags&price=free&categories=music,visual-art'

  it('preserves the whole partner config and the LOCKED price', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', embedCtx(CONFIG, { lockedKeys: ['price'] })),
      {
        kind: 'link',
        href: '/embed?theme=mint&place=highland-square&features=filter%2Ctags&price=free&categories=music',
      },
    )
  })

  it('drops an UNLOCKED visitor price the same as any other filter', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', embedCtx('?theme=mint&price=under10&categories=music,visual-art')),
      { kind: 'link', href: '/embed?theme=mint&categories=music' },
    )
  })

  it('preserves a locked date too', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', embedCtx('?date=today&sort=latest&categories=music', { lockedKeys: ['date'] })),
      { kind: 'link', href: '/embed?date=today&categories=music' },
    )
  })

  it('a category the partner did NOT permit is inert', () => {
    assert.deepEqual(resolveCategoryBadgeHref('food', embedCtx(CONFIG, { lockedKeys: ['price'] })), INERT)
  })

  it('an embed with NO locked category set permits nothing — all inert', () => {
    assert.deepEqual(resolveCategoryBadgeHref('music', embedCtx('?theme=mint', { categories: [] })), INERT)
  })

  it('features.filter === false is inert even for a permitted category', () => {
    assert.deepEqual(resolveCategoryBadgeHref('music', embedCtx(CONFIG, { filter: false })), INERT)
  })

  it("'other' stays inert inside an embed that permits it", () => {
    assert.deepEqual(resolveCategoryBadgeHref('other', embedCtx('?categories=other', { categories: ['other'] })), INERT)
  })

  it('already the sole filter inside the embed → inert', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', embedCtx('?theme=mint&categories=music')),
      INERT_CURRENT,
    )
  })

  // Pins the reason gridHref overwrites `categories` IN PLACE rather than
  // deleting it first: here `categories` sits in the MIDDLE of the query, so a
  // delete-then-set would re-append it, reorder the string, and make the
  // already-the-sole-filter compare miss. Do not "tidy" that back.
  it('no-op compare survives `categories` sitting mid-query (order preserved)', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', embedCtx('?theme=mint&categories=music&price=free', { lockedKeys: ['price'] })),
      INERT_CURRENT,
    )
  })

  // A hand-written partner iframe carries a RAW comma; URLSearchParams.toString()
  // canonicalises it to %2C. Comparing the built href against the raw
  // location.search therefore missed, so the pill for the filter the visitor was
  // ALREADY on rendered as a live link and pushed an encoding-only history
  // entry, making their next Back look broken. Both sides are canonicalised now.
  it('no-op holds for a RAW-comma partner URL (?features=filter,tags)', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', embedCtx('?features=filter,tags&categories=music')),
      INERT_CURRENT,
    )
  })

  it('an embed detail pathname still targets /embed, never the detail path', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', embedCtx('?theme=mint&categories=music', {}, '/embed/events/x/1')),
      { kind: 'link', href: '/embed?theme=mint&categories=music' },
    )
  })
})

// ── Festival-umbrella branch ────────────────────────────────────────────
describe('resolveCategoryBadgeHref: festival umbrella', () => {
  const FEST = FESTIVALS[0]
  const UMBRELLA_TAGS = [FESTIVAL_UMBRELLA_TAG, FEST.tag]

  it('a festival badge on an umbrella row goes to the festival hub', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('festival', site('?q=jazz', '/', UMBRELLA_TAGS)),
      { kind: 'link', href: `/festival/${FEST.slug}` },
    )
  })

  // The embed contract outranks the festival shortcut: /festival/<slug> is not
  // under /embed, so taking that branch inside an iframe would navigate the
  // partner's embed out of its own route group and drop the theme, chrome and
  // every lock. Inside an embed the badge filters the EMBED grid instead.
  it('INSIDE AN EMBED a permitted festival badge stays under /embed', () => {
    const res = resolveCategoryBadgeHref(
      'festival',
      embedCtx('?theme=mint&price=free&q=jazz', { categories: ['festival', 'music'], lockedKeys: ['price'] }, '/embed', UMBRELLA_TAGS),
    )
    assert.deepEqual(res, { kind: 'link', href: '/embed?theme=mint&price=free&categories=festival' })
    assert.ok(!res.href.startsWith('/festival/'), 'must never escape the embed to the festival hub')
  })

  it('INSIDE AN EMBED a NON-permitted festival badge is inert, not a hub link', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref(
        'festival',
        embedCtx('?theme=mint&categories=music', { categories: ['music'] }, '/embed', UMBRELLA_TAGS),
      ),
      INERT,
    )
  })

  it('INSIDE AN EMBED with filtering off, an umbrella festival badge is inert', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref(
        'festival',
        embedCtx('?categories=festival', { categories: ['festival'], filter: false }, '/embed', UMBRELLA_TAGS),
      ),
      INERT,
    )
  })

  it('a festival badge on a NON-umbrella row goes to the grid', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('festival', site('?q=jazz', '/', [FEST.tag])),
      { kind: 'link', href: '/?categories=festival' },
    )
    assert.deepEqual(
      resolveCategoryBadgeHref('festival', site('', '/', null)),
      { kind: 'link', href: '/?categories=festival' },
    )
  })

  it('an orphan umbrella tag with no registry tag goes to the grid', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('festival', site('', '/', [FESTIVAL_UMBRELLA_TAG])),
      { kind: 'link', href: '/?categories=festival' },
    )
  })

  it('a NON-festival badge on an umbrella row still goes to the grid', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('music', site('', '/', UMBRELLA_TAGS)),
      { kind: 'link', href: '/?categories=music' },
    )
  })

  it('the festival hub itself is the no-op case', () => {
    assert.deepEqual(
      resolveCategoryBadgeHref('festival', site('', `/festival/${FEST.slug}`, UMBRELLA_TAGS)),
      INERT_CURRENT,
    )
  })
})
