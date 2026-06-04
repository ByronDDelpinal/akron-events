/**
 * test-category-constraint-sync.js
 *
 * Guards against drift between the two places the category enum is declared:
 *   1. The canonical registry — src/lib/categories.js (CATEGORY_SLUGS)
 *   2. The Postgres CHECK constraint — supabase/migrations/*.sql
 *      (events_category_check: `category in ('music','art', ...)`)
 *
 * Everything else in the app derives from the registry, but the DB constraint
 * is hand-maintained SQL that the app code can't import. This test parses the
 * MOST RECENT migration that (re)defines the constraint and asserts its slug
 * set is exactly equal to CATEGORY_SLUGS — so adding a category to the registry
 * without shipping a matching migration (or vice versa) fails CI.
 *
 * Run:  node --test scripts/tests/test-category-constraint-sync.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { CATEGORY_SLUGS } from '../../src/lib/categories.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations')

/**
 * Return the slug set from the latest migration that defines the events
 * category CHECK constraint. Recognises both the initial inline form
 * (`category text not null check (category in (...))` in 001) and the later
 * `alter table ... add constraint events_category_check check (category in
 * (...))` form (018, 020, ...). Migrations are processed in filename order so
 * the highest-numbered definition wins.
 */
function latestConstraintSlugs() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  // Match a `category in ( '...','...' )` group that is part of an events
  // category check. We accept either the named constraint or the inline column
  // check; both contain `category` immediately before `in (`. We deliberately
  // exclude the feedback table by requiring the slug list to NOT contain the
  // feedback-only values (bug/love/wish/...).
  const re = /category\s+in\s*\(([^)]*)\)/gi

  let latest = null
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    let m
    while ((m = re.exec(sql)) !== null) {
      const slugs = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
      if (!slugs.length) continue
      // Skip the feedback_posts category constraint.
      if (slugs.includes('bug') || slugs.includes('datasource')) continue
      // Heuristic: the events constraint always includes 'music' and 'other'.
      if (slugs.includes('music') && slugs.includes('other')) {
        latest = { file, slugs }
      }
    }
  }
  return latest
}

describe('category enum: registry ↔ DB constraint sync', () => {
  it('finds the events category constraint in the migrations', () => {
    const found = latestConstraintSlugs()
    assert.ok(found, 'no events_category_check constraint found in supabase/migrations')
  })

  it('registry CATEGORY_SLUGS exactly matches the latest DB constraint', () => {
    const { file, slugs } = latestConstraintSlugs()
    const dbSet = new Set(slugs)
    const registrySet = new Set(CATEGORY_SLUGS)

    const missingFromDb = CATEGORY_SLUGS.filter((s) => !dbSet.has(s))
    const missingFromRegistry = slugs.filter((s) => !registrySet.has(s))

    assert.deepEqual(
      missingFromDb, [],
      `Categories in the registry but NOT in the DB constraint (${file}). ` +
      `Add them to a new migration's events_category_check.`
    )
    assert.deepEqual(
      missingFromRegistry, [],
      `Categories in the DB constraint (${file}) but NOT in the registry ` +
      `(src/lib/categories.js). Add them to CATEGORIES or drop them from the DB.`
    )
  })
})
