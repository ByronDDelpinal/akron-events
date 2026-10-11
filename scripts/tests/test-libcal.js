/**
 * test-libcal.js: the shared LibCal (Springshare) module, scripts/lib/libcal.js.
 *
 * Covers the list URL, pagination (through a stub fetchImpl: no test here
 * touches the network) and the pure shape helpers: canceled-title detection,
 * times, price, image and description.
 *
 * Fixture: scripts/tests/fixtures/barberton-library-list.json is real rows
 * from the Barberton Public Library feed. See the header of
 * test-barberton-library.js for how it was selected and the two privacy edits
 * applied to it.
 *
 * Run:  node --test scripts/tests/test-libcal.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

// Belt and braces: every fetch below goes through an injected fetchImpl, so a
// call that reaches the real one is a test bug and should fail loudly.
globalThis.fetch = async () => { throw new Error('unit test attempted real network access') }

const {
  LIBCAL_PER_PAGE, LIBCAL_MAX_PAGES,
  buildLibCalListUrl, fetchLibCalPage, fetchLibCalEvents,
  libCalNames, isLibCalCanceledTitle, libCalTimes,
  parseLibCalPrice, libCalImageUrl, libCalDescription,
} = await import('../lib/libcal.js')
// The real shared constants, not copies: the digest subtracts this exact string.
const { TIME_NOTE, MAX_DESCRIPTION } = await import('../lib/inferred-time.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/barberton-library-list.json'), 'utf8'))
const byId = (id) => {
  const row = fixture.results.find((r) => r.id === id)
  assert.ok(row, `fixture row ${id} missing`)
  return row
}

const ORIGIN = 'https://events.barbertonlibrary.org'
const CID = 14558
const noSleep = async () => {}

/** Minimal Response-like stub. */
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body } }
}

/**
 * A stub fetchImpl serving `pages` (arrays of rows) by the URL's page= value,
 * in the real envelope shape. A page past the end answers the way LibCal does:
 * HTTP 200 with an empty results array. Records every call.
 */
function pagedFetch(pages, { total, perpage }) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    const page = Number(new URL(url).searchParams.get('page'))
    calls.push({ url: String(url), page, headers: opts.headers })
    return jsonResponse({ total_results: total, perpage, status: 1, results: pages[page - 1] ?? [] })
  }
  return { fetchImpl, calls }
}

// The 20 fixture rows as three pages of 8 / 8 / 4.
const PAGES = [fixture.results.slice(0, 8), fixture.results.slice(8, 16), fixture.results.slice(16)]

describe('fixture', () => {
  it('is the real envelope with the selected rows', () => {
    assert.deepEqual(Object.keys(fixture), ['total_results', 'perpage', 'status', 'results'])
    assert.equal(fixture.perpage, 100)
    assert.equal(fixture.results.length, 20)
    assert.equal(new Set(fixture.results.map((r) => r.id)).size, 20)
  })
})

describe('buildLibCalListUrl', () => {
  it('builds the exact widget URL', () => {
    assert.equal(
      buildLibCalListUrl({ origin: ORIGIN, calendarId: CID }),
      'https://events.barbertonlibrary.org/ajax/calendar/list?c=14558&date=0000-00-00&perpage=100&page=1&audience=&cats=&camps=&inc=0',
    )
    assert.equal(
      buildLibCalListUrl({ origin: ORIGIN, calendarId: CID, page: 3, perPage: 50 }),
      'https://events.barbertonlibrary.org/ajax/calendar/list?c=14558&date=0000-00-00&perpage=50&page=3&audience=&cats=&camps=&inc=0',
    )
  })
  it('tolerates a trailing slash on the origin', () => {
    assert.equal(
      buildLibCalListUrl({ origin: `${ORIGIN}/`, calendarId: CID }),
      buildLibCalListUrl({ origin: ORIGIN, calendarId: CID }),
    )
  })
  it('exposes the paging bounds', () => {
    assert.equal(LIBCAL_PER_PAGE, 100)
    assert.equal(LIBCAL_MAX_PAGES, 8)
  })
})

describe('fetchLibCalPage', () => {
  it('sends the widget headers and a self-identifying User-Agent', async () => {
    const { fetchImpl, calls } = pagedFetch(PAGES, { total: 20, perpage: 8 })
    const data = await fetchLibCalPage({ origin: ORIGIN, calendarId: CID, page: 2, fetchImpl })
    assert.equal(data.results.length, 8)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, buildLibCalListUrl({ origin: ORIGIN, calendarId: CID, page: 2 }))
    assert.equal(calls[0].headers.Accept, 'application/json')
    assert.equal(calls[0].headers['X-Requested-With'], 'XMLHttpRequest')
    assert.match(calls[0].headers['User-Agent'], /AkronPulse-bot/)
  })
  it('throws on a non-OK response', async () => {
    const fetchImpl = async () => jsonResponse({}, 404)
    await assert.rejects(
      () => fetchLibCalPage({ origin: ORIGIN, calendarId: CID, fetchImpl }),
      /HTTP 404 fetching LibCal list page 1/,
    )
  })
  it('retries a transient failure twice, then throws', async () => {
    let attempts = 0
    const fetchImpl = async () => { attempts++; return jsonResponse({}, 503) }
    await assert.rejects(
      () => fetchLibCalPage({ origin: ORIGIN, calendarId: CID, page: 4, fetchImpl, sleep: noSleep }),
      /HTTP 503 fetching LibCal list page 4/,
    )
    assert.equal(attempts, 3)
  })
  it('recovers when a retry succeeds', async () => {
    let attempts = 0
    const fetchImpl = async () => {
      attempts++
      return attempts === 1 ? jsonResponse({}, 503) : jsonResponse({ total_results: 1, perpage: 100, status: 1, results: [byId(16909118)] })
    }
    const data = await fetchLibCalPage({ origin: ORIGIN, calendarId: CID, fetchImpl, sleep: noSleep })
    assert.equal(data.results[0].id, 16909118)
    assert.equal(attempts, 2)
  })
  it('throws when the body has no results array (a broken feed is not an empty one)', async () => {
    await assert.rejects(
      () => fetchLibCalPage({ origin: ORIGIN, calendarId: CID, fetchImpl: async () => jsonResponse({ status: 0 }) }),
      /missing its results array/,
    )
    await assert.rejects(
      () => fetchLibCalPage({ origin: ORIGIN, calendarId: CID, fetchImpl: async () => jsonResponse(null) }),
      /missing its results array/,
    )
  })
  it('requires an origin and a calendar id', async () => {
    const fetchImpl = async () => jsonResponse({ results: [] })
    await assert.rejects(() => fetchLibCalPage({ calendarId: CID, fetchImpl }), /origin is required/)
    await assert.rejects(() => fetchLibCalPage({ origin: ORIGIN, fetchImpl }), /calendarId is required/)
  })
})

describe('fetchLibCalEvents (pagination)', () => {
  it('reads every page total_results / perpage calls for', async () => {
    const { fetchImpl, calls } = pagedFetch(PAGES, { total: 20, perpage: 8 })
    const { events, total, truncated } = await fetchLibCalEvents({ origin: ORIGIN, calendarId: CID, fetchImpl })
    assert.deepEqual(calls.map((c) => c.page), [1, 2, 3])
    assert.equal(events.length, 20)
    assert.deepEqual(events.map((e) => e.id), fixture.results.map((r) => r.id))
    assert.equal(total, 20)
    assert.equal(truncated, false)
  })
  it('makes one request when everything fits on page 1', async () => {
    const { fetchImpl, calls } = pagedFetch([fixture.results], { total: 20, perpage: 100 })
    const { events, truncated } = await fetchLibCalEvents({ origin: ORIGIN, calendarId: CID, fetchImpl })
    assert.deepEqual(calls.map((c) => c.page), [1])
    assert.equal(events.length, 20)
    assert.equal(truncated, false)
  })
  it('stops on an empty page (the live total can overstate what is left)', async () => {
    // total says 5 pages of 8, but only 2 pages of rows exist.
    const { fetchImpl, calls } = pagedFetch(PAGES.slice(0, 2), { total: 40, perpage: 8 })
    const { events, total, truncated } = await fetchLibCalEvents({ origin: ORIGIN, calendarId: CID, fetchImpl })
    assert.deepEqual(calls.map((c) => c.page), [1, 2, 3])
    assert.equal(events.length, 16)
    assert.equal(total, 40)
    assert.equal(truncated, false)
  })
  it('caps at maxPages and reports the truncation', async () => {
    const { fetchImpl, calls } = pagedFetch(PAGES, { total: 20, perpage: 8 })
    const { events, total, truncated } = await fetchLibCalEvents({ origin: ORIGIN, calendarId: CID, maxPages: 2, fetchImpl })
    assert.deepEqual(calls.map((c) => c.page), [1, 2])
    assert.equal(events.length, 16)
    assert.equal(total, 20)
    assert.equal(truncated, true)
  })
  it('dedupes by id when a row shifts across a page boundary', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {})
    const shifted = [PAGES[0], [PAGES[0][7], ...PAGES[1]], PAGES[2]]
    const { fetchImpl } = pagedFetch(shifted, { total: 20, perpage: 8 })
    const { events } = await fetchLibCalEvents({ origin: ORIGIN, calendarId: CID, fetchImpl })
    assert.equal(events.length, 20)
    assert.equal(new Set(events.map((e) => e.id)).size, 20)
    // Same id, same start: the ordinary live-feed shift, not worth a warning.
    assert.equal(warn.mock.callCount(), 0)
  })
  it('warns when one id shows two different start times, and keeps the first', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {})
    const moved = { ...PAGES[0][7], startdt: '2030-01-01 10:00:00' }   // derived, not a real row
    const { fetchImpl } = pagedFetch([PAGES[0], [moved, ...PAGES[1]], PAGES[2]], { total: 20, perpage: 8 })
    const { events } = await fetchLibCalEvents({ origin: ORIGIN, calendarId: CID, fetchImpl })
    assert.equal(events.length, 20)
    assert.equal(events.find((e) => e.id === moved.id).startdt, PAGES[0][7].startdt)
    assert.equal(warn.mock.callCount(), 1)
    assert.match(String(warn.mock.calls[0].arguments[0]), new RegExp(`LibCal id ${moved.id} appears with two start times`))
  })
  it('propagates a failed page instead of returning a partial list', async () => {
    const fetchImpl = async (url) => {
      const page = Number(new URL(url).searchParams.get('page'))
      return page === 2
        ? jsonResponse({}, 404)
        : jsonResponse({ total_results: 20, perpage: 8, status: 1, results: PAGES[page - 1] })
    }
    await assert.rejects(() => fetchLibCalEvents({ origin: ORIGIN, calendarId: CID, fetchImpl }), /HTTP 404 fetching LibCal list page 2/)
  })
  it('returns an empty list (not an error) for a valid empty feed', async () => {
    const { fetchImpl, calls } = pagedFetch([[]], { total: 0, perpage: 100 })
    const { events, total, truncated } = await fetchLibCalEvents({ origin: ORIGIN, calendarId: CID, fetchImpl })
    assert.deepEqual(events, [])
    assert.equal(total, 0)
    assert.equal(truncated, false)
    assert.equal(calls.length, 1)
  })
})

describe('libCalNames', () => {
  it('pulls names out of the feed lists', () => {
    assert.deepEqual(libCalNames(byId(16925346).categories_arr), ['Arts & Crafts', 'Food & Cooking'])
    assert.deepEqual(libCalNames(byId(16636971).audiences), ['All Abilities', 'Adult'])
    assert.deepEqual(libCalNames(byId(16909307).categories_arr), [])
  })
  it('tolerates a missing list and malformed members', () => {
    assert.deepEqual(libCalNames(undefined), [])
    assert.deepEqual(libCalNames(null), [])
    assert.deepEqual(libCalNames('Storytime'), [])
    assert.deepEqual(libCalNames([null, {}, { name: '' }, { name: 7 }, { name: ' Storytime ' }]), ['Storytime'])
  })
})

describe('isLibCalCanceledTitle', () => {
  const cases = [
    ['CANCELED- Author Visit: Delsie Moore', true],      // fixture 16738055
    ['CANCELLED- Job & Family Services', true],          // fixture 16636588
    ['Canceled: Story Time', true],
    ['Cancelled – Chair Yoga', true],
    ['(Canceled) Job Seeker Station', true],
    ['(Cancelled) Book Club', true],
    ['[CANCELED]: The AMP', true],
    ['[Cancelled] Book Club', true],
    ['  canceled - Teen Room Takeover', true],
    ['Cancel Culture: A Discussion', false],
    ['Canceled Stamps Club', false],
    ['Story Time (canceled)', false],
    ['Wee Ones Storytime', false],
    ['', false],
  ]
  for (const [title, expected] of cases) {
    it(`${JSON.stringify(title)} → ${expected}`, () => {
      assert.equal(isLibCalCanceledTitle(title), expected)
    })
  }
  it('matches the real canceled fixture titles and tolerates non-strings', () => {
    assert.equal(isLibCalCanceledTitle(byId(16738055).title), true)
    assert.equal(isLibCalCanceledTitle(byId(16636588).title), true)
    assert.equal(isLibCalCanceledTitle(null), false)
    assert.equal(isLibCalCanceledTitle(undefined), false)
  })
})

describe('libCalTimes', () => {
  it('converts a timed EDT row (10:30 ET in October = 14:30Z)', () => {
    assert.deepEqual(libCalTimes(byId(16909118)), {
      startAt: '2026-10-08T14:30:00.000Z', endAt: '2026-10-08T15:30:00.000Z', isAllDay: false,
    })
  })
  it('converts a timed EST row (11:00 ET in December = 16:00Z)', () => {
    assert.deepEqual(libCalTimes(byId(16537941)), {
      startAt: '2026-12-11T16:00:00.000Z', endAt: '2026-12-11T20:00:00.000Z', isAllDay: false,
    })
  })
  it('keeps a multi-day timed row as the feed states it', () => {
    assert.deepEqual(libCalTimes(byId(17323484)), {
      startAt: '2027-05-21T14:00:00.000Z', endAt: '2027-05-22T20:00:00.000Z', isAllDay: false,
    })
  })
  it('defaults an all-day row to noon ET and keeps a later end', () => {
    // SANCTIONED-DEFAULT-TIME: the feed sends "2026-10-19 00:00:00" with
    // all_day true. The date survives and the clock is noon ET (16:00Z in
    // EDT); the 23:59:59 end is after noon, so it stays. isAllDay is what the
    // scraper turns into row.time_inferred.
    const row = byId(17056178)
    assert.equal(row.all_day, true)
    assert.equal(row.startdt, '2026-10-19 00:00:00')
    assert.deepEqual(libCalTimes(row), {
      startAt: '2026-10-19T16:00:00.000Z', endAt: '2026-10-20T03:59:59.000Z', isAllDay: true,
    })
  })
  it('uses the EST offset for an all-day row after the clocks change (noon = 17:00Z)', () => {
    assert.equal(libCalTimes(byId(15357221)).startAt, '2026-11-26T17:00:00.000Z')
  })
  it('nulls an all-day end that the noon shift would invert', () => {
    // Derived from fixture 17056178: enddt set equal to startdt (midnight).
    const row = byId(17056178)
    const t = libCalTimes({ ...row, enddt: row.startdt })
    assert.equal(t.startAt, '2026-10-19T16:00:00.000Z')
    assert.equal(t.endAt, null)
  })
  it('never stores an all-day row at midnight ET (04:00Z / 05:00Z)', () => {
    const allDay = fixture.results.filter((r) => r.all_day === true)
    assert.ok(allDay.length >= 4, 'fixture should carry several all-day rows')
    for (const row of allDay) {
      const { startAt, isAllDay } = libCalTimes(row)
      assert.equal(isAllDay, true)
      assert.doesNotMatch(startAt, /T0[45]:00:00\.000Z$/, `${row.id} stored at midnight ET`)
      assert.match(startAt, /T1[67]:00:00\.000Z$/, `${row.id} should be noon ET`)
      assert.equal(startAt.slice(0, 10), row.startdt.slice(0, 10), `${row.id} changed calendar day`)
    }
  })
  it('keys all-day off the flag, not a 00:00 in the string', () => {
    // Derived: a timed row that genuinely starts at midnight is left alone.
    const t = libCalTimes({ startdt: '2026-12-31 00:00:00', enddt: '2026-12-31 01:00:00', all_day: false })
    assert.deepEqual(t, { startAt: '2026-12-31T05:00:00.000Z', endAt: '2026-12-31T06:00:00.000Z', isAllDay: false })
  })
  it('returns a null end when the feed has none', () => {
    const t = libCalTimes({ startdt: '2026-10-08 10:30:00', enddt: '', all_day: false })
    assert.deepEqual(t, { startAt: '2026-10-08T14:30:00.000Z', endAt: null, isAllDay: false })
  })
  it('returns null when undatable', () => {
    assert.equal(libCalTimes({ startdt: '' }), null)
    assert.equal(libCalTimes({ startdt: 'not a date', all_day: true }), null)
    assert.equal(libCalTimes({}), null)
    assert.equal(libCalTimes(null), null)
    assert.equal(libCalTimes(undefined), null)
  })
})

describe('parseLibCalPrice', () => {
  it('empty cost → free (every row in the fixture)', () => {
    assert.deepEqual(parseLibCalPrice(''), { price_min: 0, price_max: null })
    assert.deepEqual(parseLibCalPrice(), { price_min: 0, price_max: null })
    assert.deepEqual(parseLibCalPrice(null), { price_min: 0, price_max: null })
    for (const row of fixture.results) assert.deepEqual(parseLibCalPrice(row.registration_cost), { price_min: 0, price_max: null })
  })
  it('parses a populated fee or range', () => {
    assert.deepEqual(parseLibCalPrice('$5'), { price_min: 5, price_max: null })
    assert.deepEqual(parseLibCalPrice('$5 - $10'), { price_min: 5, price_max: 10 })
    assert.deepEqual(parseLibCalPrice('$7.50 materials fee'), { price_min: 7.5, price_max: null })
  })
})

describe('libCalImageUrl', () => {
  it('returns the absolute CDN URL from the feed', () => {
    assert.equal(
      libCalImageUrl(byId(16909118)),
      'https://d2jv02qf7xgjwx.cloudfront.net/customers/6650/images/Wee_Ones_Storytime.jpg',
    )
  })
  it('returns null for anything that is not an absolute http(s) URL', () => {
    assert.equal(libCalImageUrl({ featured_image: '' }), null)
    assert.equal(libCalImageUrl({ featured_image: '/images/local.jpg' }), null)
    assert.equal(libCalImageUrl({ featured_image: 'data:image/png;base64,AAAA' }), null)
    assert.equal(libCalImageUrl({ featured_image: null }), null)
    assert.equal(libCalImageUrl({}), null)
    assert.equal(libCalImageUrl(undefined), null)
  })
})

describe('libCalDescription', () => {
  it('converts the description HTML to text', () => {
    const desc = libCalDescription(byId(16909118))
    assert.ok(desc.startsWith('Enjoy stories, songs, and rhymes, followed by playtime with fun & educational toys.'))
    assert.doesNotMatch(desc, /<[a-z/]/i)
    assert.doesNotMatch(desc, /&(?:amp|nbsp|#39);/)
    // Paragraph structure survives (htmlToText, not stripHtml).
    assert.ok(desc.includes('\n\n'))
  })
  it('never includes more_info (the newsletter boilerplate) or needs shortdesc', () => {
    const row = byId(16909118)
    assert.match(row.more_info, /e-newsletter/)
    assert.doesNotMatch(libCalDescription(row), /newsletter/i)
    // Only `description` is read: a row with nothing but more_info/shortdesc has none.
    assert.equal(libCalDescription({ more_info: row.more_info, shortdesc: row.shortdesc }), null)
  })
  it('does NOT append the placeholder-time note, even for an all-day row', () => {
    // upsertEventSafe owns that disclosure, off row.time_inferred, because only
    // it knows whether a human has locked start_at. A second copy appended
    // here would disclose a time a human had already confirmed.
    const row = byId(17056178)
    assert.equal(row.all_day, true)
    const desc = libCalDescription(row)
    assert.ok(desc.length > 0)
    assert.equal(desc.includes(TIME_NOTE), false)
    // A stray second argument (the pre-centralisation call shape) changes nothing.
    assert.equal(libCalDescription(row, { isAllDay: true }), desc)
  })
  it('keeps a blank description null', () => {
    // Fixture 15357221 ("Library Closed") really has an empty description.
    assert.equal(byId(15357221).description, '')
    assert.equal(libCalDescription(byId(15357221)), null)
    assert.equal(libCalDescription({ description: '<p>&nbsp;</p>' }), null)
    assert.equal(libCalDescription({}), null)
    assert.equal(libCalDescription(undefined), null)
  })
  it('caps at MAX_DESCRIPTION', () => {
    const desc = libCalDescription({ description: `<p>${'word '.repeat(2000)}</p>` })
    assert.ok(desc.length <= MAX_DESCRIPTION)
    assert.ok(desc.length > MAX_DESCRIPTION - 10)
  })
})
