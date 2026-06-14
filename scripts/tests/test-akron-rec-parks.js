/**
 * test-akron-rec-parks.js — Detail-page parser for the Akron Rec & Parks
 * (RecDesk) scraper. Exercises the REAL exported parsers (the scraper is
 * import-safe; normalize.js builds a Supabase client at import, so we give it
 * dummy creds first, exactly like test-dedupe-pass3.js).
 *
 * Run:  node --test scripts/tests/test-akron-rec-parks.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseDetailHtml, parseDescription, parseFees, parseSchedule,
  mdyToYmd, to24h, decodeEntities, KNOWN_FACILITIES,
} = await import('../scrape-akron-rec-parks.js')

// Canonical Akron neighborhood slugs (mirror of src/lib/neighborhoods.ts /
// migration 028's CHECK constraint). Kept inline so this JS test needn't import
// the TS source; a drift here is caught by test-manifest-sync-style review.
const VALID_NEIGHBORHOOD_SLUGS = new Set([
  'high-hampton', 'merriman-valley', 'northwest-akron', 'merriman-hills',
  'fairlawn-heights', 'wallhaven', 'west-akron', 'highland-square', 'west-hill',
  'cascade-valley', 'sherbondy-hill', 'downtown-akron', 'university-park',
  'middlebury', 'north-hill', 'chapel-hill', 'goodyear-heights', 'east-akron',
  'ellet', 'summit-lake', 'south-akron', 'firestone-park', 'kenmore',
  'coventry-crossing',
])

import {
  DETAIL_HTML, DETAIL_HTML_MINIMAL, DETAIL_HTML_WELL_ONLY,
} from './fixtures/akron-rec-parks-detail.js'

describe('decodeEntities', () => {
  it('decodes named, numeric, and hex entities', () => {
    assert.equal(decodeEntities('A &amp; B'), 'A & B')
    assert.equal(decodeEntities('Campers&#39; trip'), "Campers' trip")
    assert.equal(decodeEntities('quote&#x201c;x&#x201d;'), 'quote“x”')
    assert.equal(decodeEntities('caf&eacute;'), 'caf&eacute;') // unknown name left intact
  })
})

describe('to24h', () => {
  it('converts AM/PM to 24h HH:MM:SS', () => {
    assert.equal(to24h('9:00 AM'), '09:00:00')
    assert.equal(to24h('3:00 PM'), '15:00:00')
    assert.equal(to24h('12:00 PM'), '12:00:00') // noon
    assert.equal(to24h('12:00 AM'), '00:00:00') // midnight
    assert.equal(to24h('11:30 am'), '11:30:00')
  })
  it('returns null on garbage', () => {
    assert.equal(to24h('TBD'), null)
    assert.equal(to24h(''), null)
    assert.equal(to24h(null), null)
  })
})

describe('mdyToYmd', () => {
  it('normalizes M/D/YYYY and MM/DD/YYYY', () => {
    assert.equal(mdyToYmd('6/8/2026'), '2026-06-08')
    assert.equal(mdyToYmd('06/08/2026'), '2026-06-08')
    assert.equal(mdyToYmd('12/31/2026'), '2026-12-31')
    assert.equal(mdyToYmd('garbage'), null)
  })
})

describe('parseDescription', () => {
  it('reads og:description and decodes entities', () => {
    const d = parseDescription(DETAIL_HTML)
    assert.ok(d, 'description should be non-empty')
    assert.ok(d.includes('engaged & learning'), 'decodes &amp;')
    assert.ok(d.includes("Campers' trips"), 'decodes &#39;')
    assert.ok(!/&amp;|&#39;|<[^>]+>/.test(d), 'no leftover entities or tags')
  })
  it('falls back to the body .well block when og:description is absent', () => {
    const d = parseDescription(DETAIL_HTML_WELL_ONLY)
    assert.ok(d.includes('Well-only copy here.'))
    assert.ok(d.includes('Second line.'), '<br> becomes a newline')
  })
  it('returns null when there is no description anywhere', () => {
    assert.equal(parseDescription('<html><body>nothing</body></html>'), null)
  })
})

describe('parseFees', () => {
  it('reports the public (unrestricted) price and ignores discount + addon rows', () => {
    // $300 is the only open row; $25/$210 are membership-gated; $100 addons live
    // in a second table and must not be considered.
    assert.deepEqual(parseFees(DETAIL_HTML), { min: 300, max: 300 })
  })
  it('returns nulls when there is no fees section', () => {
    assert.deepEqual(parseFees(DETAIL_HTML_MINIMAL), { min: null, max: null })
  })
  it('falls back to all rows when none are unrestricted', () => {
    const html = `<div id="program-fees"><table><tbody>
      <tr><th data-label="Standard Fee">Members Only A</th><td data-label="Membership Restrictions"><a href="#">x</a></td><td data-label="Amount">$40.00</td></tr>
      <tr><th data-label="Standard Fee">Members Only B</th><td data-label="Membership Restrictions"><a href="#">y</a></td><td data-label="Amount">$60.00</td></tr>
    </tbody></table></div><div id="program-schedule"></div>`
    assert.deepEqual(parseFees(html), { min: 40, max: 60 })
  })
})

describe('parseSchedule', () => {
  it('extracts first/last dates, daily start/end times, and the facility', () => {
    assert.deepEqual(parseSchedule(DETAIL_HTML), {
      firstDate: '06/08/2026',
      lastDate:  '07/31/2026',
      startTime: '9:00 AM',
      endTime:   '3:00 PM',
      location:  'Lawton Street Community Center',
    })
  })
  it('returns null when there is no schedule table', () => {
    assert.equal(parseSchedule(DETAIL_HTML_MINIMAL), null)
  })
})

describe('KNOWN_FACILITIES map', () => {
  it('every facility has an address and Akron zip', () => {
    for (const [name, f] of Object.entries(KNOWN_FACILITIES)) {
      assert.ok(f.address, `${name} missing address`)
      assert.match(f.zip, /^443\d\d$/, `${name} has a non-Akron zip`)
    }
  })
  it('every assigned neighborhood_slug is a real Akron neighborhood', () => {
    for (const [name, f] of Object.entries(KNOWN_FACILITIES)) {
      if (f.neighborhood_slug == null) continue // intentionally unclassified
      assert.ok(VALID_NEIGHBORHOOD_SLUGS.has(f.neighborhood_slug),
        `${name} → "${f.neighborhood_slug}" is not a canonical slug`)
    }
  })
  it('Kenmore Community Center is tagged kenmore (the polygon resolver gets this wrong)', () => {
    assert.equal(KNOWN_FACILITIES['Kenmore Community Center'].neighborhood_slug, 'kenmore')
  })
})

describe('parseDetailHtml — integration', () => {
  it('produces the full corrected field set for the Lawton camp', () => {
    const d = parseDetailHtml(DETAIL_HTML)
    assert.ok(d.description && d.description.length > 20)
    assert.deepEqual(d.fees, { min: 300, max: 300 })

    // Compose the row's time fields the way main() does, and assert the
    // placeholder 9-5 is gone in favor of the real 9:00 AM-3:00 PM.
    const startYmd  = mdyToYmd(d.schedule.firstDate)
    const endYmd    = mdyToYmd(d.schedule.lastDate)
    const startTime = to24h(d.schedule.startTime)
    const endTime   = to24h(d.schedule.endTime)
    assert.equal(startYmd, '2026-06-08')
    assert.equal(endYmd, '2026-07-31')
    assert.equal(startTime, '09:00:00')
    assert.equal(endTime, '15:00:00')
  })
})
