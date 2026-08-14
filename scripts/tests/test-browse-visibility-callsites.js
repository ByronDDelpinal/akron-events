/**
 * test-browse-visibility-callsites.js — textual contract test (precedent:
 * test-first-page-cache-rows.js, test-manifest-sync.js): every browse query
 * builder must call applyBrowseVisibility. Crude on purpose — it is what
 * stops a future sixth query path from shipping half the rule and breaking
 * pagination (docs/umbrella-child-hiding.md §8.B).
 *
 * Run:  node --test scripts/tests/test-browse-visibility-callsites.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** Slice `src` from `startMarker` up to (not including) `endMarker`, both
 *  required to appear, `endMarker` searched for AFTER startMarker. */
function region(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  assert.ok(start !== -1, `could not find start marker: ${startMarker}`)
  const end = src.indexOf(endMarker, start + startMarker.length)
  assert.ok(end !== -1, `could not find end marker after start: ${endMarker}`)
  return src.slice(start, end)
}

describe('src/lib/firstPageQuery.js — both edge-cached builders', () => {
  const src = read('src/lib/firstPageQuery.js')

  it('imports applyBrowseVisibility', () => {
    assert.match(src, /import\s*\{\s*applyBrowseVisibility\s*\}\s*from\s*['"]\.\/browseVisibility\.js['"]/)
  })

  it('buildFirstPageQuery calls applyBrowseVisibility', () => {
    const body = region(src, 'export function buildFirstPageQuery', 'export function buildHubFirstPageQuery')
    assert.match(body, /applyBrowseVisibility\(query\)/)
  })

  it('buildHubFirstPageQuery calls applyBrowseVisibility', () => {
    const start = src.indexOf('export function buildHubFirstPageQuery')
    assert.ok(start !== -1)
    const body = src.slice(start)
    assert.match(body, /applyBrowseVisibility\(query\)/)
  })
})

describe('src/hooks/useEvents.ts — buildLiveQuery, buildQuery (useMapEvents), useRelatedEvents', () => {
  const src = read('src/hooks/useEvents.ts')

  it('imports applyBrowseVisibility', () => {
    assert.match(src, /import\s*\{\s*applyBrowseVisibility\s*\}\s*from\s*['"]@\/lib\/browseVisibility['"]/)
  })

  it('useEvents\' buildLiveQuery calls applyBrowseVisibility', () => {
    const body = region(src, 'const buildLiveQuery = (rangeStart', 'return query.range(rangeStart, rangeEnd)')
    assert.match(body, /applyBrowseVisibility\(query\)/)
  })

  it('useRelatedEvents calls applyBrowseVisibility', () => {
    const body = region(src, 'export function useRelatedEvents', 'export interface UseMapEventsOptions')
    assert.match(body, /applyBrowseVisibility\(query\)/)
  })

  it('useMapEvents\' buildQuery calls applyBrowseVisibility', () => {
    const body = region(src, 'const buildQuery = (): LooseQuery => {', 'return query\n        }')
    assert.match(body, /applyBrowseVisibility\(query\)/)
  })
})

describe('surfaces that must NOT apply the rule stay untouched', () => {
  it('api/sitemap.xml.js does not import browseVisibility', () => {
    const src = read('api/sitemap.xml.js')
    assert.ok(!src.includes('browseVisibility'), 'sitemap must list every event, including festival children (§6)')
  })

  it('scripts/prerender.js does not import browseVisibility', () => {
    const src = read('scripts/prerender.js')
    assert.ok(!src.includes('browseVisibility'))
  })

  it('FestivalPage / the hub query is untouched (still a plain .contains query, not this module)', () => {
    const files = fs.readdirSync(path.join(ROOT, 'src/pages')).filter((f) => f === 'FestivalPage.tsx')
    assert.equal(files.length, 1, 'expected src/pages/FestivalPage.tsx to exist')
    const src = read('src/pages/FestivalPage.tsx')
    assert.ok(!src.includes('browseVisibility'), 'the festival hub must keep listing every set, including children')
  })
})
