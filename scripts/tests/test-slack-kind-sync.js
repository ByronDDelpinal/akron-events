/**
 * test-slack-kind-sync.js
 *
 * Guards against drift between the two places the slack_notifications
 * `kind` enum is declared:
 *   1. The DB CHECK constraint — supabase/migrations/*.sql
 *      (slack_notifications_kind_check: `kind in ('feedback', ...)`)
 *   2. The TypeScript union — supabase/functions/slack-notify/request.ts
 *      (Plan['kind'])
 *
 * This is exactly the drift 046_slack_tier2.sql exists to fix (see that
 * migration's own header) and 051_embed_requests.sql widens for
 * 'embed_request': if the CHECK constraint doesn't allow a kind that
 * planFor() can produce, the claim INSERT in slack-notify/index.ts raises
 * 23514 ("claim failed"), the handler returns HTTP 500, and NOTHING lands
 * anywhere — no Slack message and no ledger row to find it by. The failure
 * is invisible outside the edge function's logs, which is exactly why this
 * sync test exists (docs/embed-request-capture.md §6.7).
 *
 * Same shape as test-category-constraint-sync.js (finds the LATEST
 * migration that (re)defines the constraint, since 046 and 051 both widen
 * it) and test-slack-category-labels.js (extracts a TypeScript union
 * textually, since Deno TS can't be imported by Node directly).
 *
 * Run: node --test scripts/tests/test-slack-kind-sync.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')

/**
 * Return the kind set from the latest migration that defines
 * slack_notifications_kind_check. Migrations are processed in filename
 * order so the highest-numbered definition wins (046 first defines it with
 * the widened Tier 2 set, 051 widens it again for 'embed_request').
 */
function latestKindConstraintSlugs() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const re = /slack_notifications_kind_check\s*\n?\s*check\s*\(\s*kind\s+in\s*\(([^)]*)\)/gi

  let latest = null
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    let m
    while ((m = re.exec(sql)) !== null) {
      const kinds = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
      if (kinds.length > 0) latest = { file, kinds }
    }
  }
  return latest
}

/**
 * Extract the quoted string literals from Plan['kind']'s union in
 * request.ts. request.ts is TypeScript (Deno-only), so this is a textual
 * extraction — same approach test-slack-category-labels.js uses for
 * CATEGORY_LABELS.
 */
function planKindUnion() {
  const src = readFileSync(join(ROOT, 'supabase/functions/slack-notify/request.ts'), 'utf8')
  const marker = 'kind:'
  const startIdx = src.indexOf('export interface Plan')
  assert.notEqual(startIdx, -1, 'export interface Plan not found in request.ts')
  const kindLineStart = src.indexOf(marker, startIdx)
  assert.notEqual(kindLineStart, -1, 'kind: field not found inside interface Plan')
  const lineEnd = src.indexOf('\n', kindLineStart)
  const line = src.slice(kindLineStart, lineEnd)
  const kinds = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1])
  return kinds
}

describe('slack_notifications kind: DB constraint ↔ Plan[\'kind\'] union sync', () => {
  it('finds the slack_notifications_kind_check constraint in the migrations', () => {
    const found = latestKindConstraintSlugs()
    assert.ok(found, 'no slack_notifications_kind_check constraint found in supabase/migrations')
  })

  it('parsed a plausible number of Plan kind union members', () => {
    const kinds = planKindUnion()
    assert.ok(kinds.length > 0, 'parsed zero kind union members — check the marker/regex still match request.ts')
  })

  it('DB constraint kind set exactly matches the Plan[\'kind\'] TypeScript union', () => {
    const { file, kinds: dbKinds } = latestKindConstraintSlugs()
    const tsKinds = planKindUnion()

    const dbSet = new Set(dbKinds)
    const tsSet = new Set(tsKinds)

    const missingFromTs = dbKinds.filter((k) => !tsSet.has(k))
    const missingFromDb = tsKinds.filter((k) => !dbSet.has(k))

    assert.deepEqual(
      missingFromDb, [],
      `Plan['kind'] members in request.ts but NOT allowed by the DB constraint (${file}). ` +
      `A claim insert for this kind will raise check_violation ("claim failed") and nothing will ever land.`
    )
    assert.deepEqual(
      missingFromTs, [],
      `Kinds allowed by the DB constraint (${file}) but NOT in Plan['kind'] (request.ts). ` +
      `Either drop them from the DB or add the matching planFor() arm.`
    )
  })

  it('embed_request is present on both sides (docs/embed-request-capture.md)', () => {
    const { kinds: dbKinds } = latestKindConstraintSlugs()
    const tsKinds = planKindUnion()
    assert.ok(dbKinds.includes('embed_request'), 'embed_request missing from the DB constraint')
    assert.ok(tsKinds.includes('embed_request'), "embed_request missing from Plan['kind']")
  })
})
