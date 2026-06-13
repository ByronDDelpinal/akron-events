/**
 * Analytics event-name validity test.
 *
 * src/lib/analyticsEvents.ts is the single source of truth for GA4 custom
 * event names. GA4 silently mangles or drops events that break its naming
 * rules, so this test enforces them in CI before a bad name ships:
 *
 *   1. snake_case, starts with a letter, letters/numbers/underscores only.
 *   2. <= 40 characters.
 *   3. Not a GA4 reserved/automatic event name (web data streams).
 *   4. Not a reserved prefix (ga_, firebase_, google_).
 *   5. No duplicate names.
 *
 * analyticsEvents.ts is TypeScript, which node can't import, so the EVENTS
 * values are extracted textually (same approach as test-manifest-sync.js).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/lib/analyticsEvents.ts'), 'utf8')

// Reserved GA4 event names on web data streams.
// https://support.google.com/analytics/answer/13316687
const RESERVED = new Set([
  'app_remove', 'app_store_refund', 'app_store_subscription_cancel',
  'app_store_subscription_renew', 'click', 'error', 'file_download',
  'first_open', 'first_visit', 'form_start', 'form_submit', 'in_app_purchase',
  'page_view', 'scroll', 'session_start', 'user_engagement', 'view_complete',
  'video_progress', 'video_start', 'view_search_results',
])
const RESERVED_PREFIXES = ['ga_', 'firebase_', 'google_', '_']

function extractEventNames(src) {
  const block = src.match(/export const EVENTS = \{([\s\S]*?)\} as const/)
  assert.ok(block, 'Could not locate the EVENTS object in analyticsEvents.ts')
  const names = []
  const re = /:\s*'([^']+)'/g
  let m
  while ((m = re.exec(block[1])) !== null) names.push(m[1])
  return names
}

describe('analytics event registry', () => {
  const names = extractEventNames(SRC)

  it('is non-empty', () => {
    assert.ok(names.length > 0, 'No event names extracted')
  })

  it('has no duplicates', () => {
    assert.equal(new Set(names).size, names.length, 'Duplicate event name in EVENTS')
  })

  for (const name of names) {
    describe(`"${name}"`, () => {
      it('is snake_case starting with a letter', () => {
        assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} is not valid snake_case`)
      })
      it('is <= 40 characters', () => {
        assert.ok(name.length <= 40, `${name} exceeds 40 chars`)
      })
      it('is not a reserved GA4 event name', () => {
        assert.ok(!RESERVED.has(name), `${name} is a reserved GA4 event name`)
      })
      it('does not use a reserved prefix', () => {
        for (const p of RESERVED_PREFIXES) {
          assert.ok(!name.startsWith(p), `${name} uses reserved prefix "${p}"`)
        }
      })
    })
  }
})
