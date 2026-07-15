/**
 * test-city-of-twinsburg.js
 *
 * Twinsburg is a thin CivicPlus wrapper, so the fetch/parse/upsert path is
 * covered by test-civicplus.js. These tests pin the source-specific behavior:
 *   • mapCategory — the Twinsburg category overrides (Rock the Park → music,
 *     rec sports leagues → sports) plus deferral to the shared default.
 *   • The shared admin/meeting filter correctly classifies Twinsburg's ACTUAL
 *     governance rows vs. its public lineup (real SUMMARY strings captured from
 *     the live catID=14 feed on 2026-07-14).
 *   • civicPlusEventUrl rebuilds the detail link from a real Twinsburg UID.
 *
 * Run:  node --test scripts/tests/test-city-of-twinsburg.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { mapCategory, SOURCE_KEY } = await import('../scrape-city-of-twinsburg.js')
const { isPublicCivicPlusEvent, civicPlusEventUrl } = await import('../lib/civicplus.js')

describe('city_of_twinsburg: source key', () => {
  it('is city_of_twinsburg', () => {
    assert.equal(SOURCE_KEY, 'city_of_twinsburg')
  })
})

describe('city_of_twinsburg: mapCategory overrides', () => {
  it('maps the Rock the Park concert series to music', () => {
    assert.equal(mapCategory({ SUMMARY: 'Rock the Park: Böaterhead' }), 'music')
    assert.equal(mapCategory({ SUMMARY: 'Rock the Park: Hubb’s Groove' }), 'music')
  })

  it('maps adult rec sports leagues to sports', () => {
    assert.equal(mapCategory({ SUMMARY: 'Twinsburg Adult Co-ed Softball' }), 'sports')
    assert.equal(mapCategory({ SUMMARY: 'Adult Pickleball League' }), 'sports')
  })

  it('defers to the shared default for other programming', () => {
    // yoga → fitness, trail clean-up → outdoors, training class → learning
    assert.equal(mapCategory({ SUMMARY: 'Sunrise Yoga' }), 'fitness')
    assert.equal(mapCategory({ SUMMARY: 'Center Valley Trail Clean-up' }), 'outdoors')
    assert.equal(mapCategory({ SUMMARY: 'Babysitter Training Course with CPR Certification' }), 'learning')
  })

  it('returns null when no keyword hits (lets text inference decide)', () => {
    assert.equal(mapCategory({ SUMMARY: 'Certified Pool Operator Course' }), null)
  })
})

describe('city_of_twinsburg: admin filter on real feed rows', () => {
  it('drops Twinsburg governance rows', () => {
    for (const s of [
      'BZA meeting',
      'Regular Council meeting',
      'Caucus meeting',
      'Finance Committee with CIB',
      'Capital Improvements Board meeting',
      'Capital Improvements Board present to Finance',
      'Planning Commission meeting',
      'ARB meeting',
      'Environmental Commission meeting',
      'Civil Service meeting',
      'JEDI meeting',
      'Parks & Recreation meeting',
      'Public Hearing - Ord. 2026-093 and 2026-094',
      'Special Council Meeting - Ord. 2026-093 and 2026-094',
    ]) assert.equal(isPublicCivicPlusEvent(s), false, `should drop: ${s}`)
  })

  it('keeps Twinsburg public programming', () => {
    for (const s of [
      'Rock the Park: Böaterhead',
      'Sunrise Yoga',
      'Center Valley Trail Clean-up',
      'Twinsburg Adult Co-ed Softball',
      'Babysitter Training Course with CPR Certification',
      'Certified Pool Operator Course',
      'First Aid + AED + CPR Training',
    ]) assert.equal(isPublicCivicPlusEvent(s), true, `should keep: ${s}`)
  })
})

describe('city_of_twinsburg: detail-URL reconstruction', () => {
  it('rebuilds /calendar.aspx?EID=<UID> from a real Twinsburg VEVENT UID', () => {
    assert.equal(
      civicPlusEventUrl({ UID: '3213' }, 'https://www.mytwinsburg.com'),
      'https://www.mytwinsburg.com/calendar.aspx?EID=3213',
    )
  })
})
