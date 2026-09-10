/**
 * test-ohio-shakespeare.js
 *
 * Exercises the REAL parsers exported by scrape-ohio-shakespeare.js. An earlier
 * version of this file reimplemented the date regexes with `new Date(...)`
 * inline, so it proved nothing about the scraper — the fork is gone.
 *
 * Run:  node --test scripts/tests/test-ohio-shakespeare.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2 } from './fixtures/ohio-shakespeare-events.js'
import { LATE_EDT, LATE_EST } from './fixtures/late-night-clocks.js'
import { inferYear, parseDateString, parseShowPage } from '../scrape-ohio-shakespeare.js'

// Frozen clocks for the year-inference lookahead tests below. Built the same
// way as LATE_EDT/LATE_EST in fixtures/late-night-clocks.js: pick a UTC
// instant that lands well inside the target Eastern calendar day so DST
// offset (EDT = UTC-4, EST = UTC-5) can't push it across a day boundary.
const SEP10_2026 = new Date('2026-09-10T16:00:00Z')  // 2026-09-10 noon EDT
const NOV15_2026 = new Date('2026-11-15T16:00:00Z')  // 2026-11-15 11:00 EST
const JAN3_2027  = new Date('2027-01-03T16:00:00Z')  // 2027-01-03 11:00 EST

/** A Squarespace production page, shaped like the real ones. */
const showPage = (title, dateText, extra = '') => `
  <html><head>
    <meta property="og:title" content="${title}">
    <meta property="og:image" content="https://images.squarespace-cdn.com/${title.replace(/\s+/g, '-')}.jpg">
    <title>${title} — Ohio Shakespeare Festival</title>
  </head><body>
    <h1>${title}</h1>
    <p>${dateText} at the Greystone Hall courtyard.</p>
    <p>Ohio Shakespeare Festival presents a bold new staging.</p>
    ${extra}
  </body></html>`

describe('Ohio Shakespeare: parseDateString (real parser)', () => {
  it('parses a month-to-month range with an explicit trailing year', () => {
    // F1.raw is "June 15 - July 20, 2026" — the range branch now checks for
    // an explicit \b\d{4}\b in the string and prefers it over inference
    // (ported from scrape-weathervane.js's `explicit` handling), so this
    // holds regardless of clock instead of passing by luck.
    assert.equal(parseDateString(F1.raw, LATE_EST), F1.exp.start)
  })

  it('parses a month-to-month range with an explicit year, even when inference would roll it forward', () => {
    // Same fixture at a clock where naive inference would push June 15 to
    // next year — the explicit 2026 in the string must still win.
    assert.equal(parseDateString(F1.raw, SEP10_2026), F1.exp.start)
  })

  it('parses a single date with an explicit year', () => {
    assert.equal(parseDateString(F2.raw, LATE_EDT), F2.exp.start)   // "May 10, 2026"
  })

  it('returns null for text with no date in it', () => {
    assert.equal(parseDateString('Coming soon', LATE_EDT), null)
    assert.equal(parseDateString('', LATE_EDT), null)
  })
})

// The bug: inferYear derived "today" from `new Date().toISOString()`, which at
// 11pm ET is already tomorrow — so a show opening TONIGHT was inferred a full
// year out, and the past-show cutoff in fetchAndProcessShows used the same
// UTC "today".
describe('Ohio Shakespeare: late-evening ET runs keep tonight\'s opening', () => {
  it('inferYear resolves today to the current year (EDT)', () => {
    assert.equal(inferYear(7, 15, LATE_EDT), 2026)     // NOT 2027
  })

  it('inferYear resolves today to the current year (EST)', () => {
    assert.equal(inferYear(1, 15, LATE_EST), 2026)     // NOT 2027
  })

  it('a just-past date stays in the current year so the past-filter drops it', () => {
    assert.equal(inferYear(7, 14, LATE_EDT), 2026)
  })

  it('parseDateString dates a year-less opening as today, not next year (EDT)', () => {
    assert.equal(parseDateString('July 15', LATE_EDT), '2026-07-15')
    assert.equal(parseDateString('July 15 - 26', LATE_EDT), '2026-07-15')
  })

  it('parseDateString dates a year-less opening as today, not next year (EST)', () => {
    assert.equal(parseDateString('January 15', LATE_EST), '2026-01-15')
    assert.equal(parseDateString('January 15 - 26', LATE_EST), '2026-01-15')
  })

  it('parseShowPage end-to-end: title, image and today\'s date (EDT)', () => {
    const parsed = parseShowPage(showPage('Julius Caesar', 'July 15 - 26'), 'julius-caesar', LATE_EDT)
    assert.equal(parsed.title, 'Julius Caesar')
    assert.equal(parsed.dateStr, '2026-07-15')          // NOT 2027-07-15
    assert.equal(parsed.imageUrl, 'https://images.squarespace-cdn.com/Julius-Caesar.jpg')
  })

  it('parseShowPage end-to-end: today\'s date in winter too (EST)', () => {
    const parsed = parseShowPage(showPage('Twelfth Night', 'January 15 - 26'), 'twelfth-night', LATE_EST)
    assert.equal(parsed.title, 'Twelfth Night')
    assert.equal(parsed.dateStr, '2026-01-15')          // NOT 2027-01-15
  })

  it('parseShowPage keeps an inline start time', () => {
    const parsed = parseShowPage(showPage('Hamlet', 'July 15 8pm'), 'hamlet', LATE_EDT)
    assert.equal(parsed.dateStr, '2026-07-15')
    assert.equal(parsed.timeStr, '20:00:00')
  })
})

describe('Ohio Shakespeare: inferYear lookahead (clock frozen at 2026-09-10 ET)', () => {
  it('"July 16" is in the past this year and stays 2026, not rolled to 2027', () => {
    assert.equal(inferYear(7, 16, SEP10_2026), 2026)
  })

  it('"August 6" is in the past this year and stays 2026', () => {
    assert.equal(inferYear(8, 6, SEP10_2026), 2026)
  })

  it('"December 20" is within the lookahead and stays this year', () => {
    assert.equal(inferYear(12, 20, SEP10_2026), 2026)
  })

  it('"January 10" from a November clock rolls forward to next year', () => {
    assert.equal(inferYear(1, 10, NOV15_2026), 2027)
  })

  it('a Jan 3, 2027 clock reading "December 30" rolls back to the previous year', () => {
    assert.equal(inferYear(12, 30, JAN3_2027), 2026)
  })
})
