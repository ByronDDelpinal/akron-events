/**
 * test-cuyahoga-falls.js
 *
 * Unit tests for the City of Cuyahoga Falls scraper's pure parsers:
 *   • parseYearDays / filterDaysToWindow / parseDayView — the date authority.
 *     The year view (/calendar-field_cal_date/year/YYYY) indexes which days have
 *     events; the day view (/calendar-field_cal_date/day/YYYYMMDD) supplies the
 *     events for one date. The month grid they replaced is retired: it rendered
 *     EVERY event one day early, self-consistently, so nothing inside it could
 *     detect the error. There is deliberately no parseGrid test here because
 *     there is deliberately no parseGrid.
 *   • horizonWindow / yearsForWindow — the eastern-anchored ingestion window and
 *     the year-boundary case (a ~90-day horizon crosses Dec 31 each autumn).
 *   • planRetirement — which published rows a run may retire, and the five ways
 *     a run disqualifies itself from retiring anything.
 *   • parseTimeFromText — extracts the START time from prose, taking the start
 *     of a range (not the end) and inheriting the meridiem, while refusing to
 *     read a clock time out of a date ("August 4-25, 2026 - 9:00 AM").
 *
 * The HTML fixtures are verbatim captures of the live pages (2026-08-16):
 * city-of-cf-year-2026.html plus five day views, one of which has no events.
 * No test performs any network I/O.
 *
 * Run:
 *   node --test scripts/tests/test-cuyahoga-falls.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

import * as cfModule from '../scrape-city-of-cuyahoga-falls.js'
import {
  parseTimeFromText,
  parseTimeFromTextDetailed,
  buildDescription,
  TIME_NOTE,
  parseYearDays,
  filterDaysToWindow,
  parseDayView,
  occurrencesForDay,
  horizonWindow,
  yearsForWindow,
  planRetirement,
  hasStatusOverride,
  fullRetirementAllowed,
  dayViewUrl,
  yearViewUrl,
  HORIZON_DAYS,
  RETIREMENT_MIN_RESOLVED,
  RETIREMENT_MAX_FRACTION,
  RETIREMENT_OVERRIDE_ENV,
  RETIREMENT_QUERY_LIMIT,
} from '../scrape-city-of-cuyahoga-falls.js'
// The real strip helper, so the double-strip regression below runs against the
// shipped implementation rather than a stand-in.
import { stripHtml } from '../lib/normalize.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

const YEAR_2026 = fixture('city-of-cf-year-2026.html')
const DAY_0817  = fixture('city-of-cf-day-20260817.html')        // Monday  — Riverfront Cruise In
const DAY_0818  = fixture('city-of-cf-day-20260818.html')        // Tuesday — Ward 6 Meeting
const DAY_0831  = fixture('city-of-cf-day-20260831.html')        // Monday  — Riverfront Cruise In
const DAY_1008  = fixture('city-of-cf-day-20261008.html')        // three events, one entity-encoded
const DAY_EMPTY = fixture('city-of-cf-day-20260816-empty.html')  // the date the grid claimed

// Weekday of a "YYYY-MM-DD", computed at noon UTC so no timezone can shift it.
const weekdayOf = (d) =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${d}T12:00:00Z`).getUTCDay()]

describe('date authority — the month grid is gone', () => {
  it('exports no grid parser, month URL builder, or MONTHS_AHEAD', () => {
    // The grid was uniformly one day early and self-consistent about it, so no
    // amount of parsing could have salvaged it. If any of these come back, the
    // wrong-by-one-day source is back with them.
    assert.equal(cfModule.parseGrid,   undefined)
    assert.equal(cfModule.monthUrls,   undefined)
    assert.equal(cfModule.MONTHS_AHEAD, undefined)
  })

  it('day view and year view agree that nothing happens on the date the grid claimed', () => {
    // The incident in one assertion: the grid put Riverfront Cruise In on Sun
    // 2026-08-16. The year view does not list 08-16 at all, and the 08-16 day
    // view is empty; 08-17 (Monday) is where the event actually is.
    const days = parseYearDays(YEAR_2026)
    assert.ok(!days.includes('2026-08-16'), 'year view must not list the grid’s date')
    assert.deepEqual(parseDayView(DAY_EMPTY), [])
    assert.ok(parseDayView(DAY_0817).some(e => e.slug === 'riverfront-cruise'))
  })
})

describe('parseYearDays (year view → the set of days that have events)', () => {
  const days = parseYearDays(YEAR_2026)

  it('returns sorted, unique "YYYY-MM-DD" days', () => {
    assert.ok(days.length > 100, `expected a full year of event days, got ${days.length}`)
    assert.deepEqual(days, [...new Set(days)].sort())
    for (const d of days) assert.match(d, /^\d{4}-\d{2}-\d{2}$/)
  })

  it('dedupes the adjacent mini-month spillover cells', () => {
    // 2026-08-31 is rendered in both the August and the September mini-grid.
    assert.equal((YEAR_2026.match(/calendar-field_cal_date\/day\/20260831/g) || []).length, 2)
    assert.equal(days.filter(d => d === '2026-08-31').length, 1)
  })

  it('only lists days the city marked has-events', () => {
    // 2026-08-19 is a has-no-events cell: a bare day number, no link.
    assert.ok(!days.includes('2026-08-19'))
    assert.ok(days.includes('2026-08-17'))
  })

  it('returns [] for empty/garbage input instead of throwing', () => {
    assert.deepEqual(parseYearDays(''), [])
    assert.deepEqual(parseYearDays(null), [])
    assert.deepEqual(parseYearDays('<html><body>no calendar here</body></html>'), [])
  })
})

describe('filterDaysToWindow (horizon boundary)', () => {
  const days = parseYearDays(YEAR_2026)

  it('keeps exactly the event days inside the run window', () => {
    const inWindow = filterDaysToWindow(days, { start: '2026-08-16', end: '2026-10-31' })
    assert.equal(inWindow.length, 31)
    assert.equal(inWindow[0], '2026-08-17')
    assert.equal(inWindow.at(-1), '2026-10-28')
  })

  it('is inclusive at both ends', () => {
    const single = filterDaysToWindow(days, { start: '2026-08-17', end: '2026-08-17' })
    assert.deepEqual(single, ['2026-08-17'])
    // One day tighter on either side and the boundary day drops out.
    assert.ok(!filterDaysToWindow(days, { start: '2026-08-18', end: '2026-10-31' }).includes('2026-08-17'))
    assert.ok(!filterDaysToWindow(days, { start: '2026-08-16', end: '2026-10-27' }).includes('2026-10-28'))
  })

  it('drops days before the window even though the year view lists them', () => {
    const inWindow = filterDaysToWindow(days, { start: '2026-08-16', end: '2026-10-31' })
    assert.ok(days.includes('2026-06-01'), 'fixture sanity: the year view has past days')
    assert.ok(!inWindow.some(d => d < '2026-08-16'))
    assert.ok(!inWindow.some(d => d > '2026-10-31'))
  })

  it('sorts and dedupes whatever it is handed', () => {
    assert.deepEqual(
      filterDaysToWindow(['2026-08-20', '2026-08-18', '2026-08-20'], { start: '2026-08-01', end: '2026-08-31' }),
      ['2026-08-18', '2026-08-20'],
    )
  })
})

describe('parseDayView (day view → the events on ONE date)', () => {
  it('resolves Riverfront Cruise In to Mondays', () => {
    const aug17 = occurrencesForDay('2026-08-17', DAY_0817)
    const aug31 = occurrencesForDay('2026-08-31', DAY_0831)
    const cruise17 = aug17.find(e => e.slug === 'riverfront-cruise')
    const cruise31 = aug31.find(e => e.slug === 'riverfront-cruise')
    assert.ok(cruise17 && cruise31, 'riverfront-cruise missing from a Monday day view')
    assert.equal(cruise17.title, 'Riverfront Cruise In')
    assert.equal(cruise17.dateStr, '2026-08-17')
    assert.equal(cruise31.dateStr, '2026-08-31')
    assert.equal(weekdayOf(cruise17.dateStr), 'Mon')
    assert.equal(weekdayOf(cruise31.dateStr), 'Mon')
    // The third Monday in the series, 2026-08-24, is in the year-view index and
    // is also a Monday — the series never lands on a Sunday the way the grid had it.
    const days = parseYearDays(YEAR_2026)
    assert.ok(days.includes('2026-08-24'))
    assert.equal(weekdayOf('2026-08-24'), 'Mon')
    assert.ok(!days.includes('2026-08-23'), 'the Sunday before must not be an event day')
  })

  it('resolves Ward 6 Meeting to Tuesdays', () => {
    const aug18 = occurrencesForDay('2026-08-18', DAY_0818)
    const ward6 = aug18.find(e => e.slug === 'ward-6-meeting')
    assert.ok(ward6, 'ward-6-meeting missing')
    assert.equal(ward6.title, 'Ward 6 Meeting')
    assert.equal(ward6.dateStr, '2026-08-18')
    assert.equal(weekdayOf('2026-08-18'), 'Tue')
    const days = parseYearDays(YEAR_2026)
    assert.ok(days.includes('2026-08-25'), 'the next Tuesday must be an event day')
    assert.equal(weekdayOf('2026-08-25'), 'Tue')
    assert.ok(!days.includes('2026-08-16'), 'the Sunday the grid used must not be an event day')
  })

  it('returns every event on a multi-event day, with entities decoded', () => {
    const oct8 = occurrencesForDay('2026-10-08', DAY_1008)
    assert.deepEqual(oct8.map(e => e.slug).sort(),
      ['design-historic-review-board-3', 'energy-expo-0', 'parks-and-recreation-board-4'])
    const board = oct8.find(e => e.slug === 'design-historic-review-board-3')
    assert.equal(board.title, 'Design & Historic Review Board')   // &amp; decoded once
    assert.ok(oct8.every(e => e.dateStr === '2026-10-08'))
  })

  it('yields zero occurrences for a day with no events, without throwing', () => {
    assert.deepEqual(parseDayView(DAY_EMPTY), [])
    assert.deepEqual(occurrencesForDay('2026-08-16', DAY_EMPTY), [])
    assert.deepEqual(parseDayView(''), [])
    assert.deepEqual(parseDayView(null), [])
  })

  it('dedupes a slug rendered twice on the same page', () => {
    const doubled = DAY_0817 + DAY_0817
    assert.equal(parseDayView(doubled).filter(e => e.slug === 'riverfront-cruise').length, 1)
  })

  it('builds the day and year URLs the city actually serves', () => {
    assert.equal(dayViewUrl('2026-08-17'), 'https://www.cityofcf.com/calendar-field_cal_date/day/20260817')
    assert.equal(yearViewUrl(2026),        'https://www.cityofcf.com/calendar-field_cal_date/year/2026')
  })
})

describe('horizonWindow / yearsForWindow', () => {
  it('anchors both ends in Eastern time, not UTC', () => {
    // 11:30pm ET on 2026-08-16 is already 2026-08-17 in UTC. The retired
    // monthUrls() used local/UTC date parts and skipped a whole month on the
    // last night of a month for exactly this reason.
    const lateEvening = new Date('2026-08-16T23:30:00-04:00')
    const win = horizonWindow(lateEvening)
    assert.equal(win.start, '2026-08-16')
    assert.equal(lateEvening.toISOString().slice(0, 10), '2026-08-17')  // the trap
  })

  it('spans HORIZON_DAYS days', () => {
    assert.equal(HORIZON_DAYS, 90)
    const win = horizonWindow(new Date('2026-08-16T12:00:00-04:00'))
    const spanDays = (Date.parse(`${win.end}T00:00:00Z`) - Date.parse(`${win.start}T00:00:00Z`)) / 86400000
    assert.equal(spanDays, HORIZON_DAYS)
  })

  it('names one year when the window stays inside it', () => {
    assert.deepEqual(yearsForWindow(horizonWindow(new Date('2026-08-16T12:00:00-04:00'))), [2026])
  })

  it('names both years once the horizon crosses Dec 31', () => {
    // The trap that first fires ~2026-10-03: the year view covers ONE calendar
    // year, so a single fetch silently truncates the horizon at Dec 31.
    const win = horizonWindow(new Date('2026-10-03T12:00:00-04:00'))
    assert.equal(win.end.slice(0, 4), '2027')
    assert.deepEqual(yearsForWindow(win), [2026, 2027])
    // And the day before, it does not.
    assert.deepEqual(yearsForWindow(horizonWindow(new Date('2026-10-02T12:00:00-04:00'))), [2026])
  })
})

describe('planRetirement — the guards (a partial run retires NOTHING)', () => {
  // A healthy run: 20 in-window rows, 18 of them resolved this run.
  const healthyRows = (extra = []) => [
    ...Array.from({ length: 18 }, (_, i) => ({
      id: `id-${i}`, source_id: `slug-${i}-2026-08-20`, status: 'published', manual_overrides: null,
    })),
    { id: 'stale-1', source_id: 'old-slug-2026-08-16', status: 'published', manual_overrides: null },
    { id: 'stale-2', source_id: 'other-slug-2026-08-19', status: 'published', manual_overrides: null },
    ...extra,
  ]
  const resolved = new Set(Array.from({ length: 18 }, (_, i) => `slug-${i}-2026-08-20`))
  const healthy = { yearViewOk: true, dayViewFailures: 0, truncated: false }

  it('retires exactly the published in-window rows this run did not resolve', () => {
    const plan = planRetirement({ rows: healthyRows(), resolvedSourceIds: resolved, ...healthy })
    assert.equal(plan.skipped, null)
    assert.deepEqual(plan.retire.map(r => r.id).sort(), ['stale-1', 'stale-2'])
  })

  it('SKIPS everything when the year view failed', () => {
    const plan = planRetirement({ rows: healthyRows(), resolvedSourceIds: resolved, ...healthy, yearViewOk: false })
    assert.equal(plan.skipped, 'year-view-unavailable')
    assert.deepEqual(plan.retire, [])
  })

  it('SKIPS everything when even ONE day view failed', () => {
    const plan = planRetirement({ rows: healthyRows(), resolvedSourceIds: resolved, ...healthy, dayViewFailures: 1 })
    assert.equal(plan.skipped, 'day-view-failures')
    assert.deepEqual(plan.retire, [])
    assert.match(plan.reason, /1 day view/)
  })

  it('SKIPS everything when the day-view fetch cap truncated the run', () => {
    const plan = planRetirement({ rows: healthyRows(), resolvedSourceIds: resolved, ...healthy, truncated: true })
    assert.equal(plan.skipped, 'day-fetch-cap')
    assert.deepEqual(plan.retire, [])
  })

  it('SKIPS everything when the resolved count is below the floor', () => {
    const few = new Set(Array.from({ length: RETIREMENT_MIN_RESOLVED - 1 }, (_, i) => `slug-${i}-2026-08-20`))
    const plan = planRetirement({ rows: healthyRows(), resolvedSourceIds: few, ...healthy })
    assert.equal(plan.skipped, 'below-floor')
    assert.deepEqual(plan.retire, [])
  })

  // 10 in-window rows, 5 of them unresolved → 50%, over the 25% ceiling.
  const overCeilingRows = [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `keep-${i}`, source_id: `slug-${i}-2026-08-20`, status: 'published', manual_overrides: null,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `drop-${i}`, source_id: `gone-${i}-2026-08-20`, status: 'published', manual_overrides: null,
    })),
  ]

  it('SKIPS everything when the retirement set is over the ceiling and the flag is absent', () => {
    const plan = planRetirement({ rows: overCeilingRows, resolvedSourceIds: resolved, ...healthy })
    assert.equal(plan.skipped, 'above-ceiling')
    assert.deepEqual(plan.retire, [])
    assert.ok(plan.fraction > RETIREMENT_MAX_FRACTION)
    // The first run after the date fix legitimately retires ~100%; the abort has
    // to say so, or the maintainer reads it as a bug and reverts the fix.
    assert.match(plan.reason, /first run after a date-authority change/i)
    // …and it must name the remedy, so the operator does not have to read source.
    assert.match(plan.reason, new RegExp(`${RETIREMENT_OVERRIDE_ENV}=1`))
    assert.match(plan.reason, /relaxes this ceiling and nothing else/i)
  })

  it('the operator flag relaxes the ceiling, letting the first run proceed', () => {
    const plan = planRetirement({
      rows: overCeilingRows, resolvedSourceIds: resolved, ...healthy, allowFullRetirement: true,
    })
    assert.equal(plan.skipped, null)
    assert.deepEqual(plan.retire.map(r => r.id).sort(), ['drop-0', 'drop-1', 'drop-2', 'drop-3', 'drop-4'])
    // The bypass must be reported, not silent: the caller logs it loudly.
    assert.equal(plan.ceilingBypassed, true)
    assert.ok(plan.fraction > RETIREMENT_MAX_FRACTION)
  })

  it('does not flag a bypass on an ordinary under-ceiling run', () => {
    const plan = planRetirement({
      rows: healthyRows(), resolvedSourceIds: resolved, ...healthy, allowFullRetirement: true,
    })
    assert.equal(plan.skipped, null)
    assert.equal(plan.ceilingBypassed, false, 'nothing was bypassed — the run was under the ceiling anyway')
  })

  it('the operator flag does NOT relax the day-view-failure guard', () => {
    // The point of the flag is "retiring ~100% is correct tonight", not "ignore
    // safety". A run that did not see the whole calendar can never retire,
    // whatever the operator asked for.
    const plan = planRetirement({
      rows: overCeilingRows, resolvedSourceIds: resolved, ...healthy,
      dayViewFailures: 1, allowFullRetirement: true,
    })
    assert.equal(plan.skipped, 'day-view-failures')
    assert.deepEqual(plan.retire, [])
  })

  it('the operator flag does NOT relax the year-view, fetch-cap or floor guards', () => {
    const withFlag = (over) => planRetirement({
      rows: overCeilingRows, resolvedSourceIds: resolved, ...healthy, allowFullRetirement: true, ...over,
    })
    assert.equal(withFlag({ yearViewOk: false }).skipped, 'year-view-unavailable')
    assert.equal(withFlag({ truncated: true }).skipped, 'day-fetch-cap')
    assert.equal(withFlag({ resolvedSourceIds: new Set(['just-one']) }).skipped, 'below-floor')
    for (const over of [{ yearViewOk: false }, { truncated: true }, { resolvedSourceIds: new Set(['just-one']) }]) {
      assert.deepEqual(withFlag(over).retire, [])
    }
  })

  it('fullRetirementAllowed reads the env var, opt-in only', () => {
    assert.equal(RETIREMENT_OVERRIDE_ENV, 'CF_ALLOW_FULL_RETIREMENT')
    assert.equal(fullRetirementAllowed({ [RETIREMENT_OVERRIDE_ENV]: '1' }), true)
    assert.equal(fullRetirementAllowed({ [RETIREMENT_OVERRIDE_ENV]: 'true' }), true)
    assert.equal(fullRetirementAllowed({ [RETIREMENT_OVERRIDE_ENV]: 'TRUE' }), true)
    assert.equal(fullRetirementAllowed({ [RETIREMENT_OVERRIDE_ENV]: '0' }), false)
    assert.equal(fullRetirementAllowed({ [RETIREMENT_OVERRIDE_ENV]: 'no' }), false)
    assert.equal(fullRetirementAllowed({ [RETIREMENT_OVERRIDE_ENV]: '' }), false)
    assert.equal(fullRetirementAllowed({}), false)
    assert.equal(fullRetirementAllowed(), false, 'the real environment must not have it set during tests')
  })

  it('defaults to enforcing the ceiling when allowFullRetirement is not passed', () => {
    // Fail closed: an omitted flag is a present-and-false flag.
    assert.equal(planRetirement({ rows: overCeilingRows, resolvedSourceIds: resolved, ...healthy }).skipped,
      'above-ceiling')
  })

  it('the ceiling is not diluted by cancelled rows sitting in the window', () => {
    // The regression: tonight's pass leaves ~33 cancelled rows inside the 90-day
    // window for up to 90 days. Measured against ALL in-window rows those halve
    // the fraction and wave through a parse regression that unresolves half the
    // LIVE source — in exactly the months the new pipeline is least proven. The
    // denominator must be the retire-eligible subset, so the verdict on the same
    // live rows cannot depend on how much cancelled sediment sits beside them.
    const live = [
      ...Array.from({ length: 17 }, (_, i) => ({
        id: `live-keep-${i}`, source_id: `slug-${i}-2026-08-20`, status: 'published', manual_overrides: null,
      })),
      ...Array.from({ length: 16 }, (_, i) => ({
        id: `live-drop-${i}`, source_id: `vanished-${i}-2026-08-20`, status: 'published', manual_overrides: null,
      })),
    ]
    const sediment = Array.from({ length: 33 }, (_, i) => ({
      id: `retired-${i}`, source_id: `old-${i}-2026-08-16`, status: 'cancelled',
      manual_overrides: { status: { at: '2026-08-16T23:10:00Z', by: 'scrape-city-of-cuyahoga-falls:retirement' } },
    }))

    const clean   = planRetirement({ rows: live,                  resolvedSourceIds: resolved, ...healthy })
    const diluted = planRetirement({ rows: [...live, ...sediment], resolvedSourceIds: resolved, ...healthy })

    // 16 of 33 retire-eligible rows = 48%, over the ceiling — both times.
    assert.equal(clean.skipped, 'above-ceiling')
    assert.equal(diluted.skipped, 'above-ceiling', 'cancelled rows diluted the ceiling')
    assert.equal(clean.fraction, diluted.fraction, 'the fraction moved on rows that can never be retired')
    assert.ok(diluted.fraction > RETIREMENT_MAX_FRACTION)
    assert.deepEqual(clean.retire, [])
    assert.deepEqual(diluted.retire, [])
  })

  it('measures the fraction against retire-eligible rows, not every in-window row', () => {
    // The same property from the other side: status-pinned rows are equally
    // unretirable, so they must not pad the denominator either.
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `keep-${i}`, source_id: `slug-${i}-2026-08-20`, status: 'published', manual_overrides: null,
      })),
      { id: 'drop', source_id: 'vanished-2026-08-20', status: 'published', manual_overrides: null },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `pinned-${i}`, source_id: `hand-${i}-2026-08-20`, status: 'published',
        manual_overrides: { status: { by: 'byron' } },
      })),
    ]
    const plan = planRetirement({ rows, resolvedSourceIds: resolved, ...healthy })
    // 1 of 4 eligible = 25%, exactly AT the ceiling (not over) → proceeds.
    // Against all 24 in-window rows it would read as 4%, which is not what is
    // happening to the retirable source.
    assert.equal(plan.eligible, 4)
    assert.equal(plan.fraction, 0.25)
    assert.deepEqual(plan.retire.map(r => r.id), ['drop'])
  })

  it('a run with zero occurrences resolved retires nothing', () => {
    const plan = planRetirement({ rows: healthyRows(), resolvedSourceIds: new Set(), ...healthy })
    assert.equal(plan.skipped, 'below-floor')
    assert.deepEqual(plan.retire, [])
  })

  it('defaults to skipping when called with nothing at all', () => {
    // yearViewOk defaults to false: an unhealthy-by-default plan can only ever
    // fail closed.
    const plan = planRetirement()
    assert.equal(plan.skipped, 'year-view-unavailable')
    assert.deepEqual(plan.retire, [])
  })
})

describe('planRetirement — what it must never touch', () => {
  const healthy = { yearViewOk: true, dayViewFailures: 0, truncated: false }
  const resolved = new Set(Array.from({ length: 18 }, (_, i) => `slug-${i}-2026-08-20`))
  const filler = Array.from({ length: 18 }, (_, i) => ({
    id: `id-${i}`, source_id: `slug-${i}-2026-08-20`, status: 'published', manual_overrides: null,
  }))

  it('never retires a row whose manual_overrides pins status', () => {
    // _stripOverriddenFields protects the UPSERT path only. This is a separate
    // UPDATE with no protection, so missing this overwrites a row a human
    // deliberately published — exactly the incident-response work we must keep.
    const pinned = {
      id: 'human', source_id: 'hand-published-2026-08-18', status: 'published',
      manual_overrides: { status: { at: '2026-08-16T02:00:00Z', by: 'byron' } },
    }
    const plan = planRetirement({ rows: [...filler, pinned], resolvedSourceIds: resolved, ...healthy })
    assert.equal(plan.skipped, null)
    assert.ok(!plan.retire.some(r => r.id === 'human'), 'a human status pin was overwritten')
    assert.equal(plan.protectedCount, 1)
  })

  it('never re-retires a row that is already cancelled', () => {
    const already = { id: 'gone', source_id: 'cancelled-2026-08-18', status: 'cancelled', manual_overrides: null }
    const plan = planRetirement({ rows: [...filler, already], resolvedSourceIds: resolved, ...healthy })
    assert.ok(!plan.retire.some(r => r.id === 'gone'), 'cancelled rows must not inflate the count')
  })

  it('counts as protected only rows that were retirement candidates to begin with', () => {
    // Log accuracy on the line an operator reads at 11pm: a pinned row that is
    // ALREADY cancelled was never eligible, so reporting it as "skipped because
    // a human pinned it" overstates what the run actually protected.
    const pinnedLive = {
      id: 'human', source_id: 'hand-published-2026-08-18', status: 'published',
      manual_overrides: { status: { by: 'byron' } },
    }
    const pinnedDead = {
      id: 'old-retirement', source_id: 'retired-2026-08-16', status: 'cancelled',
      manual_overrides: { status: { by: 'scrape-city-of-cuyahoga-falls:retirement' } },
    }
    const plan = planRetirement({
      rows: [...filler, pinnedLive, pinnedDead], resolvedSourceIds: resolved, ...healthy,
    })
    assert.equal(plan.skipped, null)
    assert.equal(plan.protectedCount, 1, 'the already-cancelled pin is not something this run protected')
    assert.ok(!plan.retire.some(r => r.id === 'human' || r.id === 'old-retirement'))
  })

  it('never retires a row this run resolved', () => {
    const plan = planRetirement({ rows: filler, resolvedSourceIds: resolved, ...healthy })
    assert.deepEqual(plan.retire, [])
    assert.equal(plan.skipped, null)
  })

  it('still protects pinned and already-cancelled rows when the ceiling is bypassed', () => {
    // The first run WILL be an over-ceiling run with the operator flag set. The
    // 9 hand-cancelled rows from the incident, and anything Byron hand-published,
    // must survive it untouched — the flag relaxes the ceiling, nothing else.
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `drop-${i}`, source_id: `gone-${i}-2026-08-16`, status: 'published', manual_overrides: null,
      })),
      { id: 'human', source_id: 'hand-published-2026-08-18', status: 'published',
        manual_overrides: { status: { at: '2026-08-16T02:00:00Z', by: 'byron' } } },
      { id: 'already', source_id: 'cancelled-2026-08-18', status: 'cancelled', manual_overrides: null },
      ...filler.slice(0, 8),   // 6 of 16 in-window rows → 38%, over the ceiling
    ]
    const plan = planRetirement({ rows, resolvedSourceIds: resolved, ...healthy, allowFullRetirement: true })
    assert.equal(plan.skipped, null)
    assert.equal(plan.ceilingBypassed, true)
    assert.deepEqual(plan.retire.map(r => r.id).sort(),
      ['drop-0', 'drop-1', 'drop-2', 'drop-3', 'drop-4', 'drop-5'])
    assert.equal(plan.protectedCount, 1)
  })

  it('bounds the retirement query above CF’s real volume, never at the PostgREST default', () => {
    // An implicit 1000-row page would understate the ceiling's denominator and
    // make an over-ceiling sweep look safe.
    assert.ok(RETIREMENT_QUERY_LIMIT > 1000, `limit ${RETIREMENT_QUERY_LIMIT} is at or under the implicit default`)
  })

  it('hasStatusOverride recognises a pin regardless of its value', () => {
    assert.equal(hasStatusOverride({ manual_overrides: { status: { by: 'byron' } } }), true)
    assert.equal(hasStatusOverride({ manual_overrides: { status: null } }), true)  // the KEY is the pin
    assert.equal(hasStatusOverride({ manual_overrides: { tags: { by: 'byron' } } }), false)
    assert.equal(hasStatusOverride({ manual_overrides: {} }), false)
    assert.equal(hasStatusOverride({ manual_overrides: null }), false)
    assert.equal(hasStatusOverride({}), false)
    assert.equal(hasStatusOverride(null), false)
  })
})

describe('parseTimeFromText', () => {
  const cases = [
    ['7 - 8 p.m.',                   '19:00:00'], // range: take the start, inherit p.m.
    ['from 4 – 7 p.m.',              '16:00:00'], // en-dash range
    ['11:30 a.m. – 1 p.m.',          '11:30:00'], // start states its own meridiem
    ['take place from 6 to 10 p.m.', '18:00:00'], // "to" range
    ['9 a.m. - 3 p.m.',              '09:00:00'], // a.m. start
    ['beginning at 7 p.m.',          '19:00:00'], // single time
    ['10:30am',                      '10:30:00'], // single, compact
    ['12 - 2 p.m.',                  '12:00:00'], // noon start, not midnight
    ['11 - 1 p.m.',                  '11:00:00'], // crosses noon → start is a.m.
    ['',                             '12:00:00'], // empty → noon default
    ['Free admission, all welcome.', '12:00:00'], // no clock time → noon default
  ]
  for (const [input, expected] of cases) {
    it(`"${input}" → ${expected}`, () => {
      assert.equal(parseTimeFromText(input), expected)
    })
  }

  it('still returns a bare HH:MM:SS string (signature unchanged)', () => {
    // parseTimeFromText is now a wrapper over parseTimeFromTextDetailed; its
    // one-arg signature and string return must not have changed.
    assert.equal(parseTimeFromText.length, 1)
    assert.equal(typeof parseTimeFromText('beginning at 7 p.m.'), 'string')
  })
})

describe('parseTimeFromTextDetailed (2026-07-28 decision)', () => {
  it('flags only the two fallback paths as inferred', () => {
    assert.deepEqual(parseTimeFromTextDetailed(''),                            { time: '12:00:00', inferred: true })
    assert.deepEqual(parseTimeFromTextDetailed('Free admission, all welcome.'),{ time: '12:00:00', inferred: true })
  })

  it('does NOT flag a genuine noon event, even though the time matches the default', () => {
    // The false positive that motivated `inferred`: a real 12:00 PM event
    // returns the same string as the fallback, so the string cannot be the test.
    assert.deepEqual(parseTimeFromTextDetailed('12 - 2 p.m.'),  { time: '12:00:00', inferred: false })
    assert.deepEqual(parseTimeFromTextDetailed('at 12 p.m.'),   { time: '12:00:00', inferred: false })
  })

  it('agrees with parseTimeFromText on every case above', () => {
    for (const [input] of [['7 - 8 p.m.'], ['11 - 1 p.m.'], ['10:30am'], [''], ['no time here']]) {
      assert.equal(parseTimeFromTextDetailed(input).time, parseTimeFromText(input))
    }
  })
})

describe('parseTimeFromTextDetailed — no clock time may be read out of a date', () => {
  // The 2026-08 incident. The range scanner reached into the four-digit year and
  // matched "26 - 9:00 AM" out of the first string; timeStr's unguarded
  // `hr % 12` turned 26 into 2, so a 9 a.m. event was stored at 02:00 with
  // inferred:false — which suppressed TIME_NOTE, so nothing disclosed it.
  //
  // Constraining the hour alternation alone does NOT fix this: the engine
  // backtracks into a shorter slice of the year, "2026" yields 6, and you get a
  // plausible 06:00 that would slip past the noon/midnight heuristics that
  // caught this. Digit boundaries + an hour-validity check + a rescan from
  // match.index + 1 are all three required, together.
  const incidents = [
    ['Wednesday, August 4-25, 2026 - 9:00 AM - 11:00 AM', '09:00:00'],  // year swallowed by the range
    ['Saturday, August 29 - 9:00 AM',                     '09:00:00'],  // standalone day number + dash
    ['Thursday, October 8, 2026 - 12:30 PM - 1:30 PM',    '12:30:00'],  // real 12:30, not a default
    ['Recurring every Tuesday, June 2-30, 2026 - 6:00 PM', '18:00:00'], // date range then a single time
  ]
  for (const [input, expected] of incidents) {
    it(`"${input}" → ${expected}`, () => {
      assert.deepEqual(parseTimeFromTextDetailed(input), { time: expected, inferred: false })
    })
  }

  it('falls back to the sanctioned noon default (inferred) when a date carries no time', () => {
    // Failing visibly is the required behaviour: inferred:true is what makes
    // buildDescription append TIME_NOTE. A year with no clock time must not
    // become 20:26, 02:00, or 06:00.
    for (const text of [
      'Saturday, August 29, 2026',
      'Runs August 4-25, 2026',
      'Every Monday, June 1 through August 31',
      'Doors at dusk',
    ]) {
      assert.deepEqual(parseTimeFromTextDetailed(text), { time: '12:00:00', inferred: true }, text)
      assert.ok(buildDescription({ description: text, timeInferred: true }).endsWith(TIME_NOTE))
    }
  })

  it('never returns an hour outside 00-23, for any input', () => {
    const inputs = [
      '', 'no numbers at all', 'August 4-25, 2026 - 9:00 AM - 11:00 AM', '2026', '20260817',
      '99 - 99 p.m.', '0 - 0 a.m.', '13 - 15 p.m.', '25:99 p.m.', '24 p.m.', '00:00 a.m.',
      '1234567890 p.m.', 'from 4 – 7 p.m.', '11 - 1 p.m.', '12 - 2 p.m.', 'Suite 2400 - 5 p.m.',
      'Route 8 to 10 p.m.', 'call 330-971-8200 - 7 p.m.', '2026-08-17 - 9:00 AM',
      ...Array.from({ length: 60 }, (_, i) => `Event ${i} - ${i}:${String(i).padStart(2, '0')} p.m.`),
    ]
    for (const input of inputs) {
      const { time } = parseTimeFromTextDetailed(input)
      assert.match(time, /^([01]\d|2[0-3]):[0-5]\d:00$/, `bad clock time ${time} from ${JSON.stringify(input)}`)
    }
  })

  it('still reads a real time that sits next to a rejected one', () => {
    // The rescan requirement: rejecting "29 - 9:00 AM" must resume from
    // match.index + 1 and still find the 9:00 AM, not skip past the whole match
    // and fall through to noon.
    assert.equal(parseTimeFromTextDetailed('Saturday, August 29 - 9:00 AM').inferred, false)
    assert.equal(parseTimeFromTextDetailed('August 29 - 9:00 AM - 11:00 AM').time, '09:00:00')
    assert.equal(parseTimeFromTextDetailed('Booth 25 - open 4 – 7 p.m.').time, '16:00:00')
  })

  it('reads the real detail-page prose for the event the incident was about', () => {
    // The Riverfront Cruise In meta description, verbatim.
    const meta = 'The Riverfront Car Cruise In is held every Monday from June 1 through ' +
      'August 31, 4 – 7 p.m., at 2310 2nd St., Cuyahoga Falls, OH 44221.'
    assert.deepEqual(parseTimeFromTextDetailed(meta), { time: '16:00:00', inferred: false })
  })
})

describe('default-time disclosure (2026-07-28 decision)', () => {
  // Detail objects built exactly the way fetchDetail builds them, from the real
  // parser, so these cover the shipped path rather than a copy of it.
  const detailFor = (desc) => {
    const parsed = parseTimeFromTextDetailed(desc || '')
    return { description: desc, timeStr: parsed.time, timeInferred: parsed.inferred }
  }

  it('does NOT append the note for a real, parsed 12:00 PM event', () => {
    const detail = detailFor('Doors open 12 - 2 p.m. at Riverfront Plaza.')
    assert.equal(detail.timeStr, '12:00:00')
    assert.equal(buildDescription(detail), detail.description)
    assert.ok(!buildDescription(detail).includes(TIME_NOTE))
  })

  it('appends the note when the time was inferred', () => {
    const detail = detailFor('Family fun on the riverfront. Free admission, all welcome.')
    assert.equal(detail.timeInferred, true)
    const description = buildDescription(detail)
    assert.ok(description.startsWith('Family fun on the riverfront.'))
    assert.ok(description.endsWith(TIME_NOTE), 'note must be the final clause')
  })

  it('does not double the note when the description already contains it', () => {
    const detail = { description: `Some blurb. ${TIME_NOTE}`, timeInferred: true }
    assert.equal(buildDescription(detail), detail.description)
    assert.equal(buildDescription(detail).split(TIME_NOTE).length - 1, 1)
  })

  it('leaves a null description null: the note is a suffix, never a description', () => {
    // A note-only description would be 100+ chars of boilerplate that reads as
    // a complete listing to anything measuring description length, including
    // the digest's `described` weight. Null in, null out.
    assert.equal(buildDescription({ description: null, timeInferred: true }), null)
    assert.equal(buildDescription({ description: null, timeInferred: false }), null)
    assert.equal(buildDescription({ description: '', timeInferred: true }), null)
    assert.equal(buildDescription({ description: '   ', timeInferred: true }), '   ')
  })

  it('adds nothing on the detail-fetch failure path (description stays null)', () => {
    // fetchDetail's initializer, which the catch branch keeps. timeInferred is
    // true there, but with no prose there is nothing to append the note to, so
    // a failed fetch must never come out looking like a described event.
    const fallback = { title: null, description: null, imageUrl: null, timeStr: '12:00:00', timeInferred: true }
    assert.equal(buildDescription(fallback), null)
  })

  it('never exceeds the 5000-char description cap', () => {
    // fetchDetail slices the base to 5000; appending a ~130-char note used to
    // push the stored value to 5122.
    const base = 'a'.repeat(5000)
    const out = buildDescription({ description: base, timeInferred: true })
    assert.ok(out.length <= 5000, `description was ${out.length} chars`)
    assert.ok(out.endsWith(TIME_NOTE), 'the note must survive the cap intact')
  })

  it('truncates on a character boundary, not mid-surrogate-pair', () => {
    // room = 5000 - TIME_NOTE.length - 1. Put an emoji (one code point, TWO
    // UTF-16 units) so it straddles the cut: a bare slice(0, room) ends on a
    // lone high surrogate, which is not well-formed UTF-16 and round-trips
    // through Postgres as U+FFFD. Same defect class as commit 960c219.
    const room = 5000 - TIME_NOTE.length - 1
    const base = `${'a'.repeat(room - 1)}🎪${'b'.repeat(200)}`
    const out = buildDescription({ description: base, timeInferred: true })
    assert.ok(out.isWellFormed(), 'truncation produced a lone surrogate')
    assert.ok(out.length <= 5000, `description was ${out.length} chars`)
    assert.ok(out.endsWith(TIME_NOTE), 'the note must survive the cap intact')
    // The emoji did not fit whole, so it is dropped entirely rather than halved.
    assert.ok(!out.includes('🎪'))
  })

  it('keeps a multi-byte character that fits entirely within the cap', () => {
    const room = 5000 - TIME_NOTE.length - 1
    const base = `${'a'.repeat(room - 2)}🎪${'b'.repeat(200)}`
    const out = buildDescription({ description: base, timeInferred: true })
    assert.ok(out.isWellFormed())
    assert.ok(out.includes('🎪'), 'a character that fits must not be dropped')
  })
})

describe('description is not double-stripped (2026-07-28 regression)', () => {
  // stripHtml strips tags and THEN decodes entities, so running it twice over
  // the same text un-escapes one level of encoding. fetchDetail already strips
  // the meta content once; buildDescription must not strip it again, or a
  // double-encoded source becomes literal markup in the stored description.
  const RAW_META = 'Family fun at the park. &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt; Bring a chair.'

  // Exactly what fetchDetail stores, using the real stripHtml.
  const baseFor = () => stripHtml(RAW_META).slice(0, 5000)

  it('keeps double-encoded markup escaped on the inferred path', () => {
    const base = baseFor()
    assert.match(base, /&lt;script&gt;/, 'fixture must still be escaped after one strip')

    const out = buildDescription({ description: base, timeInferred: true })
    assert.ok(!out.includes('<script>'),  'markup was un-escaped by a second strip')
    assert.ok(!out.includes('</script>'), 'markup was un-escaped by a second strip')
    assert.ok(!/<[a-z/]/i.test(out),      'no tag-like sequence may appear')
    assert.match(out, /&lt;script&gt;/)
  })

  it('both branches agree on the prose, differing only by the appended note', () => {
    const base = baseFor()
    const inferred = buildDescription({ description: base, timeInferred: true })
    const parsed   = buildDescription({ description: base, timeInferred: false })
    assert.equal(parsed, base, 'the parsed branch must pass the base through unchanged')
    assert.equal(inferred, `${base} ${TIME_NOTE}`)
    assert.equal(inferred.slice(0, base.length), parsed)
  })
})
