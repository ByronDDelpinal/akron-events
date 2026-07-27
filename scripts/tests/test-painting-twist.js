/**
 * test-painting-twist.js
 *
 * Exercises the REAL parsers exported by scrape-painting-twist.js. An earlier
 * version of this file reimplemented parsePwtDateTime and parsePrice inline, so
 * it proved nothing about the scraper — the forks are gone.
 *
 * Run:  node --test scripts/tests/test-painting-twist.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2 } from './fixtures/painting-twist-events.js'
import { LATE_EDT, LATE_EST } from './fixtures/late-night-clocks.js'
import { parseEvents, parsePwtDateTime, parsePrice, isLikelyTitle } from '../scrape-painting-twist.js'

// PWT's calendar renders each class as a block of date / price / title text
// followed by the booking link. parseEvents looks BACKWARD from each
// /event/{id}/ href, so the fields must precede the anchor — and consecutive
// cards must sit far enough apart that one card's chunk can't swallow the
// previous card's date line (the real page is heavy with markup between them).
const SPACER = `<div class="pad">${'x'.repeat(2400)}</div>`

const pwtCard = (id, dateTime, price, title) => `
  <li class="event-card">
    <p class="date">${dateTime}</p>
    <p class="price">${price}</p>
    <p class="title">${title}</p>
    <a href="/studio/akron-fairlawn/event/${id}/">Book Now</a>
  </li>`

const PWT_HTML = [
  pwtCard('4310618', 'Wed, Jul 15, 6:30 pm', '$34-$44', 'Bless our Nest'),
  pwtCard('4310619', 'Tue, Jul 14, 6:30 pm', '$34-$44', 'Yesterday Sunset'),
  pwtCard('4310620', 'Thu, Jul 16, 6:30 pm', '$39',     'Tomorrow Poppies'),
].join(SPACER)

const PWT_HTML_WINTER = [
  pwtCard('5310618', 'Thu, Jan 15, 6:30 pm', '$34-$44', 'Winter Cardinal'),
  pwtCard('5310619', 'Wed, Jan 14, 6:30 pm', '$34-$44', 'Yesterday Snow'),
].join(SPACER)

// ── Fallback-path fixture ──────────────────────────────────────────────────
//
// parseEvents has a SECOND parser that only runs when the link-context pass
// returns nothing: it flattens the whole page with htmlToText and walks the
// blank-line-separated blocks. PWT_HTML above always yields 3 events through
// the primary path, so nothing here reached that branch — and its date
// handling was changed by this fix.
//
// The trigger is real: PWT has shipped calendar markup where the booking id
// appears in body text rather than in an `href`, which leaves the
// `href="…/event/N/"` scan (and its `href="*/event/N*"` fallback) with zero
// matches. So this fixture carries the ids as plain text only — no `href` at
// all — and relies on the REAL htmlToText for block structure: `</p>` becomes
// a blank line (a block boundary) and `<br>` a single newline (a field
// boundary within a block).
const pwtTextCard = (id, dateTime, price, title) =>
  `<p>${dateTime}<br>${price}<br>${title}<br>/event/${id}/</p>`

const PWT_HTML_NO_HREF = `<div class="calendar">${[
  pwtTextCard('4410618', 'Wed, Jul 15, 6:30 pm', '$34-$44', 'Bless our Nest'),
  pwtTextCard('4410619', 'Tue, Jul 14, 6:30 pm', '$34-$44', 'Yesterday Sunset'),
  pwtTextCard('4410620', 'Thu, Jul 16, 6:30 pm', '$39',     'Tomorrow Poppies'),
].join('\n')}</div>`

const PWT_HTML_NO_HREF_WINTER = `<div class="calendar">${[
  pwtTextCard('5410618', 'Thu, Jan 15, 6:30 pm', '$34-$44', 'Winter Cardinal'),
  pwtTextCard('5410619', 'Wed, Jan 14, 6:30 pm', '$34-$44', 'Yesterday Snow'),
].join('\n')}</div>`

describe('Painting with a Twist: parsePwtDateTime (real parser)', () => {
  it('parses the "Day, Mon DD, H:MM am/pm" shape into date + time', () => {
    const { dateStr, timeStr } = parsePwtDateTime('Sun, Mar 22, 6:30 pm', LATE_EDT)
    assert.equal(dateStr, '2027-03-22')     // Mar 22 already passed in 2026
    assert.equal(timeStr, '18:30:00')
  })

  it(`converts the fixture time (${F1.raw}) correctly inside a full date-time`, () => {
    const { timeStr } = parsePwtDateTime(`Wed, Jul 15, ${F1.raw.replace('pm', ' pm')}`, LATE_EDT)
    assert.equal(timeStr, `${F1.exp}:00`)
  })

  it('returns nulls for input it cannot parse', () => {
    assert.deepEqual(parsePwtDateTime('', LATE_EDT), { dateStr: null, timeStr: null })
    assert.deepEqual(parsePwtDateTime('sometime soon', LATE_EDT), { dateStr: null, timeStr: null })
  })

  it('keeps TODAY in the current year at 11:30pm ET (EDT)', () => {
    assert.equal(parsePwtDateTime('Wed, Jul 15, 6:30 pm', LATE_EDT).dateStr, '2026-07-15')
  })

  it('keeps TODAY in the current year at 11:30pm ET (EST)', () => {
    assert.equal(parsePwtDateTime('Thu, Jan 15, 6:30 pm', LATE_EST).dateStr, '2026-01-15')
  })
})

describe('Painting with a Twist: parsePrice (real parser)', () => {
  it('parses a price range', () => {
    assert.deepEqual(parsePrice(F2.price), { price_min: F2.expMin, price_max: F2.expMax })
  })
  it('parses a single price and "Free"', () => {
    assert.deepEqual(parsePrice('$39'), { price_min: 39, price_max: null })
    assert.deepEqual(parsePrice('Free'), { price_min: 0, price_max: null })
  })
  it('returns nulls for missing input', () => {
    assert.deepEqual(parsePrice(null), { price_min: null, price_max: null })
  })
})

describe('Painting with a Twist: isLikelyTitle', () => {
  it('accepts real class names and rejects price/time/duration fragments', () => {
    assert.equal(isLikelyTitle('Bless our Nest'), true)
    assert.equal(isLikelyTitle('$34-$44'), false)
    assert.equal(isLikelyTitle('9:00 AM - 12:00 PM'), false)
    assert.equal(isLikelyTitle('3 spots left'), false)
  })
})

// The bug: parseEvents derived "today" from `new Date().toISOString()`, which
// at 11pm ET is already tomorrow. PWT's listings carry no year, so the damage
// here is MIS-DATING rather than dropping: today's 6:30pm class was stamped a
// full year into the future (and then survived the past-filter, so nothing
// looked wrong). It also recomputed "today" inside the loop, so a parse
// straddling midnight compared different rows against different days.
describe('Painting with a Twist: late-evening ET runs date today correctly', () => {
  it('stamps today\'s class with THIS year, not next (EDT)', () => {
    const events = parseEvents(PWT_HTML, LATE_EDT)
    const byTitle = Object.fromEntries(events.map((e) => [e.title, e]))

    assert.ok(byTitle['Bless our Nest'], 'today\'s class must be present')
    assert.equal(byTitle['Bless our Nest'].dateStr, '2026-07-15')   // NOT 2027-07-15
    assert.equal(byTitle['Bless our Nest'].timeStr, '18:30:00')
    assert.equal(byTitle['Bless our Nest'].price_min, 34)
    assert.equal(byTitle['Bless our Nest'].price_max, 44)

    assert.ok(byTitle['Tomorrow Poppies'], 'tomorrow must survive')
    assert.equal(byTitle['Tomorrow Poppies'].dateStr, '2026-07-16')

    // A genuinely past month/day still rolls forward — PWT listings have no
    // year, so "Jul 14" seen on Jul 15 can only mean next year's class.
    assert.equal(byTitle['Yesterday Sunset'].dateStr, '2027-07-14')
  })

  it('stamps today\'s class with THIS year in winter too (EST)', () => {
    const events = parseEvents(PWT_HTML_WINTER, LATE_EST)
    const byTitle = Object.fromEntries(events.map((e) => [e.title, e.dateStr]))
    assert.equal(byTitle['Winter Cardinal'], '2026-01-15')          // NOT 2027-01-15
    assert.equal(byTitle['Yesterday Snow'],  '2027-01-14')
  })

  it('compares every row against ONE "today" (no midnight straddle)', () => {
    // Every row goes through the same hoisted todayYmd, so a run that crosses
    // midnight mid-parse cannot judge two rows by different days.
    const events = parseEvents(PWT_HTML, LATE_EDT)
    assert.equal(events.length, 3)
    assert.ok(events.every((e) => e.dateStr >= '2026-07-15'))
  })
})

// The htmlToText fallback branch of parseEvents. Its date handling changed in
// this fix too, and no existing fixture reached it — PWT_HTML always resolves
// through the primary link-context pass. These cases drive the REAL htmlToText
// (block splitting, <br> handling, entity decoding), not a stand-in.
describe('Painting with a Twist: htmlToText fallback path', () => {
  it('actually takes the fallback (no href="…/event/N" anywhere in the fixture)', () => {
    assert.equal(/href="[^"]*\/event\/\d+/.test(PWT_HTML_NO_HREF), false)
    assert.equal(PWT_HTML_NO_HREF.includes('href='), false)
    // If the primary pass could see these ids the branch would never run.
    assert.equal([...PWT_HTML_NO_HREF.matchAll(/href="([^"]*\/event\/(\d+)[^"]*)"/gi)].length, 0)
  })

  it('parses date, time, price and title out of flattened text (EDT)', () => {
    const events  = parseEvents(PWT_HTML_NO_HREF, LATE_EDT)
    const byTitle = Object.fromEntries(events.map((e) => [e.title, e]))

    assert.equal(events.length, 3)
    assert.equal(byTitle['Bless our Nest'].dateStr,   '2026-07-15')  // today, NOT 2027-07-15
    assert.equal(byTitle['Bless our Nest'].timeStr,   '18:30:00')
    assert.equal(byTitle['Bless our Nest'].price_min, 34)
    assert.equal(byTitle['Bless our Nest'].price_max, 44)
    assert.equal(byTitle['Bless our Nest'].id,        '4410618')

    assert.equal(byTitle['Tomorrow Poppies'].dateStr, '2026-07-16')
    assert.equal(byTitle['Tomorrow Poppies'].price_min, 39)

    // No year in the source, so a past month/day can only mean next year.
    assert.equal(byTitle['Yesterday Sunset'].dateStr, '2027-07-14')
  })

  it('parses the same way in winter (EST)', () => {
    const events  = parseEvents(PWT_HTML_NO_HREF_WINTER, LATE_EST)
    const byTitle = Object.fromEntries(events.map((e) => [e.title, e.dateStr]))
    assert.equal(events.length, 2)
    assert.equal(byTitle['Winter Cardinal'], '2026-01-15')           // NOT 2027-01-15
    assert.equal(byTitle['Yesterday Snow'],  '2027-01-14')
  })
})
