/**
 * Manifest ↔ TechnicalPage registry sync test.
 *
 * scripts/manifest.js is the single source of truth for which scrapers exist.
 * The public Technical page (src/lib/dataSources.ts) layers editorial prose on
 * top of it. This test fails CI when the two drift:
 *
 *   1. Every manifest key must have a DATA_SOURCES entry (the page must
 *      describe every real scraper).
 *   2. Every manifest key must be mapped in SOURCE_GROUP_BY_KEY (so it lands
 *      in a platform table instead of disappearing).
 *   3. Every non-sub DATA_SOURCES key must exist in the manifest (no page
 *      entries for scrapers that don't exist; sub-sources declare `subOf`).
 *   4. Manifest-backed entries must NOT carry an inline `label:` — labels are
 *      derived from the manifest so they can never disagree.
 *   5. Every manifest `script` path must point at a real file.
 *
 * dataSources.ts is TypeScript, which node can't import, so the registry keys
 * are extracted textually (same approach as test-category-constraint-sync.js).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SCRAPERS } from '../manifest.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = fs.readFileSync(path.join(ROOT, 'src/lib/dataSources.ts'), 'utf8')

// ── Extract the registries textually ────────────────────────────────────────

function section(startMarker, endMarker) {
  const i = src.indexOf(startMarker)
  assert.notEqual(i, -1, `marker not found: ${startMarker}`)
  const j = src.indexOf(endMarker, i)
  assert.notEqual(j, -1, `end marker not found after: ${startMarker}`)
  return src.slice(i, j)
}

const dsBlock = section('const RAW_DATA_SOURCES', '\n]\n')
const byKeyBlock = section('export const SOURCE_GROUP_BY_KEY', '\n}\n')

// Each DATA_SOURCES entry: capture its key, whether it has subOf and/or label
const dsEntries = []
for (const entry of dsBlock.split(/\n  \{\n/).slice(1)) {
  const key = entry.match(/key:\s*'([^']+)'/)?.[1]
  if (!key) continue
  dsEntries.push({
    key,
    hasSubOf: /subOf:\s*'/.test(entry),
    hasInlineLabel: /label:\s*['"]/.test(entry),
  })
}
const byKeyKeys = [...byKeyBlock.matchAll(/^\s*(\w+):\s*'[\w-]+',?\s*$/gm)].map((m) => m[1])

const manifestKeys = new Set(SCRAPERS.map((s) => s.key))
const dsKeys = new Set(dsEntries.map((e) => e.key))

// ── Assertions ───────────────────────────────────────────────────────────────

describe('manifest ↔ dataSources sync', () => {
  it('parsed a plausible number of page entries', () => {
    assert.ok(dsEntries.length >= SCRAPERS.length, `parsed only ${dsEntries.length} DATA_SOURCES entries`)
  })

  it('every manifest key has a DATA_SOURCES entry', () => {
    const missing = [...manifestKeys].filter((k) => !dsKeys.has(k))
    assert.deepEqual(missing, [], `add DATA_SOURCES entries in src/lib/dataSources.ts for: ${missing.join(', ')}`)
  })

  it('every manifest key is mapped in SOURCE_GROUP_BY_KEY', () => {
    const missing = [...manifestKeys].filter((k) => !byKeyKeys.includes(k))
    assert.deepEqual(missing, [], `add SOURCE_GROUP_BY_KEY mappings for: ${missing.join(', ')}`)
  })

  it('every non-sub DATA_SOURCES entry exists in the manifest', () => {
    const orphans = dsEntries.filter((e) => !e.hasSubOf && !manifestKeys.has(e.key)).map((e) => e.key)
    assert.deepEqual(orphans, [], `page entries with no manifest scraper (add to manifest or mark subOf): ${orphans.join(', ')}`)
  })

  it('manifest-backed entries derive their label from the manifest (no inline label)', () => {
    const dupes = dsEntries.filter((e) => manifestKeys.has(e.key) && e.hasInlineLabel).map((e) => e.key)
    assert.deepEqual(dupes, [], `remove inline label (manifest is the source of truth) for: ${dupes.join(', ')}`)
  })

  it('every manifest script path exists', () => {
    const missing = SCRAPERS.filter((s) => !fs.existsSync(path.join(ROOT, s.script))).map((s) => s.key)
    assert.deepEqual(missing, [], `manifest scripts not found on disk: ${missing.join(', ')}`)
  })

  it('manifest keys are unique', () => {
    assert.equal(manifestKeys.size, SCRAPERS.length)
  })
})
