/**
 * FIRST_PAGE_CACHE_ROWS ↔ COMPACT_PAGE_SIZE sync test.
 *
 * src/lib/firstPageQuery.js's FIRST_PAGE_CACHE_ROWS is the row count of the
 * single baked variant both edge-cached endpoints serve
 * (api/events-first-page.js and api/events-hub.js). useEvents serves ANY
 * pristine offset-0 request from that cached head: smaller limits slice it,
 * larger limits fetch only the tail beyond the boundary live.
 *
 * The efficient-density first page (COMPACT_PAGE_SIZE in
 * src/components/EventsBrowser.tsx) is the largest limit that must be served
 * ENTIRELY from the cached head — if the bake ever shrinks below it, the
 * efficient first page silently grows a live tail on every pristine load
 * (extra PostgREST round trip for the highest-traffic surface). This test
 * fails CI when the two constants drift out of that relationship.
 *
 * EventsBrowser.tsx is TypeScript, which node can't import, so the constant
 * is extracted textually (same approach as test-manifest-sync.js).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FIRST_PAGE_CACHE_ROWS } from '../../src/lib/firstPageQuery.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const browserSrc = fs.readFileSync(path.join(ROOT, 'src/components/EventsBrowser.tsx'), 'utf8')

describe('FIRST_PAGE_CACHE_ROWS ↔ COMPACT_PAGE_SIZE sync', () => {
  const match = browserSrc.match(/^const COMPACT_PAGE_SIZE = (\d+)\s*$/m)

  it('COMPACT_PAGE_SIZE is extractable from EventsBrowser.tsx', () => {
    assert.ok(match, 'const COMPACT_PAGE_SIZE = <number> not found in src/components/EventsBrowser.tsx — update the regex here if the declaration moved or changed shape')
  })

  it('FIRST_PAGE_CACHE_ROWS is a sane positive integer', () => {
    assert.ok(Number.isInteger(FIRST_PAGE_CACHE_ROWS) && FIRST_PAGE_CACHE_ROWS > 0)
  })

  it('COMPACT_PAGE_SIZE <= FIRST_PAGE_CACHE_ROWS (cached head fully covers the efficient first page)', () => {
    const compactPageSize = Number(match?.[1])
    assert.ok(
      compactPageSize <= FIRST_PAGE_CACHE_ROWS,
      `COMPACT_PAGE_SIZE (${compactPageSize}, src/components/EventsBrowser.tsx) must stay <= FIRST_PAGE_CACHE_ROWS (${FIRST_PAGE_CACHE_ROWS}, src/lib/firstPageQuery.js) — raise the bake or shrink the page`,
    )
  })
})
