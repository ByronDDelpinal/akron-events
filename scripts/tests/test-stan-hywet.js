/**
 * test-stan-hywet.js
 *
 * Tests for the Stan Hywet date/time parser. The estate's `<p class="date">`
 * strings are highly heterogeneous; these cases are taken verbatim from the
 * live /public-events listing (captured 2026-06-25) and lock in the fixes for:
 *   - "a.m."/"p.m." with periods (was silently falling back to 09:00)
 *   - time ranges whose meridiem appears only on the END ("5:30-8:30pm",
 *     "11:00-11:30am") — we take the START and inherit the end's am/pm
 *   - multi-date lists ("May 31, … October 25") — surface the next UPCOMING
 *     date instead of the first, which could roll a year into the future
 *
 * Run:
 *   node --test scripts/tests/test-stan-hywet.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Set dummy env vars before importing the scraper module ──────────────────
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import { extractStartTime, parseStanHywetDate, resolveStartTime } from '../scrape-stan-hywet.js'
// The real note text and the real appender — never a local copy. The digest
// subtracts this exact string before scoring description length.
import { withDateOnlyTimeNote, DATE_ONLY_TIME_NOTE } from '../lib/ics.js'
import { LATE_EDT, LATE_EDT_TODAY, LATE_EST, LATE_EST_TODAY } from './fixtures/late-night-clocks.js'

describe('extractStartTime — start-of-range + a.m./p.m. handling', () => {
  const cases = [
    // [input, expected]
    ['July 8, August 5 | 10:30 a.m. - 12:00 p.m.',                 '10:30:00'], // periods + range start
    ['July 7, and August 4 | 10:30 a.m.-11:30 a.m.',               '10:30:00'], // periods, no spaces
    ['July 22 | Session 1: 11:00-11:30am | Session 2: 11:30am-12:00pm', '11:00:00'], // start inherits am
    ['July 16, & September 3 | 11-11:30am',                        '11:00:00'], // bare-hour start inherits am
    ['July 30 | 1:00-3:00pm',                                      '13:00:00'], // start inherits pm
    ['July 31 | 5:30-8:30pm',                                      '17:30:00'], // start inherits pm
    ['August 6, 2026 | 12:00–1:00pm',                             '12:00:00'], // noon, en-dash range
    ['July 26, Sept 12 | 11:00am-1:00pm',                          '11:00:00'], // start already has am
    ['June 26 | 6pm-midnight',                                     '18:00:00'], // non-time end → single
    ['August 9, October 25, & December 6 | 11am',                  '11:00:00'], // single time
    ['As You Like It | 7:30pm',                                    '19:30:00'], // plain single time
  ]

  for (const [input, expected] of cases) {
    it(`"${input}" → ${expected}`, () => {
      assert.equal(extractStartTime(input), expected)
    })
  }

  it('does not misread a day range as a time range ("July 9-26 | 7:30pm")', () => {
    assert.equal(extractStartTime('July 9-26 | 7:30pm'), '19:30:00')
  })

  it('returns null when no clock time is published', () => {
    assert.equal(extractStartTime('July 11 & July 12 | Game Times: Coming soon!'), null)
  })

  it('returns null on empty input', () => {
    assert.equal(extractStartTime(''), null)
    assert.equal(extractStartTime(null), null)
  })
})

describe('parseStanHywetDate — time is correct across formats', () => {
  it('Nature Buddies keeps 10:30 (was 09:00 default)', () => {
    const { timeStr } = parseStanHywetDate('July 8, August 5 | 10:30 a.m. - 12:00 p.m.')
    assert.equal(timeStr, '10:30:00')
  })

  it('Secrets from the Archives keeps the 11:00 session start (was 11:30)', () => {
    const { timeStr } = parseStanHywetDate('July 22 | Session 1: 11:00-11:30am | Session 2: 11:30am-12:00pm')
    assert.equal(timeStr, '11:00:00')
  })

  it('Off the Vine keeps the 5:30 start (was 8:30pm)', () => {
    const { timeStr } = parseStanHywetDate('July 31 | 5:30-8:30pm')
    assert.equal(timeStr, '17:30:00')
  })
})

describe('resolveStartTime — recovers the time from description prose', () => {
  it('Nature Sprouts: date line has no time, body does (was 09:00 default)', () => {
    // Live shape: `.date` is just the dates; the time lives in the body copy.
    const dateLine = 'July 7, and August 4'
    const body =
      'BIG adventures for little explorers! Each session features a unique theme. ' +
      'All sessions run 10:30 - 11:30 a.m. Members: Adults FREE, Youth $5. ' +
      'Registration closes at 5:00 p.m. the day before each session.'
    assert.deepEqual(resolveStartTime(dateLine, body), { time: '10:30:00', synthesized: false })
  })

  it('prefers the date line when it carries a time, ignoring the prose', () => {
    assert.deepEqual(
      resolveStartTime('July 31 | 5:30-8:30pm', 'Doors at 7:00pm; show later.'),
      { time: '17:30:00', synthesized: false },
    )
  })

  it('falls back to the 09:00 default when neither has a clock time', () => {
    assert.deepEqual(
      resolveStartTime('July 7, and August 4', 'Join us for a fun morning on the grounds.'),
      { time: '09:00:00', synthesized: true },
    )
  })

  it('ignores dash-joined digits without a meridiem (phone numbers)', () => {
    assert.deepEqual(
      resolveStartTime('August 15', 'Questions? Call the Visitors Center at 330-865-8065.'),
      { time: '09:00:00', synthesized: true },
    )
  })
})

describe('Stan Hywet: the 09:00 default is disclosed, never silent', () => {
  // SANCTIONED-DEFAULT-TIME. A listing with a date but no clock time is stored
  // at 9am ET because null is unstorable and midnight drops the row out of
  // every feed at 00:00:01 on its own morning. The price of inventing a time
  // is that we say so in the description and send the row to the review queue.
  // These cases call the same two functions processEvents calls, in the same
  // order, so the disclosure text cannot drift away from the digest's copy.

  it('synthesized: notes the description exactly once and flags for review', () => {
    const { time, synthesized } = resolveStartTime(
      'August 15',
      'Wander the gardens at your own pace.',
    )
    assert.equal(time, '09:00:00')
    assert.equal(synthesized, true, 'synthesized drives BOTH the note and needs_review')

    const stored = synthesized
      ? withDateOnlyTimeNote('Wander the gardens at your own pace.')
      : 'Wander the gardens at your own pace.'
    assert.ok(stored.endsWith(DATE_ONLY_TIME_NOTE), 'note must be the final clause')
    assert.equal(stored.split(DATE_ONLY_TIME_NOTE).length - 1, 1)

    // Re-scraping must not stack the sentence.
    assert.equal(
      withDateOnlyTimeNote(stored).split(DATE_ONLY_TIME_NOTE).length - 1,
      1,
    )
  })

  it('parsed: a genuine 9 a.m. listing gets no note and no review flag', () => {
    // The regression this guards: deriving `synthesized` by comparing the
    // result to '09:00:00' would put a "no start time given" disclosure on an
    // event that plainly gave one — the estate runs several 9 a.m. programs.
    const { time, synthesized } = resolveStartTime(
      'September 12 | 9 a.m.-noon',
      'Doors open at 8:30 a.m. for members.',
    )
    assert.equal(time, '09:00:00')
    assert.equal(synthesized, false)
    const stored = synthesized
      ? withDateOnlyTimeNote('Doors open at 8:30 a.m. for members.')
      : 'Doors open at 8:30 a.m. for members.'
    assert.ok(!stored.includes(DATE_ONLY_TIME_NOTE))
  })

  it('synthesized with no description: stays null, review flag still earned', () => {
    // A note-only description would read as a complete listing to anything
    // measuring description length, so the note is a suffix to real prose or
    // nothing. needs_review is the whole audit trail for these rows.
    const { synthesized } = resolveStartTime('August 15', '')
    assert.equal(synthesized, true)
    assert.equal(withDateOnlyTimeNote(null), null)
  })
})

describe('parseStanHywetDate — multi-date lists surface the next upcoming date', () => {
  it('skips a past date and picks the upcoming one (Photography Walk bug)', () => {
    // May 31 2000 is firmly past; October 25 2099 is firmly future.
    const { dateStr } = parseStanHywetDate('May 31, 2000, October 25, 2099 | 2:00pm')
    assert.equal(dateStr, '2099-10-25')
  })

  it('picks the earliest of several upcoming dates', () => {
    const { dateStr, timeStr } = parseStanHywetDate('August 9, 2099, October 25, 2099, & December 6, 2099 | 11am')
    assert.equal(dateStr, '2099-08-09')
    assert.equal(timeStr, '11:00:00')
  })
})

// The nightly scrape is moving to 11pm ET, which lands inside the window where
// the UTC calendar date has already rolled to tomorrow. For a multi-date list
// that is a WRONG-DATA bug, not a missing-data one: today's occurrence looks
// past, so the parser silently advertises the NEXT date in the list.
describe('parseStanHywetDate — late-evening ET runs (11pm) keep today', () => {
  it('picks today, not the next date in the list (11:30pm ET on Aug 9)', () => {
    const lateAug9 = new Date('2026-08-10T03:30:00Z')   // 2026-08-09 23:30 EDT
    const { dateStr } = parseStanHywetDate('August 9, October 25, & December 6 | 11am', lateAug9)
    assert.equal(dateStr, '2026-08-09')                  // NOT 2026-10-25
  })

  it('still advances past a genuinely past date in the list', () => {
    const lateAug10 = new Date('2026-08-11T03:30:00Z')  // 2026-08-10 23:30 EDT
    const { dateStr } = parseStanHywetDate('August 9, October 25, & December 6 | 11am', lateAug10)
    assert.equal(dateStr, '2026-10-25')
  })

  // The recurring branch ("Sundays through 10/25/26") starts the event at
  // "today" so it surfaces immediately. That branch used to build its own date
  // from a bare `new Date()` with LOCAL getFullYear/getMonth/getDate, which
  // ignored the injected clock entirely — so it read the real wall-clock day on
  // a frozen-clock test, and on any runner not set to America/New_York it read
  // the wrong day in production too.
  it('recurring start date honours the injected Eastern clock (EDT)', () => {
    const { dateStr, endDateStr } = parseStanHywetDate('Sundays through 10/25/26 | 1pm', LATE_EDT)
    assert.equal(dateStr, LATE_EDT_TODAY)                // 2026-07-15, not the real today
    assert.equal(endDateStr, '2026-10-25')
  })

  it('recurring start date honours the injected Eastern clock (EST)', () => {
    const { dateStr } = parseStanHywetDate('Wednesdays through 3/25/26 | 1pm', LATE_EST)
    assert.equal(dateStr, LATE_EST_TODAY)                // 2026-01-15
  })

  it('does not roll the year on a single date that is today (11:30pm ET Dec 31)', () => {
    const lateNye = new Date('2027-01-01T04:30:00Z')    // 2026-12-31 23:30 EST
    const { dateStr } = parseStanHywetDate('December 31 | 8pm', lateNye)
    assert.equal(dateStr, '2026-12-31')                  // NOT 2027-12-31
  })

  it('still rolls the year for a date that has genuinely passed', () => {
    const lateNye = new Date('2027-01-01T04:30:00Z')    // 2026-12-31 23:30 EST
    const { dateStr } = parseStanHywetDate('December 30 | 8pm', lateNye)
    assert.equal(dateStr, '2027-12-30')
  })
})

describe('parseStanHywetDate — single dates and ranges are unchanged', () => {
  it('full single date with year', () => {
    const { dateStr, endDateStr } = parseStanHywetDate('April 21, 2026 | 6pm')
    assert.equal(dateStr, '2026-04-21')
    assert.equal(endDateStr, null)
  })

  it('month range keeps start and end', () => {
    const { dateStr, endDateStr } = parseStanHywetDate('May 23–September 13, 2026')
    assert.equal(dateStr, '2026-05-23')
    assert.equal(endDateStr, '2026-09-13')
  })

  it('recurring numeric end-date marker carries the end date', () => {
    const { endDateStr } = parseStanHywetDate('Sundays through 10/25/26')
    assert.equal(endDateStr, '2026-10-25')
  })

  it('returns null dateStr when nothing parses', () => {
    const { dateStr } = parseStanHywetDate('Continues until the End of May')
    assert.equal(dateStr, null)
  })
})

// ── Run-level clock (source-level pin) ─────────────────────────────────────
//
// This is a SOURCE assertion, not a behavioural one, and it is labelled as such
// on purpose. `processEvents` is not exported, and it cannot be: every iteration
// awaits `fetchEventDescription(card.href)` (network) and `upsertEventSafe`
// (database), so there is no way to exercise it in unit tests without a real
// network call. What CAN be pinned without lying about it is the one line that
// matters — that the loop hoists a single clock and hands it to the parser.
//
// Why it matters: that per-card fetch makes the loop span minutes. With the
// nightly job moving to 11pm ET, a ~74-minute run crosses midnight ET, so if
// each call took its own default `new Date()` the cards parsed before and after
// midnight would resolve DIFFERENT "today"s inside one run — the multi-date
// list and the recurring-start branch would disagree card to card.
// scrape-downtown-akron.js and scrape-painting-twist.js already hoist.
describe('scrape-stan-hywet.js — processEvents uses one run-level clock', () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scrape-stan-hywet.js'),
    'utf8'
  )

  it('hoists a single `now` in processEvents', () => {
    const body = src.slice(src.indexOf('async function processEvents('))
    assert.match(
      body.slice(0, 800), /const now = new Date\(\)/,
      'processEvents must hoist `const now = new Date()` once before the card loop'
    )
  })

  it('passes that clock into parseStanHywetDate', () => {
    assert.match(
      src, /parseStanHywetDate\(card\.dateText,\s*now\)/,
      'processEvents must call parseStanHywetDate(card.dateText, now); the bare ' +
      'one-argument form takes a fresh default clock per card, so a run that ' +
      'crosses midnight ET parses two halves of the corpus against two different days'
    )
  })

  it('leaves no bare one-argument parseStanHywetDate call in the scraper', () => {
    const bare = src.split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /parseStanHywetDate\([^,)]*\)/.test(line) && !line.startsWith('*') && !line.startsWith('//'))
      .filter(({ line }) => !line.startsWith('export function'))
    assert.deepEqual(
      bare, [],
      `every parseStanHywetDate() call inside the scraper must pass the hoisted clock:\n` +
      bare.map((b) => `  scrape-stan-hywet.js:${b.no}  ${b.line}`).join('\n')
    )
  })
})
