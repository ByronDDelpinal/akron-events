/**
 * test-guides-page-guards.js - cheap guards on the /guides section.
 *
 * Four things here are easy to break in an ordinary edit and invisible when
 * you look at the rendered result:
 *
 *   1. A guide route dropping out of the sitemap OR out of the prerender
 *      list. Same pair test-financials-page-guards.js asserts, for the same
 *      reason: a sitemap entry with no prerender entry is worse than no entry
 *      at all, because it invites Googlebot to a URL that serves the empty
 *      #root shell (scripts/prerender.js §why).
 *   2. The registry and the body map drifting apart. A guide with no body
 *      renders an empty page that still returns 200 and still sits in the
 *      sitemap. Nothing about that is visible until somebody reports it.
 *   3. guidesData.js growing an import. It is read unbundled by Node from
 *      api/ and scripts/, so a single import of a .ts module breaks the
 *      sitemap function and the prerender build at once.
 *   4. VideoObject half-firing. Every guide ships with no video; if one ever
 *      carries a youtubeId with no uploadDate (or the reverse), the page is
 *      one edit away from emitting structured data for a video that does not
 *      exist, which is fabricated markup and a manual-action risk.
 *
 * All checks are textual or plain registry reads - no bundler, no DOM.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GUIDES } from '../../src/lib/guidesData.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function read(relPath) {
  return readFileSync(new URL(relPath, `file://${ROOT}`), 'utf8')
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const TRACKS = new Set(['using', 'organizers'])

describe('the guides registry is well formed', () => {
  it('has ten guides, five per track', () => {
    assert.equal(GUIDES.length, 10, 'expected ten guides; update this number deliberately, not to silence a failure')
    for (const track of TRACKS) {
      const inTrack = GUIDES.filter((g) => g.track === track)
      assert.equal(inTrack.length, 5, `expected five guides in the "${track}" track, found ${inTrack.length}`)
    }
  })

  it('every track value is one the UI knows how to render', () => {
    for (const g of GUIDES) {
      assert.ok(
        TRACKS.has(g.track),
        `guide "${g.slug}" has track "${g.track}". src/lib/guides.ts narrows this field by hand ` +
          '(TypeScript infers plain string from the .js literal), so this assertion is the only ' +
          'thing standing between a typo and a guide that silently renders in no section at all.',
      )
    }
  })

  it('slugs are unique and URL safe', () => {
    const seen = new Set()
    for (const g of GUIDES) {
      assert.match(g.slug, SLUG_RE, `slug "${g.slug}" must be lowercase words joined by single hyphens`)
      assert.ok(!seen.has(g.slug), `duplicate slug "${g.slug}" - two guides would fight over one URL`)
      seen.add(g.slug)
    }
  })

  it('order is unique within each track', () => {
    for (const track of TRACKS) {
      const orders = GUIDES.filter((g) => g.track === track).map((g) => g.order)
      assert.equal(new Set(orders).size, orders.length, `duplicate order values in the "${track}" track`)
    }
  })

  it('every guide has the copy the page and the meta tags need', () => {
    for (const g of GUIDES) {
      for (const field of ['title', 'seoTitle', 'metaDescription', 'blurb', 'durationLabel']) {
        assert.ok(
          typeof g[field] === 'string' && g[field].trim().length > 0,
          `guide "${g.slug}" is missing ${field}`,
        )
      }
      assert.ok(
        g.metaDescription.length <= 160,
        `guide "${g.slug}" has a ${g.metaDescription.length} character metaDescription. Google truncates ` +
          'past roughly 160, and a cut-off description is the first thing a searcher reads.',
      )
    }
  })

  it('every related slug resolves to a real guide', () => {
    const slugs = new Set(GUIDES.map((g) => g.slug))
    for (const g of GUIDES) {
      for (const rel of g.related ?? []) {
        assert.ok(slugs.has(rel), `guide "${g.slug}" points at related guide "${rel}", which does not exist`)
        assert.notEqual(rel, g.slug, `guide "${g.slug}" lists itself as related`)
      }
    }
  })
})

describe('guidesData.js stays plain, zero-import JS', () => {
  it('has no import statement', () => {
    const src = read('src/lib/guidesData.js')
    assert.ok(
      !/^\s*import[\s{'"(]/m.test(src) && !/^\s*export\s+[^\n]*\bfrom\b/m.test(src),
      'src/lib/guidesData.js must have ZERO imports. api/sitemap.xml.js and scripts/prerender.js ' +
        'read it unbundled through Node, so one import of a .ts module breaks the sitemap function ' +
        'and the prerender build at the same time. Put anything that needs imports in guides.ts.',
    )
  })

  it('is not shadowed by a src/lib/guides.js', () => {
    let exists = true
    try {
      read('src/lib/guides.js')
    } catch {
      exists = false
    }
    assert.equal(
      exists,
      false,
      'src/lib/guides.js exists. Vite resolves a bare `@/lib/guides` import to .js before .ts, so ' +
        'that file would silently hijack every typed import of guides.ts. Same trap festivalsData.js ' +
        'documents; the data file is named guidesData.js for exactly this reason.',
    )
  })
})

describe('every guide has a body, and every body has a guide', () => {
  const map = read('src/pages/guides/guideBodies.ts')

  it('the body map covers every registry slug', () => {
    for (const g of GUIDES) {
      assert.ok(
        map.includes(`'${g.slug}':`),
        `no body registered for "${g.slug}" in src/pages/guides/guideBodies.ts. The page would render ` +
          'its hero and an empty article, return 200, and stay in the sitemap.',
      )
    }
  })

  it('the body map has no entries the registry does not know about', () => {
    const mapped = [...map.matchAll(/^\s*'([a-z0-9-]+)':/gm)].map((m) => m[1])
    const slugs = new Set(GUIDES.map((g) => g.slug))
    for (const slug of mapped) {
      assert.ok(slugs.has(slug), `guideBodies.ts maps "${slug}", which is not in the registry - dead prose nobody can reach`)
    }
  })
})

describe('the guides are crawlable', () => {
  const sitemap = read('api/sitemap.xml.js')
  const prerender = read('scripts/prerender.js')

  it('api/sitemap.xml.js STATIC_ROUTES covers the hub and every guide', () => {
    const match = sitemap.match(/const STATIC_ROUTES = \[[\s\S]*?\n\]/)
    assert.ok(match, 'could not locate STATIC_ROUTES in api/sitemap.xml.js - this guard needs updating, not deleting')
    assert.ok(/['"]\/guides['"]/.test(match[0]), 'STATIC_ROUTES must contain "/guides"')
    assert.ok(
      /GUIDES\.map/.test(match[0]),
      'STATIC_ROUTES must spread GUIDES.map(...) so a new guide is picked up by one edit. A hand-listed ' +
        'set of guide paths drifts the first time somebody adds one.',
    )
    // Asserting the literal path template, not just that GUIDES is mapped: a
    // typo of `/guide/${g.slug}` here would pass every other check in this
    // file and produce exactly the sitemap-entry-with-no-prerender-entry
    // failure described at the top.
    assert.ok(
      /\/guides\/\$\{g\.slug\}/.test(match[0]),
      'STATIC_ROUTES must build guide paths as `/guides/${g.slug}` - the same template prerender uses',
    )
    assert.match(sitemap, /from '\.\.\/src\/lib\/guidesData\.js'/, 'api/sitemap.xml.js must import GUIDES from the registry')
  })

  it('scripts/prerender.js ROUTES covers the hub and every guide', () => {
    const match = prerender.match(/const ROUTES = \[[\s\S]*?\n\]/)
    assert.ok(match, 'could not locate ROUTES in scripts/prerender.js - this guard needs updating, not deleting')
    assert.ok(
      /['"]\/guides['"]/.test(match[0]),
      'ROUTES must contain "/guides". The sitemap advertises it; without a prerender entry the crawler ' +
        'gets the empty #root shell, which is the exact failure prerender.js exists to prevent.',
    )
    assert.ok(/GUIDES\.map/.test(match[0]), 'ROUTES must spread GUIDES.map(...) for the same reason the sitemap does')
    assert.ok(
      /\/guides\/\$\{g\.slug\}/.test(match[0]),
      'ROUTES must build guide paths as `/guides/${g.slug}`. If this and the sitemap template ever ' +
        'differ, one of the two lists is advertising URLs the other never renders, which is the whole ' +
        'failure this file exists to catch.',
    )
    assert.match(prerender, /from '\.\.\/src\/lib\/guidesData\.js'/, 'scripts/prerender.js must import GUIDES from the registry')
  })

  it('both routes are registered in the router', () => {
    const app = read('src/App.tsx')
    assert.match(app, /path="\/guides"/, 'src/App.tsx must route /guides')
    assert.match(app, /path="\/guides\/:slug"/, 'src/App.tsx must route /guides/:slug')
  })
})

describe('video fields cannot half-fire', () => {
  it('a guide with no youtubeId carries no other video metadata', () => {
    for (const g of GUIDES) {
      if (g.youtubeId) continue
      for (const field of ['posterSrc', 'uploadDate', 'durationIso']) {
        assert.ok(
          !g[field],
          `guide "${g.slug}" has no youtubeId but sets ${field}. videoObjectSchema guards on all three, ` +
            'so this is one careless edit away from emitting VideoObject markup for a video that does ' +
            'not exist. Fill all four fields together or none of them.',
        )
      }
    }
  })

  it('a guide with a youtubeId carries what VideoObject needs', () => {
    for (const g of GUIDES) {
      if (!g.youtubeId) continue
      assert.ok(g.posterSrc, `guide "${g.slug}" has a video but no posterSrc - the facade would render an empty box`)
      assert.ok(g.uploadDate, `guide "${g.slug}" has a video but no uploadDate - VideoObject would stay suppressed`)
    }
  })

  it('the facade never contacts YouTube before a click', () => {
    // Comments stripped first: the component's own doc comment explains why it
    // does not preconnect, and scanning that would fail on the explanation.
    const facade = read('src/components/VideoFacade.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.ok(
      !/(preconnect|dns-prefetch|rel="preload")/.test(facade),
      'VideoFacade must not preconnect, dns-prefetch or preload any YouTube host. That puts the ' +
        'third-party request back on the critical path, which is the entire thing the facade exists to avoid.',
    )
    assert.ok(
      /youtube-nocookie\.com/.test(facade),
      'the click-loaded iframe should use youtube-nocookie.com',
    )
    // Absence of preconnect is not enough on its own: delete the click gate and
    // render the iframe unconditionally and the assertions above stay green,
    // which is precisely the regression this test is named for.
    assert.match(
      facade,
      /useState\(false\)/,
      'VideoFacade must keep a false-by-default playing state - that state IS the gate',
    )
    assert.match(
      facade,
      /if \(playing\)/,
      'the iframe must render only inside a `playing` branch. Without the gate the page loads the ' +
        'YouTube player for every visitor, which is the exact cost the facade exists to avoid.',
    )
  })

  it('no poster can reach out to a third-party host on load', () => {
    for (const g of GUIDES) {
      if (!g.posterSrc) continue
      assert.ok(
        g.posterSrc.startsWith('/'),
        `guide "${g.slug}" has posterSrc "${g.posterSrc}". Posters must be root-relative files we ` +
          'serve ourselves. A remote poster (i.ytimg.com, a CDN) makes the facade contact a third ' +
          'party on load, which defeats it, and videoObjectSchema builds thumbnailUrl assuming this too.',
      )
    }
  })
})
