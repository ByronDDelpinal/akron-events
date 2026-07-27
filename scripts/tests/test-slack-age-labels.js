/**
 * eventFormatting.ts AGE_LABEL ↔ _shared/slack.ts AGE_LABEL sync test.
 *
 * src/lib/eventFormatting.ts AGE_LABEL is the canonical display-label map
 * for the `events.age_restriction` enum (all_ages/18_plus/21_plus;
 * 'not_specified' is intentionally absent — callers treat it as "no
 * restriction"). supabase/functions/_shared/slack.ts keeps its own AGE_LABEL
 * mirror for renderSignup's "Ages: " bullet, because the Deno edge function
 * runtime can't import eventFormatting.ts (it pulls in date-fns, an npm
 * package not wired up for the Deno side) nor any other Vite/Node-shared
 * module. This test fails CI when the two drift — same shape as
 * test-slack-intent-labels.js and test-slack-category-labels.js.
 *
 * Both source files are TypeScript, which plain `node --test` can't import
 * directly, so both AGE_LABEL blocks are extracted textually (same approach
 * test-manifest-sync.js and test-category-constraint-sync.js use for their
 * non-Node counterparts).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function section(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker)
  assert.notEqual(i, -1, `marker not found: ${startMarker}`)
  const j = src.indexOf(endMarker, i)
  assert.notEqual(j, -1, `end marker not found after: ${startMarker}`)
  return src.slice(i, j)
}

// Matches both bare (`all_ages: 'All ages'`) and quoted (`'18_plus': '18+'`)
// keys, which is how eventFormatting.ts and slack.ts each write the map
// (bare where the key is a valid identifier, quoted where it starts with a
// digit).
function parseLabelPairs(block) {
  const re = /(?:'([^']+)'|([A-Za-z_][\w]*)):\s*'([^']*)'/g
  const out = []
  let m
  while ((m = re.exec(block)) !== null) {
    const key = m[1] ?? m[2]
    out.push({ key, label: m[3] })
  }
  return out
}

const eventFormattingSrc = fs.readFileSync(path.join(ROOT, 'src/lib/eventFormatting.ts'), 'utf8')
const slackSrc = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/slack.ts'), 'utf8')

const canonicalBlock = section(eventFormattingSrc, 'export const AGE_LABEL', '\n})')
const mirrorBlock = section(slackSrc, 'export const AGE_LABEL', '\n})')

const canonical = parseLabelPairs(canonicalBlock)
const mirror = parseLabelPairs(mirrorBlock)

describe('eventFormatting.ts AGE_LABEL ↔ _shared/slack.ts AGE_LABEL sync', () => {
  it('parsed a plausible number of entries from both files', () => {
    assert.ok(canonical.length > 0, 'parsed zero entries from eventFormatting.ts AGE_LABEL — check the marker/regex still match')
    assert.ok(mirror.length > 0, 'parsed zero entries from _shared/slack.ts AGE_LABEL — check the marker/regex still match')
  })

  it('every eventFormatting.ts AGE_LABEL entry is mirrored exactly in _shared/slack.ts', () => {
    const byMirrorKey = new Map(mirror.map((e) => [e.key, e.label]))
    const drift = []
    for (const entry of canonical) {
      const mirrored = byMirrorKey.get(entry.key)
      if (mirrored === undefined) {
        drift.push(`missing in _shared/slack.ts AGE_LABEL: '${entry.key}'`)
      } else if (mirrored !== entry.label) {
        drift.push(`label mismatch for '${entry.key}': eventFormatting.ts='${entry.label}' vs slack.ts='${mirrored}'`)
      }
    }
    assert.deepEqual(drift, [], drift.join('; '))
  })

  it('_shared/slack.ts AGE_LABEL has no stale keys absent from eventFormatting.ts', () => {
    const canonicalKeys = new Set(canonical.map((e) => e.key))
    const stale = mirror.filter((e) => !canonicalKeys.has(e.key)).map((e) => e.key)
    assert.deepEqual(stale, [], `stale _shared/slack.ts AGE_LABEL entries — remove or add to eventFormatting.ts: ${stale.join(', ')}`)
  })

  it('entry counts match exactly', () => {
    assert.equal(
      mirror.length, canonical.length,
      `_shared/slack.ts AGE_LABEL has ${mirror.length} entries, eventFormatting.ts AGE_LABEL has ${canonical.length} — update both together`,
    )
  })
})
