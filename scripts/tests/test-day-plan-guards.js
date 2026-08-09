/**
 * test-day-plan-guards.js — cheap guard tests that catch a future edit
 * accidentally exposing the day planner's private routes to a crawler
 * (docs/day-planner.md §10.4 and §6.6, gitignored; rationale restated here).
 *
 * `/day` and `/d/<code>` must stay OUT of:
 *   - scripts/prerender.js's ROUTES allow-list (both prerendering and the
 *     static HTML it produces would bake the code into a cacheable file)
 *   - api/sitemap.xml.js's STATIC_ROUTES allow-list (a code in the sitemap
 *     is a code handed directly to Google)
 * and vercel.json must carry an X-Robots-Tag: noindex header rule matching
 * /d/:path* — the ONLY layer a non-JS-executing crawler actually sees
 * (Disallow in robots.txt would prevent the crawler from ever seeing the
 * noindex meta tag or this header; see the design's §6.6 for why Disallow is
 * deliberately NOT used here — do not "fix" this by adding one).
 *
 * Reads scripts/prerender.js as TEXT rather than importing it: that module
 * calls `main()` unconditionally at the top level (launches Puppeteer, opens
 * a local server) and is NOT import-safe. api/sitemap.xml.js has no such
 * side effect, but this file stays text-based for both so the two checks
 * are symmetric and neither test accidentally becomes an integration test.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function read(relPath) {
  return readFileSync(new URL(relPath, `file://${ROOT}`), 'utf8')
}

describe('day planner routes stay out of the prerender allow-list', () => {
  it('scripts/prerender.js ROUTES has no /day or /d/ entry', () => {
    const src = read('scripts/prerender.js')
    const match = src.match(/const ROUTES = \[[\s\S]*?\n\]/)
    assert.ok(match, 'could not locate the ROUTES array in scripts/prerender.js — guard test needs updating, not deleting')
    const routesBlock = match[0]
    assert.ok(!/['"]\/day['"]/.test(routesBlock), 'ROUTES must not contain "/day"')
    assert.ok(!/['"]\/d\//.test(routesBlock), 'ROUTES must not contain a "/d/..." entry')
  })
})

describe('day planner routes stay out of the sitemap allow-list', () => {
  it('api/sitemap.xml.js STATIC_ROUTES has no /day or /d/ entry', () => {
    const src = read('api/sitemap.xml.js')
    const match = src.match(/const STATIC_ROUTES = \[[\s\S]*?\n\]/)
    assert.ok(match, 'could not locate the STATIC_ROUTES array in api/sitemap.xml.js — guard test needs updating, not deleting')
    const routesBlock = match[0]
    assert.ok(!/['"]\/day['"]/.test(routesBlock), 'STATIC_ROUTES must not contain "/day"')
    assert.ok(!/['"]\/d\//.test(routesBlock), 'STATIC_ROUTES must not contain a "/d/..." entry')
  })
})

describe('vercel.json noindexes the day planner via a header, not robots.txt Disallow', () => {
  it('has an X-Robots-Tag: noindex header rule matching /d/:path* and /day', () => {
    const vercelConfig = JSON.parse(read('vercel.json'))
    const headerRules = vercelConfig.headers ?? []

    const findRule = (source) => headerRules.find((r) => r.source === source)

    const dRule = findRule('/d/:path*')
    assert.ok(dRule, 'vercel.json must have a headers rule for source "/d/:path*"')
    const dRobotsHeader = (dRule.headers ?? []).find((h) => h.key === 'X-Robots-Tag')
    assert.ok(dRobotsHeader, '/d/:path* header rule must set X-Robots-Tag')
    assert.match(dRobotsHeader.value, /noindex/)

    const dayRule = findRule('/day')
    assert.ok(dayRule, 'vercel.json must have a headers rule for source "/day"')
    const dayRobotsHeader = (dayRule.headers ?? []).find((h) => h.key === 'X-Robots-Tag')
    assert.ok(dayRobotsHeader, '/day header rule must set X-Robots-Tag')
    assert.match(dayRobotsHeader.value, /noindex/)
  })

  it('does not rely on a robots.txt Disallow for /day or /d/ (Disallow would hide the noindex from crawlers)', () => {
    // Out of scope by the maintainer's own instruction (2026-08-08): the
    // pre-existing robots.txt per-crawler Disallow gap is a separate,
    // unrelated fix. This assertion only guards that /day and /d/ specifically
    // were never added to robots.txt as part of THIS feature.
    const robots = read('public/robots.txt')
    assert.ok(!/Disallow:\s*\/day\b/.test(robots), 'robots.txt must not Disallow /day -- that would hide the noindex meta/header from crawlers entirely')
    assert.ok(!/Disallow:\s*\/d\/\b/.test(robots), 'robots.txt must not Disallow /d/ -- same reasoning')
  })
})
