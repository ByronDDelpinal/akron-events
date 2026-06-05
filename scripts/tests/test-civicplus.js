/**
 * test-civicplus.js
 *
 * Unit tests for the shared CivicPlus library — covering:
 *   • isPublicCivicPlusEvent — drops meetings, holidays, cancellations
 *   • cleanLocationName      — strips trailing address fragments
 *
 * Run:
 *   node --test scripts/tests/test-civicplus.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

import { isPublicCivicPlusEvent, cleanLocationName } from '../lib/civicplus.js'

// ════════════════════════════════════════════════════════════════════════════
// isPublicCivicPlusEvent
// ════════════════════════════════════════════════════════════════════════════

describe('isPublicCivicPlusEvent: drops non-public entries', () => {
  it('drops board / commission / council meetings', () => {
    for (const s of [
      'Building and Zoning Board of Appeals Regular Meeting Agenda',
      'Civil Service Commission Regular Meeting',
      'Planning Commission Meeting',
      'Community Improvement Corporation Meeting',
      'City Council Meeting',
      'City Council Meeting- NO MEETING',
    ]) assert.equal(isPublicCivicPlusEvent(s), false, s)
  })

  it('drops office-closed entries', () => {
    assert.equal(isPublicCivicPlusEvent('Office Closed-Veterans Day'), false)
  })

  it('drops cancelled events', () => {
    assert.equal(isPublicCivicPlusEvent('Summer Concert - Canceled'), false)
  })

  it('drops bare holiday names', () => {
    assert.equal(isPublicCivicPlusEvent('Veterans Day'), false)
    assert.equal(isPublicCivicPlusEvent('Christmas Day'), false)
  })

  it('drops empty string', () => {
    assert.equal(isPublicCivicPlusEvent(''), false)
  })
})

describe('isPublicCivicPlusEvent: keeps public events', () => {
  it('keeps community festivals and markets', () => {
    for (const s of [
      'Stow City Wide Trick-or-Treat',
      'Joshua Stow Festival',
      'Firecracker Run',
      'Hudson Farmers Market',
      'Touch a Truck',
      'Old Fashioned 4th of July',
      'Lakeside Oktoberfest',
    ]) assert.equal(isPublicCivicPlusEvent(s), true, s)
  })

  it('keeps concert-series and outdoor music events', () => {
    for (const s of [
      'Hudson Bandstand - Clocktower',
      'Screen on the Green - Hook',
      'Music on the Circle - Revolution Pie (Beatles Tribute)',
      'Music by the Lake: Teddy Robb',
    ]) assert.equal(isPublicCivicPlusEvent(s), true, s)
  })

  it('keeps holiday ceremonies (holiday word + ceremony context)', () => {
    assert.equal(isPublicCivicPlusEvent('Veterans Day Ceremony'), true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// cleanLocationName
// ════════════════════════════════════════════════════════════════════════════

describe('cleanLocationName', () => {
  it('strips trailing address from plain venue name', () => {
    assert.equal(
      cleanLocationName('Tallmadge Circle Park - 10 Tallmadge Circle  Tallmadge OH 44278'),
      'Tallmadge Circle Park',
    )
  })

  it('converts > sub-location separator to dash', () => {
    assert.equal(
      cleanLocationName('Stow City Hall > Council Chambers - 3760 Darrow Road  Stow OH 44224'),
      'Stow City Hall - Council Chambers',
    )
  })

  it('strips address when venue has no sub-location', () => {
    assert.equal(
      cleanLocationName('The AMP - 1680 Norton Rd.  Stow OH 44224'),
      'The AMP',
    )
  })

  it('returns null for address-only strings', () => {
    assert.equal(cleanLocationName(' -   Stow OH 44224'), null)
  })
})
