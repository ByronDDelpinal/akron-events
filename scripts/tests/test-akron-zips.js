/**
 * test-akron-zips.js — University of Akron (Zips) athletics scraper parsing.
 *
 * Run:
 *   node --test scripts/tests/test-akron-zips.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// normalize.js (imported transitively by the scraper) constructs a Supabase
// client at import time; give it dummy creds so the import doesn't throw.
process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseIcs, DATE_ONLY_TIME_NOTE } = await import('../lib/ics.js')
const { parseZipsGame, parseVenueName, stripResultMarker } = await import('../scrape-akron-zips.js')

// A representative slice of the real gozips composite .ics feed: a home football
// game, an away game, a home all-day volleyball game, a BYE week, a past
// home baseball game, and a home all-day soccer game whose DTEND;VALUE=DATE is
// the SAME day as its DTSTART (some Sidearm rows emit the inclusive end rather
// than the RFC's exclusive next-day value).
const FIXTURE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SIDEARM Sports//NONSGML SIDEARM//EN
BEGIN:VEVENT
UID:vcal_11322-admin.gozips.com
DTSTART:20260912T193000Z
DTEND:20260912T223000Z
LOCATION:Akron\\, Ohio\\, InfoCision Stadium - Summa Health Field
SUMMARY:University of Akron Football vs Robert Morris
DESCRIPTION:University of Akron Football vs Robert Morris\\nTV: ESPN+\\n
END:VEVENT
BEGIN:VEVENT
UID:vcal_11324-admin.gozips.com
DTSTART:20260919T160000Z
DTEND:20260919T190000Z
LOCATION:Minneapolis\\, MN
SUMMARY:University of Akron Football at Minnesota
DESCRIPTION:University of Akron Football at Minnesota\\nTV: Big Ten Network\\n
END:VEVENT
BEGIN:VEVENT
UID:vcal_11346-admin.gozips.com
DTSTART;VALUE=DATE:20260925
DTEND;VALUE=DATE:20260926
LOCATION:Akron\\, Ohio\\, James A. Rhodes Arena
SUMMARY:University of Akron Women's Volleyball vs Toledo
DESCRIPTION:University of Akron Women's Volleyball vs Toledo\\n
END:VEVENT
BEGIN:VEVENT
UID:vcal_11330-admin.gozips.com
DTSTART;VALUE=DATE:20261031
DTEND;VALUE=DATE:20261101
LOCATION:Akron\\, Ohio\\, InfoCision Stadium - Summa Health Field
SUMMARY:University of Akron Football vs Week 9 - BYE WEEK
DESCRIPTION:University of Akron Football vs Week 9 - BYE WEEK\\n
END:VEVENT
BEGIN:VEVENT
UID:vcal_11402-admin.gozips.com
DTSTART;VALUE=DATE:20261010
DTEND;VALUE=DATE:20261010
LOCATION:Akron\\, Ohio\\, FirstEnergy Stadium - Cub Cadet Field
SUMMARY:University of Akron Men's Soccer vs Western Michigan
DESCRIPTION:University of Akron Men's Soccer vs Western Michigan\\n
END:VEVENT
BEGIN:VEVENT
UID:vcal_11163-admin.gozips.com
DTSTART:20260514T180000Z
DTEND:20260514T210000Z
LOCATION:Akron\\, Ohio\\, Skeeles Field
SUMMARY:[L] University of Akron Baseball vs Miami (OH)
DESCRIPTION:[L] University of Akron Baseball vs Miami (OH)\\nL 6-17\\n
END:VEVENT
END:VCALENDAR`

const NOW = new Date('2026-06-10T00:00:00Z')
const parseAll = () => parseIcs(FIXTURE).map((ev) => parseZipsGame(ev, NOW)).filter(Boolean)

describe('Zips: helpers', () => {
  it('strips result markers', () => {
    assert.equal(stripResultMarker('[L] University of Akron Baseball vs Miami (OH)'),
      'University of Akron Baseball vs Miami (OH)')
    assert.equal(stripResultMarker('University of Akron Football vs Ohio'),
      'University of Akron Football vs Ohio')
  })
  it('parses venue names from varied LOCATION formats', () => {
    assert.equal(parseVenueName('Akron, Ohio, InfoCision Stadium - Summa Health Field'),
      'InfoCision Stadium - Summa Health Field')
    assert.equal(parseVenueName('Firestone Stadium | Akron, Ohio'), 'Firestone Stadium')
    assert.equal(parseVenueName('Akron, Ohio, James A. Rhodes Arena'), 'James A. Rhodes Arena')
    assert.equal(parseVenueName(''), 'University of Akron')
  })
})

describe('Zips: home-game filtering', () => {
  it('keeps only upcoming home games (drops away, BYE, past)', () => {
    const games = parseAll()
    assert.equal(games.length, 3, `expected 3 games, got ${games.length}: ${games.map(g=>g.title)}`)
  })
  it('excludes away games ("at")', () => {
    assert.ok(!parseAll().some((g) => /Minnesota/.test(g.title)))
  })
  it('excludes BYE weeks', () => {
    assert.ok(!parseAll().some((g) => /bye/i.test(g.title)))
  })
  it('excludes past games', () => {
    assert.ok(!parseAll().some((g) => /Miami/.test(g.title)))
  })
})

describe('Zips: normalization', () => {
  it('normalizes the football title + venue + tags', () => {
    const fb = parseAll().find((g) => g.sport === 'Football')
    assert.ok(fb)
    assert.equal(fb.title, 'Akron Zips Football vs Robert Morris')
    assert.equal(fb.venueName, 'InfoCision Stadium - Summa Health Field')
    assert.equal(fb.sourceId, '11322')
    assert.equal(fb.startAt, '2026-09-12T19:30:00.000Z') // already-UTC DTSTART
    // A timed DTSTART is never touched by the noon default.
    assert.equal(fb.timeSynthesized, false)
    assert.ok(!fb.description.includes(DATE_ONLY_TIME_NOTE))
    assert.ok(fb.tags.includes('sports'))
    assert.ok(fb.tags.includes('football'))
    // 'akron-zips' was intentionally dropped as redundant in 4221ec2
    // ("clean up scraper tagging") — 'zips' + 'university-of-akron' cover it.
    assert.ok(fb.tags.includes('zips'))
    assert.ok(fb.tags.includes('university-of-akron'))
    assert.ok(!fb.tags.includes('akron-zips'))
  })
  it('handles an all-day game and a multi-word sport', () => {
    const vb = parseAll().find((g) => /Volleyball/.test(g.sport))
    assert.ok(vb)
    assert.equal(vb.title, "Akron Zips Women's Volleyball vs Toledo")
    assert.equal(vb.venueName, 'James A. Rhodes Arena')
    assert.ok(vb.tags.includes('womens-volleyball'))
    // SANCTIONED-DEFAULT-TIME: a date-only DTSTART is stored at NOON Eastern
    // (EDT, UTC-4 → 16:00 UTC), not midnight. Midnight fails the feeds'
    // `start_at >= now()` filter on the very morning the game happens.
    assert.equal(vb.startAt, '2026-09-25T16:00:00.000Z')
    assert.equal(vb.timeSynthesized, true)
    // The invented time is disclosed in the prose, never silently.
    assert.ok(vb.description.endsWith(DATE_ONLY_TIME_NOTE))
    // The next-day exclusive DTEND still ends after the noon start, so the
    // inversion guard must not have eaten it.
    assert.equal(vb.endAt, '2026-09-26T04:00:00.000Z')
  })
  it('drops a same-day date-only DTEND that the noon start would invert', () => {
    const sc = parseAll().find((g) => /Soccer/.test(g.sport))
    assert.ok(sc)
    assert.equal(sc.startAt, '2026-10-10T16:00:00.000Z')
    assert.equal(sc.timeSynthesized, true)
    // DTEND was the same date (midnight ET = 04:00 UTC), which now precedes
    // the noon start. An unknown end is honest; a backwards one is not.
    assert.equal(sc.endAt, null)
  })
  it('uses EST, not EDT, for a winter date-only game', () => {
    // Parsed standalone so the home-game count assertion above stays stable.
    const winter = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:vcal_11500-admin.gozips.com
DTSTART;VALUE=DATE:20270116
DTEND;VALUE=DATE:20270117
LOCATION:Akron\\, Ohio\\, James A. Rhodes Arena
SUMMARY:University of Akron Men's Basketball vs Kent State
DESCRIPTION:University of Akron Men's Basketball vs Kent State\\n
END:VEVENT
END:VCALENDAR`
    const [g] = parseIcs(winter).map((ev) => parseZipsGame(ev, NOW)).filter(Boolean)
    assert.ok(g)
    // Noon EST is UTC-5 → 17:00 UTC. A naive local `Date` would drift here.
    assert.equal(g.startAt, '2027-01-16T17:00:00.000Z')
    assert.equal(g.timeSynthesized, true)
  })
})
