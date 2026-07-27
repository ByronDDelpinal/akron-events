/**
 * CATEGORIES ↔ _shared/slack.ts CATEGORY_LABELS sync test.
 *
 * src/lib/categories.js CATEGORIES is the canonical content-category
 * registry (slug/label/short/emoji/gradient/tagClass/...). supabase/
 * functions/_shared/slack.ts keeps its own CATEGORY_LABELS mirror
 * ({slug,label} pairs only) for renderSignup's "Categories: " bullet,
 * because the Deno edge function runtime can't import a module shared
 * with the Vite/Node side. This test fails CI when the two drift — same
 * shape as test-slack-intent-labels.js (INTENTS ↔ INTENT_LABELS) and the
 * existing manifest.js ↔ dataSources.ts sync test (test-manifest-sync.js).
 *
 * This exists because describePreferences (supabase/functions/slack-notify/
 * render.ts) DOES render category slugs — a claim the architect's original
 * spec got wrong ("nothing in Tier 1 renders category slugs"), which is why
 * CATEGORY_LABELS was never mirrored in the first place and Categories:
 * bullets showed raw DB slugs (`music, theater, festivals`) to partner
 * channels instead of human labels (`Music, Theater, Festivals`).
 *
 * slack.ts is TypeScript, which node can't import directly, so
 * CATEGORY_LABELS is extracted textually (same approach
 * test-slack-intent-labels.js and test-category-constraint-sync.js use for
 * their non-Node counterparts).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CATEGORIES } from '../../src/lib/categories.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/slack.ts'), 'utf8')

function section(startMarker, endMarker) {
  const i = src.indexOf(startMarker)
  assert.notEqual(i, -1, `marker not found: ${startMarker}`)
  const j = src.indexOf(endMarker, i)
  assert.notEqual(j, -1, `end marker not found after: ${startMarker}`)
  return src.slice(i, j)
}

const block = section('export const CATEGORY_LABELS', '\n]')

const slackLabels = [...block.matchAll(/\{\s*slug:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)]
  .map((m) => ({ slug: m[1], label: m[2] }))

describe('CATEGORIES ↔ _shared/slack.ts CATEGORY_LABELS sync', () => {
  it('parsed a plausible number of CATEGORY_LABELS entries', () => {
    assert.ok(
      slackLabels.length > 0,
      'parsed zero CATEGORY_LABELS entries — check the marker/regex still match _shared/slack.ts',
    )
  })

  it('every CATEGORIES slug/label pair is mirrored exactly in CATEGORY_LABELS', () => {
    const bySlackSlug = new Map(slackLabels.map((e) => [e.slug, e.label]))
    const drift = []
    for (const category of CATEGORIES) {
      const mirrored = bySlackSlug.get(category.slug)
      if (mirrored === undefined) {
        drift.push(`missing in _shared/slack.ts CATEGORY_LABELS: '${category.slug}'`)
      } else if (mirrored !== category.label) {
        drift.push(`label mismatch for '${category.slug}': categories.js='${category.label}' vs slack.ts='${mirrored}'`)
      }
    }
    assert.deepEqual(drift, [], drift.join('; '))
  })

  it('CATEGORY_LABELS has no stale slugs absent from CATEGORIES', () => {
    const categorySlugs = new Set(CATEGORIES.map((c) => c.slug))
    const stale = slackLabels.filter((e) => !categorySlugs.has(e.slug)).map((e) => e.slug)
    assert.deepEqual(stale, [], `stale CATEGORY_LABELS entries — remove from _shared/slack.ts or add to CATEGORIES: ${stale.join(', ')}`)
  })

  it('entry counts match exactly', () => {
    assert.equal(
      slackLabels.length, CATEGORIES.length,
      `CATEGORY_LABELS has ${slackLabels.length} entries, CATEGORIES has ${CATEGORIES.length} — update both together`,
    )
  })
})
