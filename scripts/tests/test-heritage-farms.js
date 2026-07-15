/**
 * test-heritage-farms.js — pure parsers for the Heritage Farms scraper.
 *
 * Fixtures are the REAL schedule lines captured from the live detail pages
 * (heritagefarms.com/{peninsula-flea,pumpkin-pandemonium,christmas-trees}) on
 * 2026-07-15, reduced to the content lines that matter (htmlToLines output —
 * one logical line per element boundary). The tests exercise the weekday-anchored
 * year derivation that lets a twice-daily scrape follow the farm across seasons
 * without ever assuming "this year".
 *
 * Run:  node --test scripts/tests/test-heritage-farms.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  htmlToLines, parseTimeRange, resolveSeasonYear, datesInRangeOnWeekdays,
  parseFleaEvents, parsePumpkinEvents, parseChristmasEvents, SOURCE_KEY,
} = await import('../scrape-heritage-farms.js')

// Fixed "now": mid-July 2026 (matches the build date). Eastern-safe UTC noon.
const NOW = new Date('2026-07-15T16:00:00Z')

// Real captured content lines (trimmed to what the parsers read).
const FLEA_LINES = [
  'Follow the Peninsula Flea on Facebook and Instagram!',
  "Join us for our upscale flea market on the grounds surrounding the Farm's century home.",
  'Dates: June 6, June 27, July 25 & August 8',
  'Hours:',
  '10:00 a.m. - 4:00 p.m.',
  'June 6',
  'Noon - 2:30pm',
  'June 27',
  'July 25',
  '2026 is the our 11th year hosting the Peninsula Flea on the grounds of Heritage Farms.',
  'July 25, 2026 Christmas in July at Heritage Farms',
]

const PUMPKIN_LINES = [
  'Mark Your Calendar to Join Us for Our Fall Festival of Fun & Varieties of Pumpkins!',
  'September 27th thru October 26th',
  'Saturday & Sunday',
  '10:00 am to 5:00 pm',
  'All Activities Open, All Pumpkin and Product Sales Available',
  'Monday Thru Friday',
  '2:00 pm to 6:00 pm',
  'WEEKEND Entertainment & Food Vendors',
  'September 27th, 28th: Kate\'s Cart',
  'Weekend Musicians 2024 12:00 Noon to 2:00pm:',
  'September 27 – October 25, 2025:',
]

const XMAS_LINES = [
  'We are Open November 22nd thru 26th,',
  'We are Closed Thanksgiving Day,',
  'November 27th',
  'and will be open again on Friday November 28th.',
  'Friday, Saturday & Sunday:',
  '9:00 am to 7:00 pm',
  'Monday thru Thursday:',
  '12:00 pm to 7:00 pm',
  'Our Cut Your Own Fields Close at 5:00 pm (Sunset)',
]

describe('htmlToLines', () => {
  it('splits on element boundaries and decodes entities', () => {
    assert.deepEqual(
      htmlToLines('<div>Dates: June 6 &amp; August 8</div><span>10:00 a.m.</span>'),
      ['Dates: June 6 & August 8', '10:00 a.m.'],
    )
  })
  it('drops script/style bodies', () => {
    assert.deepEqual(htmlToLines('<style>.a{}</style><div>Real</div>'), ['Real'])
  })
})

describe('parseTimeRange', () => {
  it('parses "a.m. - p.m." dotted form', () => {
    assert.deepEqual(parseTimeRange('10:00 a.m. - 4:00 p.m.'), { start: '10:00 am', end: '4:00 pm' })
  })
  it('parses "am to pm" form', () => {
    assert.deepEqual(parseTimeRange('10:00 am to 5:00 pm'), { start: '10:00 am', end: '5:00 pm' })
  })
  it('returns null when there is no am/pm range', () => {
    assert.equal(parseTimeRange('Noon - 2:30pm'), null)
    assert.equal(parseTimeRange('Saturday & Sunday'), null)
  })
})

describe('resolveSeasonYear (weekday-anchored)', () => {
  it('picks the year a June-6 flea date is a Saturday (2026)', () => {
    assert.equal(resolveSeasonYear(6, 6, 6, NOW), 2026)
  })
  it('picks the year Sept-27 is a Saturday (2025, stale/past)', () => {
    assert.equal(resolveSeasonYear(9, 27, 6, NOW), 2025)
  })
  it('picks the year Nov-27 Thanksgiving is a Thursday (2025)', () => {
    assert.equal(resolveSeasonYear(11, 27, 4, NOW), 2025)
  })
  it('returns null when no nearby year matches the weekday', () => {
    // July 4 is Fri/Sat/Sun/Tue across 2025–2028 — never a Monday.
    assert.equal(resolveSeasonYear(7, 4, 1, NOW), null)
  })
  it('is never ambiguous: at most one year in the ±window matches a fixed date', () => {
    // A fixed calendar date advances its weekday by 1 (or 2 across a leap day)
    // per year, so within the 4-year search window no two years can share a
    // weekday. Prove it for every month/day the parsers might see, incl. leap
    // interplay, so the derivation can never silently pick the wrong year.
    const weekdayOf = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
    for (const [mo, d] of [[6, 6], [9, 27], [11, 27], [2, 28], [3, 1], [12, 31]]) {
      for (const dow of [0, 1, 2, 3, 4, 5, 6]) {
        const y = resolveSeasonYear(mo, d, dow, NOW)
        if (y !== null) {
          // The returned year truly falls on that weekday…
          assert.equal(weekdayOf(y, mo, d), dow, `${mo}/${d} dow ${dow}`)
          // …and it is the ONLY such year in the [thisYear-1, thisYear+2] window.
          const hits = [2025, 2026, 2027, 2028].filter((yy) => weekdayOf(yy, mo, d) === dow)
          assert.equal(hits.length, 1, `ambiguous ${mo}/${d} dow ${dow}: ${hits}`)
        }
      }
    }
  })
  it('returns null when the stated weekday matches no year in the window', () => {
    // Sept 27 lands Sat/Sun/Mon/Wed across 2025–2028 — never a Thursday, so a
    // "Thursday, Sept 27" claim yields null instead of a fabricated season.
    assert.equal(resolveSeasonYear(9, 27, 4 /* Thu */, NOW), null)
    // NOTE (residual risk, defended downstream): a *wrong* weekday that happens
    // to match a different in-window year WILL resolve to that bogus year
    // (e.g. "Wednesday, Sept 27" → 2028). main()'s MAX_DAYS_AHEAD=400 horizon
    // guard drops such far-future misfires before they can be published.
    assert.equal(resolveSeasonYear(9, 27, 3 /* Wed */, NOW), 2028)
  })
})

describe('datesInRangeOnWeekdays', () => {
  it('lists Sat/Sun between two dates inclusive', () => {
    const d = datesInRangeOnWeekdays('2025-09-27', '2025-10-26', [6, 0])
    assert.equal(d.length, 10)
    assert.equal(d[0], '2025-09-27')
    assert.equal(d[d.length - 1], '2025-10-26')
  })
})

describe('parseFleaEvents', () => {
  const events = parseFleaEvents(FLEA_LINES, NOW)
  it('emits one event per listed Saturday, dated to the derived year (2026)', () => {
    assert.deepEqual(events.map((e) => e.ymd),
      ['2026-06-06', '2026-06-27', '2026-07-25', '2026-08-08'])
  })
  it('applies the 10am–4pm hours (EDT → UTC)', () => {
    assert.equal(events[0].startIso, '2026-06-06T14:00:00.000Z')
    assert.equal(events[0].endIso, '2026-06-06T20:00:00.000Z')
  })
  it('themes the July 25 market as "Christmas in July"', () => {
    const july = events.find((e) => e.ymd === '2026-07-25')
    assert.equal(july.title, 'Peninsula Flea at the Farm: Christmas in July')
    assert.match(july.description, /Christmas in July/)
  })
  it('keeps a plain title for the other dates', () => {
    assert.equal(events[0].title, 'Peninsula Flea at the Farm')
  })
  it('keys stable per-date source_ids', () => {
    assert.equal(events[0].sourceId, 'peninsula-flea-2026-06-06')
    assert.equal(new Set(events.map((e) => e.sourceId)).size, 4)
  })
  it('leaves the family facet to inference (a shopping market)', () => {
    assert.equal(events[0].isFamily, undefined)
  })
  it('returns [] when no Dates: line is present', () => {
    assert.deepEqual(parseFleaEvents(['Follow us on Facebook'], NOW), [])
  })
  it('does not silently publish a midnight when the hours line is missing', () => {
    // Simulate a markup change that drops the "10:00 a.m. - 4:00 p.m." line:
    // the parser must fall back to a date-only start AND flag it for review,
    // never emit an unflagged 00:00 event.
    const noHours = parseFleaEvents(
      ['Dates: June 6, June 27, July 25 & August 8', 'June 6', 'Noon - 2:30pm'], NOW,
    )
    assert.equal(noHours.length, 4)
    assert.equal(noHours[0].endIso, null)
    assert.equal(noHours[0].startIso, '2026-06-06T04:00:00.000Z') // midnight ET
    assert.equal(noHours[0].needsReview, true)
  })
  it('leaves needsReview falsy when real hours are present', () => {
    assert.ok(!parseFleaEvents(FLEA_LINES, NOW)[0].needsReview)
  })
})

describe('parsePumpkinEvents', () => {
  const events = parsePumpkinEvents(PUMPKIN_LINES, NOW)
  it('generates a Sat/Sun occurrence across the derived (stale 2025) range', () => {
    assert.equal(events.length, 10)
    assert.equal(events[0].ymd, '2025-09-27')
    assert.equal(events[events.length - 1].ymd, '2025-10-26')
  })
  it('applies weekend hours 10am–5pm, not the weekday 2–6pm block', () => {
    // 10am EDT Sep 27 2025 = 14:00 UTC
    assert.equal(events[0].startIso, '2025-09-27T14:00:00.000Z')
    assert.equal(events[0].endIso, '2025-09-27T21:00:00.000Z')
  })
  it('flags the family facet and keys per-date source_ids', () => {
    assert.equal(events[0].isFamily, true)
    assert.equal(events[0].sourceId, 'pumpkin-pandemonium-2025-09-27')
  })
  it('returns [] when no date range is present', () => {
    assert.deepEqual(parsePumpkinEvents(['Fall Festival of Fun'], NOW), [])
  })
})

describe('parseChristmasEvents', () => {
  const events = parseChristmasEvents(XMAS_LINES, NOW)
  it('emits a single season-opening event anchored on Thanksgiving (2025)', () => {
    assert.equal(events.length, 1)
    assert.equal(events[0].ymd, '2025-11-22')
    assert.equal(events[0].sourceId, 'christmas-trees-2025')
  })
  it('opens at 9am (EST → UTC) with a family facet', () => {
    assert.equal(events[0].startIso, '2025-11-22T14:00:00.000Z')
    assert.equal(events[0].isFamily, true)
  })
  it('returns [] when no opening line is present', () => {
    assert.deepEqual(parseChristmasEvents(['Fresh cut and choose your own trees'], NOW), [])
  })
})

describe('module contract', () => {
  it('exports the source key', () => {
    assert.equal(SOURCE_KEY, 'heritage_farms')
  })
})
