/**
 * test-the-grove.js — pure parsers for the The Grove wellness-studio scraper.
 *
 * Fixtures mirror the live GoDaddy "Calendar" widget markup (thegrove.info),
 * including the large-screen + small-screen dual rendering that repeats every
 * card, the time cell rendered as multiple <h4>s for a range, and a
 * "Coming Soon!" placeholder card.
 *
 * Run:  node --test scripts/tests/test-the-grove.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  dayNameToWeekday, to24h, parseTimeRange, slugify, parseClassCards, getMeta, CLASS_PAGES,
} = await import('../scrape-the-grove.js')

// ── Fixtures ────────────────────────────────────────────────────────────────

/** One GoDaddy calendar card. `desc` empty mimics the large-screen copy. */
function card(day, title, timeHtml, desc) {
  return `
  <div data-ux="Block" data-aid="CALENDAR_EVENT_DATE" class="x-el x-el-div">
    <h3 role="heading" data-ux="DisplayHeading">${day}</h3>
  </div>
  <h4 data-ux="HeadingMinor" data-aid="CALENDAR_EVENT_TITLE" data-typography="HeadingDelta">${title}</h4>
  <div data-ux="Block" data-aid="CALENDAR_EVENT_TIME" class="x-el x-el-div">${timeHtml}</div>
  <p data-ux="Text" data-typography="BodyAlpha"></p>
  <div data-ux="Block" data-aid="CALENDAR_DESC" class="x-el x-el-div">
    <div data-ux="Text" data-aid="CALENDAR_DESC_TEXT" data-typography="BodyAlpha" class="x-el x-rt">${desc}</div>
    <span role="button" data-ux="MoreLinkExpand" data-aid="CALENDAR_DESC_EXPAND">more</span>
  </div>`
}

const H4 = (t) => `<h4 role="heading" data-ux="HeadingMinor">${t}</h4>`
const single = (t) => `<div data-ux="Block">${H4(t)}</div>`
const range = (a, b) => `<div data-ux="Block">${H4(a)}${H4(' - ')}${H4(b)}</div>`

// A page renders every card twice: large-screen (empty desc) then small-screen
// (filled desc). Interleave them like the live widget does.
const SPIN_PAGE = [
  card('Tuesdays',  'Spin with Hayley', single('5:30pm'), ''),
  card('Tuesdays',  'Spin with Hayley', single('5:30pm'), 'Warm-up, climbs, sprints and intervals, and a recovery stretch.'),
  card('Thursdays', 'Spin with Hayley', single('5:30pm'), ''),
  card('Thursdays', 'Spin with Hayley', single('5:30pm'), 'Warm-up, climbs, sprints and intervals, and a recovery stretch.'),
  card('Saturdays', 'Spin with Hayley', single('8:30am'), ''),
  card('Saturdays', 'Spin with Hayley', single('8:30am'), 'Warm-up, climbs, sprints and intervals, and a recovery stretch.'),
].join('\n')

const YOGA_PAGE = [
  card('Sundays',    'Coming Soon!  Abs with Gina', single('9am'), ''),
  card('Sundays',    'Coming Soon!  Abs with Gina', single('9am'), "Join 'Abs with Gina' for a focused core workout."),
  card(' Mondays',   'Yoga with Lisa', range('7 am', '8am'), ''),
  card(' Mondays',   'Yoga with Lisa', range('7 am', '8am'), '&nbsp;&nbsp;Vinyasa Flow-&nbsp;Suitable for All levels.'),
  card('Monday',     'Yoga with Lisa', range('8:30am', '9:30am'), ''),
  card('Monday',     'Yoga with Lisa', range('8:30am', '9:30am'), 'Gentle Yoga- Suitable for beginners.'),
  card('Wednesdays', 'Yoga for Stength', single('5pm'), ''),
  card('Wednesdays', 'Yoga for Stength', single('5pm'), 'Strength with Gina is a dynamic yoga class.'),
].join('\n')

// ── dayNameToWeekday ─────────────────────────────────────────────────────────

describe('dayNameToWeekday', () => {
  it('maps plural and singular day names', () => {
    assert.deepEqual(dayNameToWeekday('Tuesdays'), { index: 2, name: 'tuesday' })
    assert.deepEqual(dayNameToWeekday(' Monday '), { index: 1, name: 'monday' })
    assert.deepEqual(dayNameToWeekday('Saturdays'), { index: 6, name: 'saturday' })
  })
  it('returns null for non-days', () => {
    assert.equal(dayNameToWeekday('Someday'), null)
    assert.equal(dayNameToWeekday(''), null)
  })
})

// ── to24h ────────────────────────────────────────────────────────────────────

describe('to24h', () => {
  it('applies am/pm and noon/midnight edges', () => {
    assert.equal(to24h('5', '30', 'pm'), '17:30')
    assert.equal(to24h('8', '30', 'am'), '08:30')
    assert.equal(to24h('9', null, 'am'), '09:00')
    assert.equal(to24h('12', '00', 'pm'), '12:00')
    assert.equal(to24h('12', '00', 'am'), '00:00')
  })
})

// ── parseTimeRange ───────────────────────────────────────────────────────────

describe('parseTimeRange', () => {
  it('parses a single time (no end)', () => {
    assert.deepEqual(parseTimeRange('5:30pm'), { start: '17:30', end: null })
    assert.deepEqual(parseTimeRange('9am'), { start: '09:00', end: null })
  })
  it('parses ranges with explicit meridiem on both ends', () => {
    assert.deepEqual(parseTimeRange('7 am - 8am'), { start: '07:00', end: '08:00' })
    assert.deepEqual(parseTimeRange('8:30am - 9:30am'), { start: '08:30', end: '09:30' })
    assert.deepEqual(parseTimeRange('7pm - 8pm'), { start: '19:00', end: '20:00' })
  })
  it('inherits a missing meridiem across the range', () => {
    assert.deepEqual(parseTimeRange('7 - 8pm'), { start: '19:00', end: '20:00' })
    assert.deepEqual(parseTimeRange('7am - 8'), { start: '07:00', end: '08:00' })
  })
  it('returns null when there is no time', () => {
    assert.equal(parseTimeRange('TBD'), null)
    assert.equal(parseTimeRange(''), null)
  })
})

// ── slugify ──────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    assert.equal(slugify('Spin with Hayley'), 'spin-with-hayley')
    assert.equal(slugify('Yoga for Stength'), 'yoga-for-stength')
  })
})

// ── parseClassCards ──────────────────────────────────────────────────────────

describe('parseClassCards', () => {
  const spin = parseClassCards(SPIN_PAGE, 'spin')
  const yoga = parseClassCards(YOGA_PAGE, 'yoga')

  it('dedupes the dual-rendered cards down to one per slot', () => {
    assert.equal(spin.length, 3) // Tue, Thu, Sat — not 6
  })

  it('keeps the copy that carries a description', () => {
    assert.ok(spin.every((c) => c.description.length > 0))
    assert.ok(spin[0].description.startsWith('Warm-up'))
  })

  it('maps weekday, times and range end correctly', () => {
    const tue = spin.find((c) => c.weekdayName === 'tuesday')
    assert.equal(tue.weekday, 2)
    assert.equal(tue.start, '17:30')
    assert.equal(tue.end, null)

    const monEarly = yoga.find((c) => c.start === '07:00')
    assert.equal(monEarly.weekday, 1)
    assert.equal(monEarly.end, '08:00')
  })

  it('skips "Coming Soon!" placeholder cards', () => {
    assert.ok(!yoga.some((c) => /coming soon/i.test(c.title)))
    // Mon 7am, Mon 8:30am, Wed 5pm survive; the Sunday placeholder does not.
    assert.equal(yoga.length, 3)
  })

  it('skips a cancelled/postponed class by title marker', () => {
    const page = [
      card('Fridays', 'Spin with Hayley - CANCELLED', single('6am'), 'x'),
      card('Fridays', 'Spin with Hayley - CANCELLED', single('6am'), 'x'),
    ].join('\n')
    assert.equal(parseClassCards(page, 'spin').length, 0)
  })

  it('distinguishes same-title classes by day + start in the program slug', () => {
    const slugs = yoga.map((c) => c.programSlug)
    assert.equal(new Set(slugs).size, slugs.length)
    assert.ok(slugs.includes('yoga-monday-yoga-with-lisa-0700'))
    assert.ok(slugs.includes('yoga-monday-yoga-with-lisa-0830'))
  })

  it('decodes entities and trims whitespace in descriptions', () => {
    const monEarly = yoga.find((c) => c.start === '07:00')
    assert.ok(monEarly.description.startsWith('Vinyasa Flow'))
  })

  it('sorts by weekday then start time', () => {
    const days = spin.map((c) => c.weekday)
    assert.deepEqual(days, [...days].sort((a, b) => a - b))
  })
})

// ── getMeta + config ─────────────────────────────────────────────────────────

describe('getMeta + CLASS_PAGES', () => {
  it('reads og:image', () => {
    const html = '<meta property="og:image" content="https://img1.wsimg.com/x/GroveRoom1.jpg" />'
    assert.equal(getMeta(html, 'og:image'), 'https://img1.wsimg.com/x/GroveRoom1.jpg')
  })
  it('exposes both class pages', () => {
    assert.deepEqual(CLASS_PAGES.map((p) => p.key).sort(), ['spin', 'yoga'])
  })
})
