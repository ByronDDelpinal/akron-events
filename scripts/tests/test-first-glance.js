/**
 * test-first-glance.js — pure parsers + Eastern-anchored weekly recurrence for
 * the First Glance Student Center scraper.
 *
 * Run:  node --test scripts/tests/test-first-glance.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  getMeta, parseProgramUrls, to24h, parseScheduleLine, parseProgramPage,
  easternTodayYmd, addDaysYmd, weekdayOfYmd, generateOccurrences,
} = await import('../scrape-first-glance.js')

// ── Fixtures ──────────────────────────────────────────────────────────────
const PROGRAM_PAGE = `<!doctype html><html><head>
<meta property="og:title" content="Rec Night - First Glance Student Center" />
<meta property="og:description" content="Provides students with a safe and fun environment to participate in sports and activities with friends and volunteers." />
<meta property="og:image" content="https://firstglance.org/wp-content/uploads/2022/05/RecNight.webp" />
</head><body>
<h1>Rec Night</h1>
<p>Thursdays 7:00-9:00pm</p>
<p>Provides students with a safe and fun environment...</p>
</body></html>`

const PROGRAM_PAGE_NO_SCHEDULE = `<!doctype html><html><head>
<meta property="og:title" content="Student Leaders - First Glance Student Center" />
<meta property="og:description" content="A leadership development track for students." />
</head><body><h1>Student Leaders</h1><p>Apply to join our student leadership team.</p></body></html>`

const INDEX = `<html><body>
<a href="https://firstglance.org/program/rec-night/">Rec Night</a>
<a href="https://firstglance.org/program/the-connect/">The Connect</a>
<a href="https://firstglance.org/program/rec-night/">Rec Night again</a>
<a href="https://firstglance.org/get-involved/">Not a program</a>
</body></html>`

describe('getMeta + parseProgramUrls', () => {
  it('reads og meta tags', () => {
    assert.equal(getMeta(PROGRAM_PAGE, 'og:image'), 'https://firstglance.org/wp-content/uploads/2022/05/RecNight.webp')
  })
  it('collects distinct /program/ urls and ignores other links', () => {
    const urls = parseProgramUrls(INDEX)
    assert.deepEqual(urls.sort(), [
      'https://firstglance.org/program/rec-night/',
      'https://firstglance.org/program/the-connect/',
    ])
  })
})

describe('to24h', () => {
  it('applies am/pm', () => {
    assert.equal(to24h('7:00', 'pm'), '19:00:00')
    assert.equal(to24h('5:00', 'pm'), '17:00:00')
    assert.equal(to24h('12:00', 'pm'), '12:00:00')
    assert.equal(to24h('12:00', 'am'), '00:00:00')
    assert.equal(to24h('10:00', 'am'), '10:00:00')
  })
  it('defaults to PM for an after-school hour when am/pm is missing', () => {
    assert.equal(to24h('7:00', null), '19:00:00')
  })
})

describe('parseScheduleLine', () => {
  it('single day + shared pm', () => {
    assert.deepEqual(parseScheduleLine('Thursdays 7:00-9:00pm'), { days: [4], start: '19:00:00', end: '21:00:00' })
  })
  it('explicit pm on both ends', () => {
    assert.deepEqual(parseScheduleLine('Wednesdays 5:00-7:00pm'), { days: [3], start: '17:00:00', end: '19:00:00' })
  })
  it('multiple days', () => {
    assert.deepEqual(parseScheduleLine('Tuesdays & Thursdays 6:00-8:00pm').days, [2, 4])
  })
  it('null when no day or no time', () => {
    assert.equal(parseScheduleLine('Some text 7:00-9:00pm'), null)
    assert.equal(parseScheduleLine('Thursdays only'), null)
  })
})

describe('parseProgramPage', () => {
  it('extracts title/desc/image/schedule/slug', () => {
    const p = parseProgramPage(PROGRAM_PAGE, 'https://firstglance.org/program/rec-night/')
    assert.equal(p.title, 'Rec Night')
    assert.equal(p.slug, 'rec-night')
    assert.ok(p.description.startsWith('Provides students'))
    assert.ok(p.imageUrl.endsWith('RecNight.webp'))
    assert.deepEqual(p.schedule, { days: [4], start: '19:00:00', end: '21:00:00' })
  })
  it('returns schedule:null for a program with no schedule line (skipped downstream)', () => {
    const p = parseProgramPage(PROGRAM_PAGE_NO_SCHEDULE, 'https://firstglance.org/program/student-leaders/')
    assert.equal(p.title, 'Student Leaders')
    assert.equal(p.schedule, null)
  })
})

describe('Eastern recurrence', () => {
  it('addDaysYmd / weekdayOfYmd are stable across month + DST', () => {
    assert.equal(addDaysYmd('2026-06-15', 7), '2026-06-22')
    assert.equal(addDaysYmd('2026-06-29', 7), '2026-07-06')
    assert.equal(weekdayOfYmd('2026-06-18'), 4) // a Thursday
    assert.equal(weekdayOfYmd('2026-06-15'), 1) // a Monday
  })

  it('generates one occurrence per scheduled weekday per week from today', () => {
    // today = Mon 2026-06-15; Thursdays → 6/18, 6/25, 7/2
    const occ = generateOccurrences({ days: [4], start: '19:00:00', end: '21:00:00' }, 3, '2026-06-15')
    assert.deepEqual(occ.map((o) => o.dateYmd), ['2026-06-18', '2026-06-25', '2026-07-02'])
    assert.ok(occ.every((o) => o.start === '19:00:00' && o.end === '21:00:00'))
  })

  it('includes today when today is the scheduled day', () => {
    // today = Thu 2026-06-18, Thursdays → first occurrence is today
    const occ = generateOccurrences({ days: [4], start: '19:00:00' }, 2, '2026-06-18')
    assert.equal(occ[0].dateYmd, '2026-06-18')
  })

  it('returns [] for an empty schedule', () => {
    assert.deepEqual(generateOccurrences(null), [])
    assert.deepEqual(generateOccurrences({ days: [] }), [])
  })

  it('easternTodayYmd returns a YYYY-MM-DD string', () => {
    assert.match(easternTodayYmd(new Date('2026-06-15T12:00:00Z')), /^\d{4}-\d{2}-\d{2}$/)
  })
})
