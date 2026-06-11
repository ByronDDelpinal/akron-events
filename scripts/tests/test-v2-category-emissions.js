/**
 * v2-taxonomy guard — no scraper may emit a legacy v1 category slug.
 *
 * The June 2026 tagging audit (docs/tagging-audit-2026-06.md, Part 2) found
 * every per-source category map still emitted v1 slugs ('art', 'education',
 * 'community', 'nature', 'nonprofit'), silently collapsing through V1_TO_V2
 * and dumping theater/film/comedy/festival/civic content into wrong or
 * 'other' buckets. All maps were rewritten to v2; this test keeps it that way.
 *
 * V1_TO_V2 itself (src/lib/categories.js) is intentionally NOT scanned — it
 * remains the legacy bridge for the public submission form and old rows.
 *
 * Scanned emission shapes (textual, same approach as test-manifest-sync.js):
 *   1. return 'slug'
 *   2. category: 'slug'   (event-row literals)
 *   3. 'key': 'slug'      (category-map object entries)
 * Tag arrays are unaffected — tags are free-form by design.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const V1_ONLY = ['art', 'education', 'community', 'nature', 'nonprofit']
const V1_ALT = V1_ONLY.join('|')

const EMISSION_PATTERNS = [
  new RegExp(`\\breturn\\s+'(${V1_ALT})'`),
  new RegExp(`\\bcategory:\\s*'(${V1_ALT})'`),
  new RegExp(`^\\s*'[^']+':\\s*'(${V1_ALT})',?\\s*(//.*)?$`),
]

function scrapersAndLibs() {
  const top = fs.readdirSync(SCRIPTS)
    .filter((f) => /^(scrape-|fetch-).*\.js$/.test(f))
    .map((f) => path.join(SCRIPTS, f))
  const libs = fs.readdirSync(path.join(SCRIPTS, 'lib'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(SCRIPTS, 'lib', f))
  return [...top, ...libs]
}

describe('v2 category emissions', () => {
  it('finds the expected file set (sanity)', () => {
    const files = scrapersAndLibs()
    assert.ok(files.length > 50, `only ${files.length} files scanned — glob broken?`)
  })

  for (const file of scrapersAndLibs()) {
    it(`${path.relative(SCRIPTS, file)} emits no v1 category slugs`, () => {
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      const hits = []
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return // comments may discuss v1 history
        for (const re of EMISSION_PATTERNS) {
          if (re.test(line)) hits.push(`  L${i + 1}: ${line.trim()}`)
        }
      })
      assert.equal(
        hits.length, 0,
        `v1 category slug emitted (use the v2 slug, or null + a facet flag):\n${hits.join('\n')}`,
      )
    })
  }
})
