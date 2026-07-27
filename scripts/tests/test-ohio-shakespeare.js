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
  it('parses a month-to-month range', () => {
    // KNOWN GAP — this assertion passes by luck of the clock, not because the
    // parser is right. F1.raw is "June 15 - July 20, 2026": the range branch in
    // scrape-ohio-shakespeare.js:86-93 DISCARDS the explicit trailing 2026 and
    // runs inferYear() instead. With the January clock used here inference
    // happens to land on 2026; with an August 2026 clock the same fixture
    // yields 2027-06-15, so a show that is currently running gets rolled a
    // full year forward.
    //
    // scrape-weathervane.js:97 shows the correct handling — it checks for an
    // `explicit` \b\d{4}\b in the range and prefers it over inference. Porting
    // that here is a separate, pre-existing defect (out of scope for the
    // easternTodayIso migration); do not read this green test as proof the
    // range branch reads years correctly.
    assert.equal(parseDateString(F1.raw, LATE_EST), F1.exp.start)
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

  it('inferYear still rolls a genuinely past month/day forward', () => {
    assert.equal(inferYear(7, 14, LATE_EDT), 2027)
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
