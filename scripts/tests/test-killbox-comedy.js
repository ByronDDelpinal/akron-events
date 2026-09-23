/**
 * test-killbox-comedy.js
 *
 * Tests for the KillBox Comedy Club scraper's zero-event reporting guard.
 *
 * Run:
 *   node --test scripts/tests/test-killbox-comedy.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

// main() is guarded, so importing the real module is safe.
const { emptyListingOutcome } = await import('../scrape-killbox-comedy.js')

// ════════════════════════════════════════════════════════════════════════════
// Zero-event reporting guard
// ════════════════════════════════════════════════════════════════════════════
//
// The hydrate wait swallowed its timeout and logUpsertResult defaults to
// status='success', so a night where Seat Engine never hydrated looked like a
// healthy night. KillBox lists ~35 shows nightly; zero is a broken scrape.
describe('KillBox: emptyListingOutcome', () => {
  it('reports a hydrate timeout distinctly', () => {
    const out = emptyListingOutcome({ slugsFound: 0, detailFailures: 0, hydrateTimedOut: true })
    assert.equal(out.status, 'error')
    assert.equal(
      out.errorMessage,
      'Listing hydrated no /events/<slug> links (hydrate wait timed out after 30s)'
    )
    assert.match(out.errorMessage, /timed out/)
  })

  it('reports a loaded page with no slug anchors', () => {
    const out = emptyListingOutcome({ slugsFound: 0, detailFailures: 0, hydrateTimedOut: false })
    assert.equal(out.status, 'error')
    assert.equal(
      out.errorMessage,
      'Listing hydrated no /events/<slug> links (page loaded, 0 slug anchors)'
    )
    assert.doesNotMatch(out.errorMessage, /timed out/)
  })

  it('reports slugs found but every detail page failing', () => {
    const out = emptyListingOutcome({ slugsFound: 36, detailFailures: 36, hydrateTimedOut: false })
    assert.equal(out.status, 'error')
    assert.equal(out.errorMessage, '36 slugs found but all 36 detail pages failed to fetch')
  })

  it('produces three distinct messages for the three failure stages', () => {
    const msgs = new Set([
      emptyListingOutcome({ slugsFound: 0, hydrateTimedOut: true }).errorMessage,
      emptyListingOutcome({ slugsFound: 0, hydrateTimedOut: false }).errorMessage,
      emptyListingOutcome({ slugsFound: 5, detailFailures: 5 }).errorMessage,
    ])
    assert.equal(msgs.size, 3)
  })

  it('treats an empty listing as a clean zero-event run when allowEmptyFeed is set', () => {
    const out = emptyListingOutcome({ allowEmptyFeed: true, slugsFound: 0 })
    assert.equal(out.status, 'success')
    assert.equal(out.errorMessage, null)
    assert.match(out.reason, /expected for this source/)
  })

  it('only opts in on an explicit true — never on a truthy accident', () => {
    for (const v of [undefined, null, false, 0, '', 'yes', 1]) {
      assert.equal(
        emptyListingOutcome({ allowEmptyFeed: v }).status, 'error',
        `value: ${JSON.stringify(v)}`
      )
    }
  })

  it('is safe with no argument or NaN counts — no NaN/undefined leaks', () => {
    const cases = [
      undefined,
      {},
      { slugsFound: NaN, detailFailures: NaN },
      { slugsFound: 3, detailFailures: NaN },
      { slugsFound: 3 },
    ]
    for (const cfg of cases) {
      const out = emptyListingOutcome(cfg)
      assert.equal(out.status, 'error')
      assert.doesNotMatch(out.errorMessage, /NaN|undefined/, JSON.stringify(cfg))
      assert.ok(out.reason.length > 0)
    }
  })
})
