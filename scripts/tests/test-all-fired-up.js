/**
 * test-all-fired-up.js
 *
 * Unit tests for the All Fired Up Akron scraper's pure parsers, against real
 * captured Occasion markup. Load-bearing logic: (1) the stack card parser,
 * (2) year resolution from the data-id (the visible label has no year),
 * (3) the detail-page parser (description/price/address), and (4) buildRow's
 * non-event filter + Summit gate + UTC time.
 *
 * Fixtures: real markup captured 2026-09-05.
 *
 * Run:  node --test scripts/tests/test-all-fired-up.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  SOURCE_KEY,
  parseStackHtml,
  resolveCardDate,
  parseStartTime,
  parseEndTime,
  isNonEvent,
  parseDetail,
  buildRow,
  mapTags,
} from '../scrape-all-fired-up.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const STACK = fx('all-fired-up-stack.html')
const COWS = fx('all-fired-up-detail-cows.html')
const GOOSE = fx('all-fired-up-detail-goose.html')

const TODAY = '2026-09-05'

describe('SOURCE_KEY', () => {
  it('is all_fired_up', () => assert.equal(SOURCE_KEY, 'all_fired_up'))
})

describe('parseStackHtml', () => {
  const cards = parseStackHtml(STACK)

  it('parses all 11 occurrence cards', () => assert.equal(cards.length, 11))

  it('reads token/title/date/time/badge/image off the first card', () => {
    const c = cards[0]
    assert.equal(c.token, 'D8cgh7vB')
    assert.equal(c.title, 'Goose Bumps- 7" Desk Goose Workshop')
    assert.equal(c.dataId, '2026091320001358330')
    assert.equal(c.dateText, 'Sun, September 13')
    assert.equal(c.timeText, '4:00 PM - 6:00 PM')
    assert.equal(c.badge, 'Sold Out')
    assert.match(c.image, /cloudinary\.com/)
  })

  it('keeps recurring occurrences as separate cards (same token, different date)', () => {
    const goose = cards.filter((c) => c.token === 'D8cgh7vB')
    const cows = cards.filter((c) => c.token === 't6F7mZwq')
    assert.equal(goose.length, 2)
    assert.equal(cows.length, 2)
  })

  it('decodes an &amp; in a title', () => {
    const acotar = cards.find((c) => /ACOTAR/.test(c.title))
    assert.equal(acotar.title, 'Brushstrokes & Bookmarks: ACOTAR Book Release Party')
  })
})

describe('resolveCardDate', () => {
  it('takes the year+date from the data-id prefix (label has no year)', () => {
    assert.equal(resolveCardDate('2026091320001358330', 'Sun, September 13', TODAY), '2026-09-13')
    assert.equal(resolveCardDate('2026102522001380283', 'Sun, October 25', TODAY), '2026-10-25')
  })

  it('falls back to label + current year when the data-id is missing', () => {
    assert.equal(resolveCardDate(null, 'Thu, October 01', TODAY), '2026-10-01')
  })

  it('rolls the fallback year forward when the month precedes today', () => {
    // No data-id, label month (January) < today (September) → next year.
    assert.equal(resolveCardDate(null, 'Mon, January 05', TODAY), '2027-01-05')
  })
})

describe('parseStartTime / parseEndTime', () => {
  it('splits a "4:00 PM -  6:00 PM" range', () => {
    assert.equal(parseStartTime(' 4:00 PM -  6:00 PM '), '4:00 PM')
    assert.equal(parseEndTime(' 4:00 PM -  6:00 PM '), '6:00 PM')
  })
  it('returns null end when only one time is present', () => {
    assert.equal(parseEndTime('7:00 PM'), null)
  })
})

describe('isNonEvent', () => {
  it('flags kits / to-go / gift cards / interviews', () => {
    assert.ok(isNonEvent('At-Home Kit'))
    assert.ok(isNonEvent('Party Pail- Parties to Go'))
    assert.ok(isNonEvent('Gift Card'))
    assert.ok(isNonEvent('Interviews'))
  })
  it('passes real classes', () => {
    assert.equal(isNonEvent('Painting with BABY Mini-Cows!'), false)
    assert.equal(isNonEvent('Stained Glass Class: Snake Grass Planter'), false)
  })
})

describe('parseDetail', () => {
  it('reads title/description/price/address from the cows page (Ages 8+, $12)', () => {
    const d = parseDetail(COWS)
    assert.equal(d.title, 'Painting with BABY Mini-Cows!')
    assert.match(d.description, /Ages 8\+ only please/)
    assert.equal(d.price, 12)
    assert.equal(d.city, 'Copley')
    assert.equal(d.zip, '44321')
    assert.equal(d.addressLine, '30 Rothrock Loop')
    assert.equal(d.url, 'https://occ.sn/bLtwzLp2')
    assert.match(d.image, /Fall_Cows/)
  })

  it('reads the higher $55 price and decodes the quoted goose title', () => {
    const d = parseDetail(GOOSE)
    assert.equal(d.title, 'Goose Bumps- 7" Desk Goose Workshop')
    assert.equal(d.price, 55)
    assert.equal(d.city, 'Copley')
    assert.match(d.description, /Brooms/)
    assert.match(d.description, /Beaks/)
  })
})

describe('buildRow', () => {
  const cards = parseStackHtml(STACK)
  const cardFor = (re, i = 0) => cards.filter((c) => re.test(c.title))[i]

  it('builds a Sold-Out goose row: correct UTC start, $55, sold-out tag, source_id carries the date', () => {
    const goose = cardFor(/Goose Bumps/) // Sun Sep 13, 4:00 PM, Sold Out
    const { row, venueSpec } = buildRow(goose, parseDetail(GOOSE), TODAY)
    // 4:00 PM EDT (UTC-4) → 20:00Z
    assert.equal(row.start_at, '2026-09-13T20:00:00.000Z')
    assert.equal(row.end_at, '2026-09-13T22:00:00.000Z')
    assert.equal(row.category, 'visual-art')
    assert.equal(row.price_min, 55)
    assert.equal(row.source, 'all_fired_up')
    assert.equal(row.source_id, 'D8cgh7vB-2026-09-13')
    assert.equal(row.status, 'published')
    assert.equal(row.featured, false)
    assert.equal(row.age_restriction, 'not_specified')
    assert.ok(row.tags.includes('sold-out'))
    assert.equal(venueSpec.city, 'Copley')
    assert.equal(venueSpec.zip, '44321')
  })

  it('builds an available cows row (evening → 22:00Z, $12, no sold-out tag)', () => {
    const cows = cardFor(/Mini-Cows/) // Mon Sep 14, 6:00 PM, Space Available
    const { row } = buildRow(cows, parseDetail(COWS), TODAY)
    assert.equal(row.start_at, '2026-09-14T22:00:00.000Z')
    assert.equal(row.price_min, 12)
    assert.equal(row.source_id, 't6F7mZwq-2026-09-14')
    assert.equal(row.tags.includes('sold-out'), false)
  })

  it('trims a trailing "." from a title and publishes even without a detail page', () => {
    const harvest = cardFor(/Harvest Gems/)
    const { row, venueSpec } = buildRow(harvest, null, TODAY)
    assert.equal(row.title, 'Harvest Gems: Corn Pumpkins')
    assert.equal(row.price_min, null)   // no detail → no price
    assert.equal(venueSpec.city, 'Copley')  // falls back to the fixed studio venue
  })

  it('drops non-event products by title', () => {
    assert.equal(buildRow({ title: 'At-Home Kit', token: 'x', dataId: '2026091320001358330' }, null, TODAY).skip, 'nonevent')
  })

  it('drops an out-of-county detail address via the Summit gate', () => {
    const cows = cardFor(/Mini-Cows/)
    const offsite = { ...parseDetail(COWS), city: 'Kent', addressLine: '123 Main St', zip: '44240' }
    assert.equal(buildRow(cows, offsite, TODAY).skip, 'out')
  })
})

describe('mapTags', () => {
  it('adds medium tags from the title', () => {
    assert.ok(mapTags('Stained Glass Class: Snake Grass Planter').includes('glass'))
    assert.ok(mapTags('Clay Pumpkin- Hand Building with Clay Workshop!').includes('clay'))
  })
  it('always carries the source + place tags', () => {
    const t = mapTags('Anything')
    for (const base of ['all-fired-up', 'pottery', 'copley', 'summit-county']) assert.ok(t.includes(base))
  })
})
