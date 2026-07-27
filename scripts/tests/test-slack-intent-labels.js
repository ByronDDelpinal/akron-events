/**
 * INTENTS ↔ _shared/intents.ts INTENT_LABELS sync test.
 *
 * src/lib/categories.js INTENTS is the canonical curated-intent registry.
 * supabase/functions/_shared/intents.ts keeps its own INTENT_LABELS mirror
 * ({id,label} pairs only, no categories/facets/tagline) for renderSignup's
 * "Interests: " bullet and subscribe/validate.ts's write-side allowlist,
 * because the Deno edge function runtime can't import a module shared with
 * the Vite/Node side. This test fails CI when the two drift — same shape as
 * the existing manifest.js ↔ dataSources.ts sync test (test-manifest-sync.js).
 *
 * Moved from _shared/slack.ts to _shared/intents.ts (code-reviewer
 * re-review, MINOR 1, 2026-07-27) so subscribe/validate.ts — a public write
 * endpoint's input-sanitization module — doesn't have to import the Slack
 * module (which reads env vars and logs at module scope) just to get this
 * array. This test's target file moved with it.
 *
 * intents.ts is TypeScript, which node can't import directly, so
 * INTENT_LABELS is extracted textually (same approach test-manifest-sync.js
 * and test-category-constraint-sync.js use for their non-Node counterparts).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { INTENTS } from '../../src/lib/categories.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/intents.ts'), 'utf8')

function section(startMarker, endMarker) {
  const i = src.indexOf(startMarker)
  assert.notEqual(i, -1, `marker not found: ${startMarker}`)
  const j = src.indexOf(endMarker, i)
  assert.notEqual(j, -1, `end marker not found after: ${startMarker}`)
  return src.slice(i, j)
}

const block = section('export const INTENT_LABELS', '\n]')

const slackLabels = [...block.matchAll(/\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)]
  .map((m) => ({ id: m[1], label: m[2] }))

describe('INTENTS ↔ _shared/intents.ts INTENT_LABELS sync', () => {
  it('parsed a plausible number of INTENT_LABELS entries', () => {
    assert.ok(
      slackLabels.length > 0,
      'parsed zero INTENT_LABELS entries — check the marker/regex still match _shared/intents.ts',
    )
  })

  it('every INTENTS id/label pair is mirrored exactly in INTENT_LABELS', () => {
    const bySlackId = new Map(slackLabels.map((e) => [e.id, e.label]))
    const drift = []
    for (const intent of INTENTS) {
      const mirrored = bySlackId.get(intent.id)
      if (mirrored === undefined) {
        drift.push(`missing in _shared/intents.ts INTENT_LABELS: '${intent.id}'`)
      } else if (mirrored !== intent.label) {
        drift.push(`label mismatch for '${intent.id}': categories.js='${intent.label}' vs intents.ts='${mirrored}'`)
      }
    }
    assert.deepEqual(drift, [], drift.join('; '))
  })

  it('INTENT_LABELS has no stale ids absent from INTENTS', () => {
    const intentIds = new Set(INTENTS.map((i) => i.id))
    const stale = slackLabels.filter((e) => !intentIds.has(e.id)).map((e) => e.id)
    assert.deepEqual(stale, [], `stale INTENT_LABELS entries — remove from _shared/intents.ts or add to INTENTS: ${stale.join(', ')}`)
  })

  it('entry counts match exactly', () => {
    assert.equal(
      slackLabels.length, INTENTS.length,
      `INTENT_LABELS has ${slackLabels.length} entries, INTENTS has ${INTENTS.length} — update both together`,
    )
  })
})
