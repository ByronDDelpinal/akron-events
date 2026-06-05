/**
 * test-cuyahoga-falls.js
 *
 * Unit tests for the City of Cuyahoga Falls scraper's calendar grid parser —
 * covering:
 *   • parseGrid — maps event slugs to dates, excludes spillover from adjacent
 *                 months, preserves titles
 *
 * Run:
 *   node --test scripts/tests/test-cuyahoga-falls.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

import { parseGrid } from '../scrape-city-of-cuyahoga-falls.js'

const FIXTURE = `
<td><a href="/calendar-field_cal_date/day/20260605">5</a>
  <a href="/events/falls-downtown-fridays-7">Falls Downtown Fridays</a>
  <a href="/events/city-council-9">City Council</a></td>
<td><a href="/calendar-field_cal_date/day/20260613">13</a>
  <a href="/events/keyser-concerts">Keyser Concerts</a></td>
<td><a href="/calendar-field_cal_date/day/20260701">1</a>
  <a href="/events/picnic-park">Picnic In The Park</a></td>`

describe('parseGrid', () => {
  it('maps event slugs to the correct dates', () => {
    const rows = parseGrid(FIXTURE, '202606')
    const fdf = rows.find(r => r.slug === 'falls-downtown-fridays-7')
    assert.ok(fdf, 'falls-downtown-fridays-7 not found')
    assert.equal(fdf.dateStr, '2026-06-05')
    assert.equal(fdf.title,   'Falls Downtown Fridays')

    const keyser = rows.find(r => r.slug === 'keyser-concerts')
    assert.ok(keyser, 'keyser-concerts not found')
    assert.equal(keyser.dateStr, '2026-06-13')
  })

  it('excludes events that fall outside the target month', () => {
    const rows = parseGrid(FIXTURE, '202606')
    assert.ok(!rows.some(r => r.slug === 'picnic-park'), 'July spillover should be excluded')
  })

  it('includes all in-month events', () => {
    const rows = parseGrid(FIXTURE, '202606')
    assert.equal(rows.length, 3)
  })
})
