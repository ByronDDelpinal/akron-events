/**
 * test-barberton-library.js: pure parsers, the run planner and the write path
 * for the Barberton Public Library (LibCal calendar/list JSON) scraper. The
 * shared fetch, pagination and platform shape helpers are covered in
 * test-libcal.js. No test here touches the network or a real database: run()
 * is driven with a stub fetch and a fake Supabase client installed through the
 * supabase-admin test seam (__setClientForTests).
 *
 * Fixture: scripts/tests/fixtures/barberton-library-list.json
 *   Twenty real rows from the live feed
 *   (GET https://events.barbertonlibrary.org/ajax/calendar/list?c=14558
 *   &date=0000-00-00, captured 2026-10-08), inside the real envelope
 *   { total_results, perpage, status, results }. The envelope values are page
 *   1's, so total_results (235) is the live total, not the fixture's row count.
 *
 *   Rows were selected WHOLE, by id, by a script run over the capture; nothing
 *   was typed or trimmed by hand. The script made exactly two privacy edits to
 *   every row and no other change:
 *     org    → "Library Staff"   (the feed names the staff member who owns
 *                                 the calendar entry)
 *     orgurl → "https://events.barbertonlibrary.org/profile/0"
 *   and it refuses to write a fixture if any selected row contains an email
 *   address anywhere. The scraper reads neither field.
 *
 *   What each row is here for:
 *     16909118  timed room event (EDT), one mapped category, Birth to Age 5
 *     16637165  two categories, feed order "Arts & Crafts, Book Club"
 *     16640304  same series, feed order reversed; blank location + prose
 *               venue (White Rabbit Galleries)
 *     16636971  audiences "All Abilities" + "Adult" (not family)
 *     16909307  empty categories_arr; timed "Pumpkin Decorating" (kept)
 *     16630329  one unmapped category (Movies & Music)
 *     16925346  two mapped categories (EST)
 *     16537941  two-room location "Board Room, Spillette Meeting Room"
 *     16636475  blank location, no "meets at" → the library
 *     17346631  blank location + prose venue behind an undecoded entity
 *               ("Kav&eacute; Coffee Bar")
 *     17341927  same series meeting in the Board Room
 *     17323484  timed multi-day book sale, beyond the 180-day horizon
 *     17056178  all-day "Book Club to Go" (passive)
 *     17148102  all-day contest drop-off (passive)
 *     15357221  closure with an empty description
 *     15357239  "Library Closes Early"
 *     15357287  board meeting
 *     16160669  Friends of the Library meeting
 *     16738055  "CANCELED- ..." with a blank location
 *     16636588  "CANCELLED- ..."
 *   No all-day row survives the skip rules in the live feed today, so the
 *   kept-all-day case is DERIVED in-test from 17056178 and labelled as such.
 *   The write-path tests also use DERIVED copies whose dates are moved to the
 *   coming weeks (see inDays), because upsertEventSafe validates start_at
 *   against the real clock and the capture dates will eventually age out.
 *
 * Run:  node --test scripts/tests/test-barberton-library.js
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

// Unconditional, unlike most test files here, and set BEFORE the scraper is
// imported (its `dotenv/config` never overrides a variable that is already
// set). This file drives a write path, so even if a test forgot to install the
// fake client the lazy real one could only ever be built against this dummy
// host, never against whatever credentials the developer's shell or .env hold.
process.env.VITE_SUPABASE_URL         = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

// Belt and braces: nothing below should reach the network. fetch covers the
// feed; http/https cover the image-dimension probe, which uses node's own
// client. A call that gets this far is a test bug and should fail loudly.
const noNetwork = () => { throw new Error('unit test attempted real network access') }
globalThis.fetch = async () => noNetwork()
for (const mod of [http, https]) { mod.request = noNetwork; mod.get = noNetwork }
syncBuiltinESMExports()

const {
  SOURCE_KEY, MAIN_VENUE, CANCEL_FLIP_MAX_ROWS, skipReason, mapCategories, parseIsFamily, parseTags,
  resolveProseVenue, isLibraryRoom, resolveVenue, shouldDropForGeo, buildRow, planRun,
  emptyFeedOutcome, planCancelFlip, run,
} = await import('../scrape-barberton-library.js')
const { libCalNames } = await import('../lib/libcal.js')
const { htmlToText, easternTodayIso, _resetUpsertObservations } = await import('../lib/normalize.js')
const { __setClientForTests } = await import('../lib/supabase-admin.js')
// The real shared constant, not a copy: the digest subtracts this exact string.
const { TIME_NOTE } = await import('../lib/inferred-time.js')
const { CATEGORY_SLUGS } = await import('../../src/lib/categories.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/barberton-library-list.json'), 'utf8'))
const byId = (id) => {
  const row = fixture.results.find((r) => r.id === id)
  assert.ok(row, `fixture row ${id} missing`)
  return row
}
const cats = (id) => libCalNames(byId(id).categories_arr)
const auds = (id) => libCalNames(byId(id).audiences)
/** skipReason for a fixture row, called the way buildRow calls it. */
const reasonFor = (id) => skipReason(byId(id), cats(id), byId(id).title)

// 2026-10-08 2:00pm ET, the afternoon the fixture was captured.
const NOW_MS = Date.parse('2026-10-08T18:00:00Z')

describe('fixture privacy', () => {
  it('carries no staff names, profile ids or email addresses', () => {
    for (const row of fixture.results) {
      assert.equal(row.org, 'Library Staff')
      assert.equal(row.orgurl, 'https://events.barbertonlibrary.org/profile/0')
    }
    assert.doesNotMatch(JSON.stringify(fixture), /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  })
})

describe('constants', () => {
  it('uses the source key and the venue strings already stored', () => {
    assert.equal(SOURCE_KEY, 'barberton_library')
    assert.equal(MAIN_VENUE.name, 'Barberton Public Library')
    assert.equal(MAIN_VENUE.details.address, '602 West Park Avenue')
    assert.equal(MAIN_VENUE.details.city, 'Barberton')
    assert.equal(MAIN_VENUE.details.state, 'OH')
    assert.equal(MAIN_VENUE.details.zip, '44203')
    assert.equal(MAIN_VENUE.details.lat, 41.013477)
    assert.equal(MAIN_VENUE.details.lng, -81.611871)
    // Unverified, so deliberately not asserted by the scraper.
    assert.equal('parking_type' in MAIN_VENUE.details, false)
    assert.equal('parking_notes' in MAIN_VENUE.details, false)
  })
})

describe('skipReason', () => {
  it('canceled: the library prefixes the title', () => {
    assert.equal(reasonFor(16738055), 'canceled')   // "CANCELED- Author Visit: Delsie Moore"
    assert.equal(reasonFor(16636588), 'canceled')   // "CANCELLED- Job & Family Services"
  })
  it('board: by category, or by one of the library\'s own governance titles', () => {
    assert.equal(reasonFor(15357287), 'board')      // "Regular Board Meeting", category Board Meeting
    // The category is the primary signal, whatever the title says.
    assert.equal(skipReason({}, ['Board Meeting'], 'October Session'), 'board')
    // Title fallback, for a governance row that lost its category.
    assert.equal(skipReason({}, [], 'Regular Board Meeting'), 'board')
    assert.equal(skipReason({}, [], 'Special Board Meeting'), 'board')
    assert.equal(skipReason({}, [], 'Board Meeting'), 'board')
    assert.equal(skipReason({}, [], 'Board of Trustees Meeting'), 'board')
    assert.equal(skipReason({}, [], 'Library Board of Trustees Meeting: November'), 'board')
  })
  it('board: a program that merely ends in "Board Meeting" is NOT governance', () => {
    // The fallback is anchored. "Teen Advisory Board" is a real teen program
    // name at many libraries and must not be skipped.
    assert.equal(skipReason({}, ['Community Connections'], 'Teen Advisory Board Meeting'), null)
    assert.equal(skipReason({}, [], 'Teen Advisory Board Meeting'), null)
    assert.equal(skipReason({}, [], 'Friends of the Library Board Meeting Recap Party'), null)
    assert.equal(skipReason({}, [], 'How to Run a Board Meeting'), null)
    // ...unless the library itself files it under governance.
    assert.equal(skipReason({}, ['Board Meeting'], 'Teen Advisory Board Meeting'), 'board')
  })
  it('closure: by category or by title, including "Closes Early"', () => {
    assert.equal(reasonFor(15357221), 'closure')    // "Library Closed"
    assert.equal(reasonFor(15357239), 'closure')    // "Library Closes Early"
    assert.equal(skipReason({}, ['Library Closing'], 'Thanksgiving'), 'closure')
    assert.equal(skipReason({}, [], 'Library Closes Early'), 'closure')
    assert.equal(skipReason({}, [], 'Library Closed'), 'closure')
    assert.equal(skipReason({}, [], 'Library will be closed'), 'closure')
    assert.equal(skipReason({}, [], 'Closed for Staff Training'), 'closure')
  })
  it('friends-admin: the Friends group meetings and donation days', () => {
    assert.equal(reasonFor(16160669), 'friends-admin')   // "Friends of the Library Meeting"
    assert.equal(skipReason({}, ['Friends of the Library'], 'Friends of the Library Donation Day'), 'friends-admin')
  })
  it('passive: "Book Club to Go" and all-day or multi-day contest windows', () => {
    assert.equal(reasonFor(17056178), 'passive')    // "Book Club to Go", all-day
    assert.equal(reasonFor(17148102), 'passive')    // "Pumpkin Decorating Contest Drop-Off", all-day
    // Derived: a contest entry window published as a timed multi-day row.
    assert.equal(skipReason({ all_day: false, multi_day_event: true }, ['Challenges & Contests'], 'Teen Comic Contest'), 'passive')
  })
  it('keeps the Friends of the Library Book Sale (a public market)', () => {
    assert.equal(byId(17323484).title, 'Friends of the Library Book Sale')
    assert.equal(reasonFor(17323484), null)
  })
  it('keeps the timed "Pumpkin Decorating" program', () => {
    assert.equal(byId(16909307).title, 'Pumpkin Decorating')
    assert.equal(reasonFor(16909307), null)
    // Derived: a timed, single-day event in the contest category is something
    // to attend, so it stays.
    assert.equal(skipReason({ all_day: false }, ['Challenges & Contests'], 'Pumpkin Decorating Contest Awards'), null)
  })
  it('keeps ordinary programs and near-miss titles', () => {
    for (const id of [16909118, 16637165, 16636971, 16630329, 16925346, 16537941, 16636475, 16640304, 17346631, 17341927]) {
      assert.equal(reasonFor(id), null, `row ${id} should be kept`)
    }
    assert.equal(skipReason({}, [], 'Cancel Culture: A Discussion'), null)
    assert.equal(skipReason({}, [], 'Board Game Night'), null)
    assert.equal(skipReason({}, [], 'Meet the Friends of the Library Meeting Organizers'), null)
    assert.equal(skipReason({}, [], 'Teen Book Club to Go Bag Decorating'), null)
    assert.equal(skipReason(), null)
  })
  it('checks cancellation first', () => {
    assert.equal(skipReason({}, ['Board Meeting'], 'CANCELED- Regular Board Meeting'), 'canceled')
  })
  it('accounts for every row in the fixture', () => {
    const tally = {}
    for (const row of fixture.results) {
      const reason = skipReason(row, libCalNames(row.categories_arr), row.title) ?? 'kept'
      tally[reason] = (tally[reason] || 0) + 1
    }
    assert.deepEqual(tally, { kept: 12, canceled: 2, board: 1, closure: 2, 'friends-admin': 1, passive: 2 })
  })
})

describe('mapCategories', () => {
  it('maps the controlled vocabulary to valid v2 slugs', () => {
    assert.deepEqual(mapCategories(cats(16909118)), ['learning'])            // Storytime
    assert.deepEqual(mapCategories(cats(16636971)), ['fitness'])             // Health & Wellness
    assert.deepEqual(mapCategories(['Games & Trivia']), ['games'])
    assert.deepEqual(mapCategories(['Food & Cooking']), ['food'])
    assert.deepEqual(mapCategories(['Arts & Crafts']), ['visual-art'])
    assert.deepEqual(mapCategories(['Book Club']), ['learning'])
    assert.deepEqual(mapCategories(['Local History & Genealogy']), ['learning'])
    assert.deepEqual(mapCategories(['Education & Skills']), ['learning'])
    for (const slug of ['learning', 'visual-art', 'games', 'food', 'fitness', 'market']) {
      assert.ok(CATEGORY_SLUGS.includes(slug), `${slug} is not a v2 slug`)
    }
  })
  it('orders by the table, not by the feed (Hooks & Books)', () => {
    // The same series lists its two categories in either order.
    assert.deepEqual(cats(16637165), ['Arts & Crafts', 'Book Club'])
    assert.deepEqual(cats(16640304), ['Book Club', 'Arts & Crafts'])
    assert.deepEqual(mapCategories(cats(16637165)), ['learning', 'visual-art'])
    assert.deepEqual(mapCategories(cats(16640304)), ['learning', 'visual-art'])
  })
  it('maps two different categories (Family Cookie Decorating)', () => {
    assert.deepEqual(mapCategories(cats(16925346), byId(16925346).title), ['visual-art', 'food'])
  })
  it('dedupes slugs and caps at two', () => {
    assert.deepEqual(mapCategories(['Education & Skills', 'Local History & Genealogy']), ['learning'])
    assert.deepEqual(mapCategories(['Food & Cooking', 'Games & Trivia', 'Arts & Crafts', 'Storytime']), ['learning', 'visual-art'])
  })
  it('returns nothing for unmapped or absent categories, so inference decides', () => {
    assert.deepEqual(mapCategories(cats(16909307), byId(16909307).title), [])   // empty categories_arr
    assert.deepEqual(mapCategories(cats(16630329), byId(16630329).title), [])   // Movies & Music
    assert.deepEqual(mapCategories(cats(16636475), byId(16636475).title), [])   // Community Connections
    for (const name of ['Homeschool', 'Special Event', 'Friends of the Library', 'Challenges & Contests']) {
      assert.deepEqual(mapCategories([name], 'Some Program'), [])
    }
    assert.deepEqual(mapCategories(), [])
  })
  it('falls back to market for a book sale only when nothing maps', () => {
    assert.deepEqual(mapCategories(cats(17323484), byId(17323484).title), ['market'])
    assert.deepEqual(mapCategories(['Book Club'], 'Book Sale Preview for Book Clubs'), ['learning'])
  })
  it('ignores case and stray whitespace in a category name', () => {
    assert.deepEqual(mapCategories(['  arts &  crafts ']), ['visual-art'])
  })
})

describe('parseIsFamily (authoritative Audience field)', () => {
  it('true for youth and all-ages audiences', () => {
    assert.equal(parseIsFamily(auds(16909118)), true)          // Birth to Age 5
    assert.equal(parseIsFamily(auds(16630329)), true)          // All Abilities + All Ages
    assert.equal(parseIsFamily(auds(16909307)), true)          // Birth to Age 5 + Grades K - 5 + Grades 6 - 12
    assert.equal(parseIsFamily(['Grades K - 5']), true)
    assert.equal(parseIsFamily(['Grades 6 - 12']), true)
    assert.equal(parseIsFamily(['Adult', 'All Ages']), true)
  })
  it('undefined (never false) otherwise; "All Abilities" is not an age band', () => {
    assert.deepEqual(auds(16636971), ['All Abilities', 'Adult'])
    assert.equal(parseIsFamily(auds(16636971)), undefined)
    assert.equal(parseIsFamily(['Adult']), undefined)
    assert.equal(parseIsFamily(['All Abilities']), undefined)
    assert.equal(parseIsFamily([]), undefined)
    assert.equal(parseIsFamily(), undefined)
  })
})

describe('parseTags', () => {
  it('always tags library + barberton, and free only for an explicit zero price', () => {
    assert.deepEqual(parseTags([], 0), ['library', 'barberton', 'free'])
    assert.deepEqual(parseTags([], 5), ['library', 'barberton'])
    assert.deepEqual(parseTags([], null), ['library', 'barberton'])
    assert.deepEqual(parseTags(), ['library', 'barberton'])
  })
  it('maps each audience', () => {
    assert.deepEqual(parseTags(['Birth to Age 5'], 0), ['library', 'barberton', 'free', 'kids'])
    assert.deepEqual(parseTags(['Grades K - 5'], 0), ['library', 'barberton', 'free', 'kids'])
    assert.deepEqual(parseTags(['Grades 6 - 12'], 0), ['library', 'barberton', 'free', 'teens'])
    assert.deepEqual(parseTags(['Adult'], 0), ['library', 'barberton', 'free', 'adults'])
    assert.deepEqual(parseTags(['All Ages'], 0), ['library', 'barberton', 'free'])
    assert.deepEqual(parseTags(['All Abilities'], 0), ['library', 'barberton', 'free'])
  })
  it('tags an online program', () => {
    assert.deepEqual(parseTags(['Adult'], 0, true), ['library', 'barberton', 'free', 'adults', 'online'])
    assert.deepEqual(parseTags(['Adult'], 0, false), ['library', 'barberton', 'free', 'adults'])
    // Only the feed's literal boolean counts.
    assert.deepEqual(parseTags([], 0, 'true'), ['library', 'barberton', 'free'])
  })
  it('combines audiences without duplicates', () => {
    assert.deepEqual(parseTags(auds(16909307), 0), ['library', 'barberton', 'free', 'kids', 'teens'])
    assert.deepEqual(parseTags(auds(17323484), 0), ['library', 'barberton', 'free', 'kids', 'teens', 'adults'])
    assert.deepEqual(parseTags(auds(16636971), 0), ['library', 'barberton', 'free', 'adults'])
  })
})

describe('resolveProseVenue', () => {
  it('recovers "meets at <Name>, <address>" (White Rabbit Galleries)', () => {
    const v = resolveProseVenue(byId(16640304).description)
    assert.deepEqual(v, {
      name: 'White Rabbit Galleries',
      // Periods stripped: "571 W. Tuscarawas Ave." in the prose.
      details: { address: '571 W Tuscarawas Ave', city: 'Barberton', state: 'OH' },
    })
    // No lat/lng: the geocoder owns coordinates.
    assert.equal('lat' in v.details, false)
    assert.equal('lng' in v.details, false)
  })
  it('does NOT match while the venue name hides behind an undecoded entity', () => {
    // CURRENT BEHAVIOUR, asserted through the real htmlToText. The feed sends
    // "Kav&eacute; Coffee Bar" and the shared decoder (NAMED_ENTITIES in
    // lib/normalize.js) does not know &eacute;, so the name still contains
    // "&eacute;" and the pattern refuses it. Teaching the decoder that entity
    // is a separate, audited change; when it lands, this assertion and the
    // matching resolveVenue/buildRow ones below flip to the Kavé venue.
    const html = byId(17346631).description
    assert.ok(html.includes('meets at Kav&eacute; Coffee Bar, 584 W. Tuscarawas Ave.'))
    assert.ok(htmlToText(html).includes('meets at Kav&eacute; Coffee Bar'), 'decoder now handles &eacute;: update these tests')
    assert.equal(resolveProseVenue(html), null)
  })
  it('matches the same sentence once the text is decoded (the follow-up is a no-op here)', () => {
    assert.deepEqual(
      resolveProseVenue('<p>Afternoon Hooks &amp; Books meets at Kavé Coffee Bar, 584 W. Tuscarawas Ave.</p>'),
      { name: 'Kavé Coffee Bar', details: { address: '584 W Tuscarawas Ave', city: 'Barberton', state: 'OH' } },
    )
  })
  it('returns null without a parseable sentence', () => {
    assert.equal(resolveProseVenue(byId(16636475).description), null)        // no "meets at"
    assert.equal(resolveProseVenue('<p>The club meets at 571 W. Tuscarawas Ave.</p>'), null)   // address, no name
    assert.equal(resolveProseVenue('<p>The club meets at the gallery downtown.</p>'), null)    // name, no address
    assert.equal(resolveProseVenue(''), null)
    assert.equal(resolveProseVenue(), null)
  })
})

describe('isLibraryRoom', () => {
  it('accepts every non-blank location the feed has carried', () => {
    const seen = [...new Set(fixture.results.map((r) => r.location).filter(Boolean))]
    assert.ok(seen.length >= 4, 'fixture should carry several room strings')
    for (const loc of seen) assert.equal(isLibraryRoom(loc), true, `${loc} should be a room`)
    // The full live list (2026-10-08), not just the rows in the fixture.
    for (const loc of [
      "Children's Activity Room", 'Spillette Meeting Room', 'Board Room', 'Teen Room',
      'Study Room 1', 'Board Room, Spillette Meeting Room',
    ]) assert.equal(isLibraryRoom(loc), true, `${loc} should be a room`)
  })
  it('compares case-insensitively and checks each comma-separated part', () => {
    assert.equal(isLibraryRoom('BOARD ROOM'), true)
    assert.equal(isLibraryRoom('  spillette   meeting room '), true)
    assert.equal(isLibraryRoom('Children\u2019s Activity Room'), true)     // curly apostrophe
    assert.equal(isLibraryRoom('Teen Room, Study Room 1'), true)
    // One part that is not a room spoils the whole string.
    assert.equal(isLibraryRoom('Board Room, Lake Anna Park'), false)
  })
  it('accepts a room the library adds later, by the generic pattern', () => {
    for (const loc of ['Local History Room', 'Reference Desk', 'Second Floor', 'Main Lobby', "Children's Area", 'Library Lawn', 'Barberton Public Library']) {
      assert.equal(isLibraryRoom(loc), true, `${loc} should read as library space`)
    }
  })
  it('rejects anything that is not recognizably library space', () => {
    for (const loc of ['Lake Anna Park', 'Virtual', 'Zoom', 'Off Site Location', 'Magic City Brewing', 'Roomful of Blues at the Gazebo', '', '   ', null, undefined]) {
      assert.equal(isLibraryRoom(loc), false, `${JSON.stringify(loc)} should not be a room`)
    }
  })
})

describe('resolveVenue', () => {
  it('0. an online program has no venue and is not a review case (as Stow)', () => {
    assert.deepEqual(resolveVenue('Board Room', '', true), { venue: null, needsReview: false })
    assert.deepEqual(resolveVenue('', byId(16640304).description, true), { venue: null, needsReview: false })
    assert.deepEqual(resolveVenue('Lake Anna Park', '', true), { venue: null, needsReview: false })
    // Only the literal boolean true is "online".
    assert.equal(resolveVenue('Board Room', '', 'true').venue, MAIN_VENUE)
  })
  it('1. an address-shaped location fails closed (no venue, needs review)', () => {
    assert.deepEqual(resolveVenue('Lake Anna YMCA, 500 W Hopocan Ave', ''), { venue: null, needsReview: true })
    // Even when the first part is a room: the string as a whole is an address.
    assert.deepEqual(resolveVenue('Meeting Room, 500 W Hopocan Ave', ''), { venue: null, needsReview: true })
  })
  it('2. a known room is the library', () => {
    assert.equal(byId(16537941).location, 'Board Room, Spillette Meeting Room')
    const r = resolveVenue(byId(16537941).location, byId(16537941).description)
    assert.equal(r.venue, MAIN_VENUE)            // identity: run() keys the org link on it
    assert.equal(r.needsReview, false)
    assert.equal(resolveVenue("Children's Activity Room", '').venue, MAIN_VENUE)
    assert.equal(resolveVenue('Study Room 1', '').venue, MAIN_VENUE)
    assert.equal(resolveVenue('teen room', '').venue, MAIN_VENUE)
    // The same series, when it does book a room, is at the library.
    assert.equal(byId(17341927).location, 'Board Room')
    assert.equal(resolveVenue(byId(17341927).location, byId(17341927).description).venue, MAIN_VENUE)
  })
  it('2. every non-blank location in the fixture resolves to the library', () => {
    for (const row of fixture.results.filter((r) => r.location)) {
      assert.deepEqual(resolveVenue(row.location, row.description), { venue: MAIN_VENUE, needsReview: false }, `row ${row.id}`)
    }
  })
  it('2. an unlisted room resolves by the generic pattern', () => {
    assert.deepEqual(resolveVenue('Local History Room', ''), { venue: MAIN_VENUE, needsReview: false })
    assert.deepEqual(resolveVenue('Library Lawn', ''), { venue: MAIN_VENUE, needsReview: false })
  })
  it('2. a booked room wins even if the prose names another place', () => {
    const r = resolveVenue('Board Room', byId(16640304).description)
    assert.equal(r.venue, MAIN_VENUE)
    assert.equal(r.needsReview, false)
  })
  it('2b. any other non-blank location is NOT asserted as the library', () => {
    assert.deepEqual(resolveVenue('Lake Anna Park', ''), { venue: null, needsReview: true })
    assert.deepEqual(resolveVenue('Virtual', ''), { venue: null, needsReview: true })
    assert.deepEqual(resolveVenue('Board Room, Lake Anna Park', ''), { venue: null, needsReview: true })
    // The prose is not consulted for a non-blank location we cannot place.
    assert.deepEqual(resolveVenue('Downtown', byId(16640304).description), { venue: null, needsReview: true })
  })
  it('3. blank location + parseable prose → the prose venue', () => {
    assert.equal(byId(16640304).location, '')
    const r = resolveVenue(byId(16640304).location, byId(16640304).description)
    assert.equal(r.venue.name, 'White Rabbit Galleries')
    assert.equal(r.venue.details.address, '571 W Tuscarawas Ave')
    assert.notEqual(r.venue, MAIN_VENUE)
    assert.equal(r.needsReview, false)
    assert.equal('lat' in r.venue.details, false)
    assert.equal('lng' in r.venue.details, false)
  })
  it('4. blank location + unparseable "meets at" → no venue, needs review, never the library', () => {
    // The Kavé rows today (see the entity note above).
    assert.equal(byId(17346631).location, '')
    assert.deepEqual(resolveVenue(byId(17346631).location, byId(17346631).description), { venue: null, needsReview: true })
    assert.deepEqual(resolveVenue('', '<p>This month the group meets at a member home.</p>'), { venue: null, needsReview: true })
  })
  it('5. any other blank location → the library', () => {
    assert.equal(byId(16636475).location, '')
    const r = resolveVenue(byId(16636475).location, byId(16636475).description)
    assert.equal(r.venue, MAIN_VENUE)
    assert.equal(r.needsReview, false)
    for (const blank of ['', '   ', null, undefined]) {
      assert.equal(resolveVenue(blank, '<p>Stop by any time.</p>').venue, MAIN_VENUE)
    }
    assert.equal(resolveVenue().venue, MAIN_VENUE)
  })
})

describe('shouldDropForGeo', () => {
  it('never drops the library, a venue-less event or a Barberton prose venue', () => {
    assert.equal(shouldDropForGeo(MAIN_VENUE), false)
    assert.equal(shouldDropForGeo(null), false)
    assert.equal(shouldDropForGeo(resolveProseVenue(byId(16640304).description)), false)
  })
  it('drops an explicit known non-Summit city, keeps Summit + unknown', () => {
    assert.equal(shouldDropForGeo({ name: 'X', details: { city: 'Cleveland' } }), true)
    assert.equal(shouldDropForGeo({ name: 'Y', details: { city: 'Norton' } }), false)
    assert.equal(shouldDropForGeo({ name: 'Z', details: { city: undefined } }), false)
    assert.equal(shouldDropForGeo({ name: 'W' }), false)
  })
})

describe('buildRow', () => {
  it('builds the full row for a timed room event', () => {
    const { row, venue, skip } = buildRow(byId(16909118))
    assert.equal(skip, undefined)
    const { description, ...rest } = row
    assert.deepEqual(rest, {
      title: 'Wee Ones Storytime',
      // 10:30 ET in October (EDT, UTC-4) → 14:30Z
      start_at: '2026-10-08T14:30:00.000Z',
      end_at: '2026-10-08T15:30:00.000Z',
      categories: ['learning'],
      is_family: true,
      tags: ['library', 'barberton', 'free', 'kids'],
      price_min: 0,
      price_max: null,
      age_restriction: 'not_specified',
      image_url: 'https://d2jv02qf7xgjwx.cloudfront.net/customers/6650/images/Wee_Ones_Storytime.jpg',
      ticket_url: 'https://events.barbertonlibrary.org/event/16909118',
      source: 'barberton_library',
      source_id: 'bpl_16909118',
      status: 'published',
      time_inferred: undefined,
      needs_review: undefined,
      featured: false,
    })
    assert.ok(description.startsWith('Enjoy stories, songs, and rhymes'))
    assert.doesNotMatch(description, /<[a-z/]/i)
    assert.doesNotMatch(description, /newsletter/i)             // more_info never leaks in
    assert.equal(description.includes(TIME_NOTE), false)
    assert.equal(venue, MAIN_VENUE)
    // The v2 single-value hint is never sent; `categories` is authoritative.
    assert.equal('category' in row, false)
  })

  it('never features an event and always publishes', () => {
    for (const e of fixture.results) {
      const built = buildRow(e)
      if (built.skip) continue
      assert.equal(built.row.featured, false)
      assert.equal(built.row.status, 'published')
      assert.equal(built.row.source, SOURCE_KEY)
      assert.equal(built.row.source_id, `bpl_${e.id}`)
    }
  })

  it('omits `categories` entirely when nothing maps', () => {
    for (const id of [16909307, 16630329, 16636475, 16537941]) {
      const { row } = buildRow(byId(id))
      assert.equal('categories' in row, false, `row ${id} should leave categories to inference`)
      assert.equal('category' in row, false)
    }
  })

  it('sends the two mapped categories in table order', () => {
    assert.deepEqual(buildRow(byId(16637165)).row.categories, ['learning', 'visual-art'])
    assert.deepEqual(buildRow(byId(16640304)).row.categories, ['learning', 'visual-art'])
    assert.deepEqual(buildRow(byId(16925346)).row.categories, ['visual-art', 'food'])
  })

  it('converts an EST row (1:30pm ET in December = 18:30Z)', () => {
    const { row } = buildRow(byId(16925346))
    assert.equal(row.start_at, '2026-12-19T18:30:00.000Z')
    assert.equal(row.end_at, '2026-12-19T20:30:00.000Z')
    assert.equal(row.is_family, true)
  })

  it('leaves is_family undefined for an adult program', () => {
    const { row } = buildRow(byId(16636971))
    assert.equal(row.is_family, undefined)
    assert.deepEqual(row.tags, ['library', 'barberton', 'free', 'adults'])
  })

  it('attaches the prose venue for a blank-location off-site row', () => {
    const { row, venue } = buildRow(byId(16640304))
    assert.equal(venue.name, 'White Rabbit Galleries')
    assert.equal(venue.details.city, 'Barberton')
    assert.equal(row.needs_review, undefined)
    assert.equal(shouldDropForGeo(venue), false)
  })

  it('leaves the Kavé row venue-less and flagged, still published', () => {
    // Current behaviour while &eacute; is undecoded: see resolveProseVenue.
    const { row, venue } = buildRow(byId(17346631))
    assert.equal(venue, null)
    assert.equal(row.needs_review, true)
    assert.equal(row.status, 'published')
    assert.equal(row.start_at, '2027-01-27T19:00:00.000Z')
  })

  it('keeps the multi-day book sale as a market', () => {
    const { row, venue } = buildRow(byId(17323484))
    assert.deepEqual(row.categories, ['market'])
    assert.equal(row.start_at, '2027-05-21T14:00:00.000Z')
    assert.equal(row.end_at, '2027-05-22T20:00:00.000Z')
    assert.equal(row.needs_review, undefined)
    assert.equal(venue, MAIN_VENUE)
  })

  it('DERIVED: a kept all-day row gets noon ET and time_inferred, nothing hand-rolled', () => {
    // No all-day row survives the skip rules in the live feed today. This is
    // fixture 17056178 ("Book Club to Go", all-day) with only its title
    // changed so the passive rule no longer claims it.
    const derived = { ...byId(17056178), title: 'Community Puzzle Swap' }
    const { row, venue } = buildRow(derived)
    // SANCTIONED-DEFAULT-TIME: noon ET (16:00Z in EDT), not the 04:00Z midnight.
    assert.equal(row.start_at, '2026-10-19T16:00:00.000Z')
    assert.equal(row.end_at, '2026-10-20T03:59:59.000Z')
    // buildRow only says the time was invented. The placeholder-time note and
    // needs_review are applied centrally by upsertEventSafe off this flag
    // (see the run() tests below, which go through the real upsertEventSafe).
    assert.equal(row.time_inferred, true)
    assert.equal(row.needs_review, undefined)
    assert.ok(row.description.length > 0)
    assert.equal(row.description.includes(TIME_NOTE), false)
    assert.equal(row.source_id, 'bpl_17056178')
    assert.equal(venue, MAIN_VENUE)
  })

  it('never sets time_inferred on a timed row', () => {
    for (const e of fixture.results) {
      const built = buildRow(e)
      if (built.skip) continue
      assert.equal(e.all_day, false)
      assert.equal(built.row.time_inferred, undefined, `row ${e.id}`)
    }
  })

  it('DERIVED: an online program is ingested venue-less, tagged, not flagged', () => {
    // No row in the live feed is online today. Fixture 16636971 with only
    // online_event flipped.
    const { row, venue } = buildRow({ ...byId(16636971), online_event: true })
    assert.equal(venue, null)
    assert.equal(row.needs_review, undefined)
    assert.equal(row.status, 'published')
    assert.deepEqual(row.tags, ['library', 'barberton', 'free', 'adults', 'online'])
  })

  it('DERIVED: a location we cannot place is flagged, not sent to the library', () => {
    const { row, venue } = buildRow({ ...byId(16636971), location: 'Lake Anna Park' })
    assert.equal(venue, null)
    assert.equal(row.needs_review, true)
    assert.equal(row.time_inferred, undefined)
  })

  it('returns the source_id with a canceled row so the published copy can be retired', () => {
    assert.deepEqual(buildRow(byId(16738055)), { skip: 'canceled', sourceId: 'bpl_16738055' })
    assert.deepEqual(buildRow(byId(16636588)), { skip: 'canceled', sourceId: 'bpl_16636588' })
  })

  it('returns only the reason for every other skipped row', () => {
    assert.deepEqual(buildRow(byId(15357287)), { skip: 'board' })
    assert.deepEqual(buildRow(byId(15357221)), { skip: 'closure' })
    assert.deepEqual(buildRow(byId(15357239)), { skip: 'closure' })
    assert.deepEqual(buildRow(byId(16160669)), { skip: 'friends-admin' })
    assert.deepEqual(buildRow(byId(17056178)), { skip: 'passive' })
    assert.deepEqual(buildRow(byId(17148102)), { skip: 'passive' })
  })

  it('rejects a row with no id, no title or no parseable start', () => {
    const good = byId(16909118)
    assert.deepEqual(buildRow({ ...good, id: undefined }), { skip: 'invalid' })
    assert.deepEqual(buildRow({ ...good, id: '' }), { skip: 'invalid' })
    assert.deepEqual(buildRow({ ...good, title: '' }), { skip: 'invalid' })
    assert.deepEqual(buildRow({ ...good, title: '<p>&nbsp;</p>' }), { skip: 'invalid' })
    assert.deepEqual(buildRow({ ...good, startdt: '' }), { skip: 'invalid' })
    assert.deepEqual(buildRow({}), { skip: 'invalid' })
    assert.deepEqual(buildRow(), { skip: 'invalid' })
  })

  it('falls back to the canonical event URL when the feed omits one', () => {
    const { row } = buildRow({ ...byId(16909118), url: '' })
    assert.equal(row.ticket_url, 'https://events.barbertonlibrary.org/event/16909118')
  })
})

describe('planRun', () => {
  it('plans the fixture at a fixed clock', () => {
    const plan = planRun(fixture.results, { nowMs: NOW_MS })
    assert.equal(plan.rows.length, 11)
    assert.deepEqual(plan.skipped, {
      canceled: 2, board: 1, closure: 2, 'friends-admin': 1, passive: 2, horizon: 1,
    })
    // Every fixture row is either planned or counted.
    const counted = Object.values(plan.skipped).reduce((a, b) => a + b, 0)
    assert.equal(plan.rows.length + counted, fixture.results.length)
    assert.deepEqual(plan.canceledSourceIds, ['bpl_16738055', 'bpl_16636588'])
  })

  it('drops the book sale 225 days out as beyond the 180-day horizon', () => {
    const plan = planRun(fixture.results, { nowMs: NOW_MS })
    assert.equal(plan.rows.some((r) => r.row.source_id === 'bpl_17323484'), false)
    // Inside the window it is planned like any other row.
    const later = planRun([byId(17323484)], { nowMs: Date.parse('2027-01-15T18:00:00Z') })
    assert.deepEqual(later.rows.map((r) => r.row.source_id), ['bpl_17323484'])
    assert.deepEqual(later.skipped, {})
  })

  it('keeps a row that started earlier today and drops one more than a day old', () => {
    // 16909118 starts 2026-10-08T14:30Z. At NOW_MS it is 3.5 hours old.
    assert.ok(planRun(fixture.results, { nowMs: NOW_MS }).rows.some((r) => r.row.source_id === 'bpl_16909118'))
    const plan = planRun(fixture.results, { nowMs: Date.parse('2026-10-09T15:00:00Z') })
    assert.equal(plan.rows.some((r) => r.row.source_id === 'bpl_16909118'), false)
    assert.equal(plan.skipped.past, 1)
    assert.equal(plan.rows.length, 10)
  })

  it('emits unique source_ids, and drops a repeated row', () => {
    const plan = planRun(fixture.results, { nowMs: NOW_MS })
    const ids = plan.rows.map((r) => r.row.source_id)
    assert.equal(new Set(ids).size, ids.length)
    const doubled = planRun([...fixture.results, byId(16909118)], { nowMs: NOW_MS })
    assert.equal(doubled.rows.length, 11)
    assert.equal(doubled.skipped.duplicate, 1)
  })

  it('carries each venue decision through', () => {
    const plan = planRun(fixture.results, { nowMs: NOW_MS })
    const venueOf = (id) => plan.rows.find((r) => r.row.source_id === `bpl_${id}`).venue
    assert.equal(venueOf(16909118), MAIN_VENUE)
    assert.equal(venueOf(16636475), MAIN_VENUE)
    assert.equal(venueOf(16640304).name, 'White Rabbit Galleries')
    assert.equal(venueOf(17346631), null)
    assert.equal(plan.rows.filter((r) => r.venue === MAIN_VENUE).length, 9)
    assert.equal(plan.rows.filter((r) => r.row.needs_review === true).length, 1)
  })

  it('never plans a midnight-ET start', () => {
    const plan = planRun(fixture.results, { nowMs: NOW_MS })
    for (const { row } of plan.rows) assert.doesNotMatch(row.start_at, /T0[45]:00:00\.000Z$/)
  })

  it('collects a canceled id once, whatever its date', () => {
    const canceled = byId(16738055)
    const plan = planRun([canceled, canceled, { ...byId(16636588), startdt: '2031-01-01 10:00:00' }], { nowMs: NOW_MS })
    assert.deepEqual(plan.rows, [])
    assert.deepEqual(plan.canceledSourceIds, ['bpl_16738055', 'bpl_16636588'])
    assert.deepEqual(plan.skipped, { canceled: 3 })
  })

  it('handles an empty or missing feed', () => {
    assert.deepEqual(planRun([], { nowMs: NOW_MS }), { rows: [], skipped: {}, canceledSourceIds: [] })
    assert.deepEqual(planRun(undefined, { nowMs: NOW_MS }), { rows: [], skipped: {}, canceledSourceIds: [] })
  })
})

describe('planCancelFlip (cancel-on-flip guards)', () => {
  it('retires a published, un-pinned row', () => {
    const row = { id: 'a', source_id: 'bpl_16738055', status: 'published', manual_overrides: null }
    assert.deepEqual(planCancelFlip([row]), { cancel: [row], pinned: 0, overCap: false })
  })
  it('never touches a row whose status an admin pinned', () => {
    const pinned = { id: 'b', source_id: 'bpl_16636588', status: 'published', manual_overrides: { status: { at: 'x', by: 'admin' } } }
    assert.deepEqual(planCancelFlip([pinned]), { cancel: [], pinned: 1, overCap: false })
  })
  it('a pin on another field does not protect status', () => {
    const row = { id: 'c', status: 'published', manual_overrides: { title: { at: 'x', by: 'admin' } } }
    assert.deepEqual(planCancelFlip([row]), { cancel: [row], pinned: 0, overCap: false })
  })
  it('leaves rows that are not published alone', () => {
    const rows = [
      { id: 'd', status: 'cancelled', manual_overrides: null },
      { id: 'e', status: 'pending_review', manual_overrides: null },
      { id: 'f', status: 'cancelled', manual_overrides: { status: { at: 'x', by: 'admin' } } },
    ]
    assert.deepEqual(planCancelFlip(rows), { cancel: [], pinned: 0, overCap: false })
  })
  it('caps on the rows that would CHANGE, not on everything the feed calls canceled', () => {
    assert.equal(CANCEL_FLIP_MAX_ROWS, 25)
    const published = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, status: 'published', manual_overrides: null }))
    const alreadyCancelled = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, status: 'cancelled', manual_overrides: null }))
    const pinned = Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, status: 'published', manual_overrides: { status: {} } }))
    // A long-cancelled weekly series (60 rows already flipped) plus a few new
    // cancellations must not switch the step off.
    assert.equal(planCancelFlip([...alreadyCancelled, ...published(3)]).overCap, false)
    assert.equal(planCancelFlip([...alreadyCancelled, ...published(3)]).cancel.length, 3)
    // Exactly at the cap is allowed; one over is not. Pinned rows do not count.
    assert.equal(planCancelFlip([...published(25), ...pinned]).overCap, false)
    assert.equal(planCancelFlip([...published(26), ...pinned]).overCap, true)
    assert.equal(planCancelFlip([...published(26), ...pinned]).pinned, 10)
  })
  it('handles an empty or missing result', () => {
    assert.deepEqual(planCancelFlip([]), { cancel: [], pinned: 0, overCap: false })
    assert.deepEqual(planCancelFlip(null), { cancel: [], pinned: 0, overCap: false })
    assert.deepEqual(planCancelFlip(), { cancel: [], pinned: 0, overCap: false })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// run(): the write path, against a fake Supabase client
// ════════════════════════════════════════════════════════════════════════════
//
// What is real here: run() itself, planRun/buildRow, and every shared helper
// it calls (ensureOrganization, upsertEventSafe incl. the time_inferred and
// alias handling, ensureVenue, setEventVenue, linkEventOrganization,
// linkOrganizationVenue, logUpsertResult, logScraperError), all talking to the
// fake client below through the supabase-admin seam.
//
// What is stubbed, at the narrowest point available:
//   - the feed: an injected fetchImpl (no HTTP);
//   - image probing: the fake answers the `image_width` column probe with an
//     error, which is how enrichWithImageDimensions learns the columns are
//     absent and returns the row untouched. So image dimensions and the
//     organization fallback photo are NOT exercised here (they are covered in
//     test-normalize.js). http/https are also patched above to throw.
//   - the venue is always "found" by name with a neighborhood and coordinates,
//     so venue minting, the polygon resolver and the geo-gap review flag are
//     not exercised either.
// The fake records every query; it does not emulate Postgres. These tests pin
// WHICH queries are issued and with which filters and payloads, not SQL
// semantics.

const CANCEL_COLS = 'id, title, source_id, status, manual_overrides'
const ORG_ROW = {
  id: 'org-bpl', name: 'Barberton Public Library', website: 'https://www.barbertonlibrary.org',
  description: 'x', image_url: null, address: null, city: null, state: null, zip: null, photos: [], status: 'published',
}

/**
 * Chainable recording fake. Each terminal (await / maybeSingle / single)
 * records { table, op, cols, filters, payload } and answers from `opts`:
 *   existing    { [source_id]: row } for the (source, source_id) lookup
 *   cancelRows  rows the cancel-on-flip SELECT returns
 *   cancelSelect 'throw' | 'error' to break that SELECT
 *   aliasIds    Set of source_ids that were hand-merged away
 */
function makeFakeClient(opts = {}) {
  const { existing = {}, cancelRows = [], cancelSelect = null, aliasIds = new Set() } = opts
  const calls = []
  const respond = (c) => {
    const eq = (col) => c.filters.find((f) => f[0] === 'eq' && f[1] === col)?.[2]
    if (c.table === 'events') {
      if (c.op === 'select' && c.cols === 'image_width') return { data: null, error: { message: 'fake: image columns absent' } }
      if (c.op === 'select' && c.cols === 'id, manual_overrides, title, start_at') return { data: existing[eq('source_id')] ?? null, error: null }
      if (c.op === 'select' && c.cols === CANCEL_COLS) {
        if (cancelSelect === 'throw') throw new Error('simulated cancel-step failure')
        if (cancelSelect === 'error') return { data: null, error: { message: 'simulated cancel query error' } }
        return { data: cancelRows, error: null }
      }
      if (c.op === 'select' && c.cols === 'id') return { data: { id: eq('id') }, error: null }   // alias canonical is alive
      if (c.op === 'upsert') return { data: { id: `ev-${c.payload.source_id}` }, error: null }
      return { data: null, error: null }
    }
    if (c.table === 'event_aliases') {
      return { data: aliasIds.has(eq('duplicate_source_id')) ? { canonical_event_id: 'canon-1' } : null, error: null }
    }
    if (c.table === 'organizations' && c.op === 'select') return { data: ORG_ROW, error: null }
    if (c.table === 'venues' && c.op === 'select') {
      if (c.cols === 'id, neighborhood_slug') return { data: [{ id: `venue:${eq('name')}`, neighborhood_slug: 'fake-slug' }], error: null }
      if (c.cols === 'address, lat, lng') return { data: { address: '1 Fake St', lat: 41, lng: -81 }, error: null }
    }
    return { data: null, error: null }
  }
  const from = (table) => {
    const st = { table, op: 'select', cols: null, filters: [], payload: null }
    const finish = () => {
      const rec = { ...st, filters: [...st.filters] }
      calls.push(rec)
      return Promise.resolve().then(() => respond(rec))
    }
    const filter = (kind) => (col, val) => { st.filters.push([kind, col, val]); return chain }
    const chain = {
      select(cols) { st.cols = cols; return chain },
      insert(payload) { st.op = 'insert'; st.payload = payload; return chain },
      upsert(payload) { st.op = 'upsert'; st.payload = payload; return chain },
      update(payload) { st.op = 'update'; st.payload = payload; return chain },
      delete() { st.op = 'delete'; return chain },
      eq: filter('eq'), neq: filter('neq'), in: filter('in'), is: filter('is'), ilike: filter('ilike'),
      order() { return chain },
      limit() { return chain },
      maybeSingle() { return finish() },
      single() { return finish() },
      then(onFulfilled, onRejected) { return finish().then(onFulfilled, onRejected) },
    }
    return chain
  }
  const of = (table, op) => calls.filter((c) => c.table === table && (!op || c.op === op))
  return { client: { from }, calls, of }
}

/** Stub fetchImpl serving `rows` as one page of the real envelope. */
function feedFetch(rows, { status = 200 } = {}) {
  const requests = []
  const fetchImpl = async (url) => {
    requests.push(String(url))
    const page = Number(new URL(url).searchParams.get('page'))
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return { total_results: rows.length, perpage: 100, status: 1, results: page === 1 ? rows : [] } },
    }
  }
  return { fetchImpl, requests }
}

/**
 * DERIVED copy of a fixture row with its date moved `days` from today
 * (Eastern), clock time kept. upsertEventSafe checks start_at against the real
 * clock, so the write-path tests cannot use the capture's own 2026/2027 dates
 * without eventually failing as "implausibly old".
 */
function inDays(row, days, endDays = days) {
  const day = (n) => easternTodayIso(new Date(Date.now() + n * 86_400_000))
  return {
    ...row,
    startdt: `${day(days)} ${row.startdt.slice(11)}`,
    enddt: row.enddt ? `${day(endDays)} ${row.enddt.slice(11)}` : row.enddt,
  }
}
/** All 20 fixture rows, 2..21 days out (the multi-day sale keeps its 2 days). */
const upcoming = () => fixture.results.map((r, i) => inDays(r, i + 2, r.multi_day_event ? i + 3 : i + 2))
/** The 12 fixture rows that are public events once they are inside the window. */
const KEPT_IDS = [16909118, 16637165, 16636971, 16909307, 16630329, 16925346, 16537941, 16636475, 16640304, 17346631, 17341927, 17323484]
const kept = (n = 0) => inDays(byId(KEPT_IDS[n]), n + 2)
/** `n` DERIVED canceled rows: fixture 16738055 with a fresh id each. */
const canceledRows = (n) => Array.from({ length: n }, (_, i) => inDays({ ...byId(16738055), id: 900000 + i }, i + 2))
const canceledIds = (n) => Array.from({ length: n }, (_, i) => `bpl_${900000 + i}`)

/** Run with console output captured, the fake client installed, then removed. */
async function runWith(t, { client, ...opts }) {
  const logs = { log: [], warn: [], error: [] }
  for (const level of Object.keys(logs)) {
    t.mock.method(console, level, (...args) => { logs[level].push(args.join(' ')) })
  }
  __setClientForTests(client)
  try {
    return { result: await run({ sleep: async () => {}, ...opts }), logs }
  } finally {
    __setClientForTests(null)
  }
}

describe('run(): dry-run never touches the database', () => {
  beforeEach(() => _resetUpsertObservations())

  it('zero client calls on a successful dry-run', async (t) => {
    const fake = makeFakeClient()
    const { fetchImpl, requests } = feedFetch(fixture.results)
    const { result, logs } = await runWith(t, { client: fake.client, dryRun: true, fetchImpl, now: () => NOW_MS })
    assert.equal(fake.calls.length, 0)
    assert.equal(result.exitCode, 0)
    assert.equal(result.status, 'dry-run')
    assert.equal(result.fetched, 20)
    assert.equal(result.planned, 11)
    assert.equal(requests.length, 1)
    // The cap is visible: the log says how far the list reaches, not just N of N.
    assert.ok(logs.log.some((l) => /Fetched 20 of 20 listed events; the list reaches 2027-05-21/.test(l)), logs.log.join('\n'))
    assert.ok(logs.log.some((l) => l.includes('bpl_16738055, bpl_16636588')))
  })

  it('zero client calls when the fetch fails, and exit code 1', async (t) => {
    const fake = makeFakeClient()
    const { fetchImpl } = feedFetch([], { status: 404 })
    const { result, logs } = await runWith(t, { client: fake.client, dryRun: true, fetchImpl })
    assert.equal(fake.calls.length, 0)
    assert.equal(result.exitCode, 1)
    assert.equal(result.status, 'error')
    assert.match(result.error.message, /HTTP 404 fetching LibCal list page 1/)
    assert.ok(logs.error.some((l) => l.includes('not logged to DB')))
  })

  it('zero client calls on an empty feed, recorded as an error outcome with exit code 0', async (t) => {
    const fake = makeFakeClient()
    const { fetchImpl } = feedFetch([])
    const { result } = await runWith(t, { client: fake.client, dryRun: true, fetchImpl })
    assert.equal(fake.calls.length, 0)
    assert.equal(result.exitCode, 0)
    assert.equal(result.status, 'error')
  })
})

describe('run(): failure and empty-feed logging (not dry-run)', () => {
  beforeEach(() => _resetUpsertObservations())

  it('a fetch failure writes one error row to scraper_runs and nothing else', async (t) => {
    const fake = makeFakeClient()
    const { fetchImpl } = feedFetch([], { status: 404 })
    const { result } = await runWith(t, { client: fake.client, fetchImpl })
    assert.equal(result.exitCode, 1)
    assert.equal(fake.calls.length, 1)
    const [log] = fake.of('scraper_runs', 'insert')
    assert.equal(log.payload.scraper_name, 'barberton_library')
    assert.equal(log.payload.status, 'error')
    assert.match(log.payload.error_message, /HTTP 404/)
  })

  it('an empty feed writes one error row (events_found 0) and exits 0', async (t) => {
    const fake = makeFakeClient()
    const { fetchImpl } = feedFetch([])
    const { result } = await runWith(t, { client: fake.client, fetchImpl })
    assert.equal(result.exitCode, 0)
    assert.equal(result.status, 'error')
    assert.equal(fake.calls.length, 1)
    const [log] = fake.of('scraper_runs', 'insert')
    assert.equal(log.payload.status, 'error')
    assert.equal(log.payload.events_found, 0)
    assert.equal(log.payload.error_message, emptyFeedOutcome().errorMessage)
  })
})

describe('run(): a normal run', () => {
  beforeEach(() => _resetUpsertObservations())

  it('upserts every planned row, sets a venue only when there is one, and logs success', async (t) => {
    const fake = makeFakeClient()
    const { fetchImpl } = feedFetch(upcoming())
    const { result, logs } = await runWith(t, { client: fake.client, fetchImpl })

    assert.equal(result.exitCode, 0)
    assert.equal(result.status, 'success')
    assert.equal(result.planned, 12)
    assert.deepEqual([result.inserted, result.updated, result.failed, result.aliasSkipped], [12, 0, 0, 0])
    // Not "no warnings at all": with no MODERATION_TERMS_B64 in the environment
    // (CI) the moderation layer warns once, which is not this scraper's concern.
    assert.equal(logs.warn.some((l) => /Upsert failed|Error on|Cancel-on-flip/.test(l)), false, logs.warn.join('\n'))

    // One upsert per planned row, on (source, source_id), nothing else.
    const upserts = fake.of('events', 'upsert')
    assert.deepEqual(upserts.map((c) => c.payload.source_id).sort(), KEPT_IDS.map((id) => `bpl_${id}`).sort())
    for (const { payload } of upserts) {
      assert.equal(payload.source, 'barberton_library')
      assert.equal(payload.status, 'published')
      assert.equal(payload.featured, false)
      // Transient keys never reach Postgres.
      for (const key of ['time_inferred', 'categories', 'category']) assert.equal(key in payload, false, `${key} leaked`)
    }

    // setEventVenue for the 11 rows with a venue, never for the venue-less one.
    const venueLinks = fake.of('event_venues', 'upsert')
    assert.equal(venueLinks.length, 11)
    assert.equal(fake.of('event_venues', 'delete').length, 11)
    assert.equal(venueLinks.some((c) => c.payload.event_id === 'ev-bpl_17346631'), false)
    assert.equal(fake.calls.some((c) => c.table === 'event_venues' && c.filters.some((f) => f[2] === 'ev-bpl_17346631')), false)
    assert.equal(venueLinks.find((c) => c.payload.event_id === 'ev-bpl_16640304').payload.venue_id, 'venue:White Rabbit Galleries')
    assert.equal(venueLinks.filter((c) => c.payload.venue_id === 'venue:Barberton Public Library').length, 10)

    // The library claims only its own building.
    const claims = fake.of('venues', 'update').filter((c) => 'organization_id' in c.payload)
    assert.equal(claims.length, 1)
    assert.deepEqual(claims[0].filters.find((f) => f[1] === 'id'), ['eq', 'id', 'venue:Barberton Public Library'])

    // Every upserted event is credited to the library.
    assert.equal(fake.of('event_organizations', 'upsert').length, 12)

    // Never a delete on events, and no status write other than cancel-on-flip.
    assert.equal(fake.of('events', 'delete').length, 0)
    assert.equal(fake.of('events', 'update').length, 0)

    const [log] = fake.of('scraper_runs', 'insert')
    assert.equal(fake.of('scraper_runs', 'insert').length, 1)
    assert.equal(log.payload.status, 'success')
    assert.equal(log.payload.events_found, 20)
    assert.equal(log.payload.events_inserted, 12)
    assert.equal(log.payload.events_updated, 0)
    assert.equal(log.payload.events_skipped, 8)
    assert.equal(log.payload.error_message, null)
  })

  it('counts an existing row as updated', async (t) => {
    const fake = makeFakeClient({
      existing: { bpl_16909118: { id: 'ev-old', manual_overrides: null, title: 'Wee Ones Storytime', start_at: new Date().toISOString() } },
    })
    const { fetchImpl } = feedFetch([kept(0), kept(1)])
    const { result } = await runWith(t, { client: fake.client, fetchImpl })
    assert.deepEqual([result.inserted, result.updated], [1, 1])
    const [log] = fake.of('scraper_runs', 'insert')
    assert.deepEqual([log.payload.events_inserted, log.payload.events_updated], [1, 1])
  })

  it('reports a hand-merged duplicate as skipped, not as a failed upsert', async (t) => {
    const fake = makeFakeClient({ aliasIds: new Set(['bpl_16637165']) })
    const { fetchImpl } = feedFetch([kept(0), kept(1)])
    const { result, logs } = await runWith(t, { client: fake.client, fetchImpl })
    assert.deepEqual([result.inserted, result.failed, result.aliasSkipped], [1, 0, 1])
    assert.deepEqual(fake.of('events', 'upsert').map((c) => c.payload.source_id), ['bpl_16909118'])
    assert.equal(logs.warn.some((l) => /Upsert failed/.test(l)), false)
    assert.ok(logs.log.some((l) => /Merged duplicate, not re-created/.test(l)))
  })

  it('discloses our own page cap as a degraded run', async (t) => {
    // A feed that claims 20 one-row pages: the 8-page safety bound truncates it.
    const rows = upcoming()
    const fetchImpl = async (url) => {
      const page = Number(new URL(url).searchParams.get('page'))
      return { ok: true, status: 200, async json() { return { total_results: 20, perpage: 1, status: 1, results: [rows[page - 1]] } } }
    }
    const fake = makeFakeClient()
    const { result } = await runWith(t, { client: fake.client, fetchImpl })
    assert.equal(result.exitCode, 0)
    assert.equal(result.fetched, 8)
    const [log] = fake.of('scraper_runs', 'insert')
    assert.equal(log.payload.status, 'success')
    assert.match(log.payload.error_message, /^degraded: pagination capped, fetched 8 of 20$/)
  })
})

describe('run(): all-day rows go through the shared time_inferred path', () => {
  beforeEach(() => _resetUpsertObservations())

  // DERIVED: fixture 17056178 (all-day) retitled so the passive rule keeps it.
  const allDay = () => inDays({ ...byId(17056178), title: 'Community Puzzle Swap' }, 5)

  it('upsertEventSafe appends the note and sets needs_review; the row arrives at noon ET', async (t) => {
    const fake = makeFakeClient()
    const { fetchImpl } = feedFetch([allDay()])
    const { result } = await runWith(t, { client: fake.client, fetchImpl })
    assert.equal(result.inserted, 1)
    const [{ payload }] = fake.of('events', 'upsert')
    assert.equal(payload.needs_review, true)
    assert.ok(payload.description.endsWith(TIME_NOTE), 'note must be the final clause')
    assert.equal(payload.description.split(TIME_NOTE).length - 1, 1)
    assert.equal('time_inferred' in payload, false)
    // SANCTIONED-DEFAULT-TIME: noon Eastern, whatever the season.
    const etClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(payload.start_at))
    assert.equal(etClock, '12:00')
  })

  it('a human-locked start_at is left alone: no note, no forced review', async (t) => {
    const lockedStart = new Date(Date.now() + 5 * 86_400_000).toISOString()
    const fake = makeFakeClient({
      existing: { bpl_17056178: { id: 'ev-locked', manual_overrides: { start_at: { at: 'x', by: 'admin' } }, title: 'Community Puzzle Swap', start_at: lockedStart } },
    })
    const { fetchImpl } = feedFetch([allDay()])
    const { result } = await runWith(t, { client: fake.client, fetchImpl })
    assert.equal(result.updated, 1)
    const [{ payload }] = fake.of('events', 'upsert')
    assert.equal(payload.description.includes(TIME_NOTE), false)
    assert.equal(payload.needs_review, false)
    // The human's time is what goes back in, not our noon default.
    assert.equal(payload.start_at, lockedStart)
  })
})

describe('run(): cancel-on-flip', () => {
  beforeEach(() => _resetUpsertObservations())

  const published = (sourceId, extra = {}) => ({ id: `row-${sourceId}`, title: 'Canceled program', source_id: sourceId, status: 'published', manual_overrides: null, ...extra })
  const cancelUpdates = (fake) => fake.of('events', 'update').filter((c) => c.payload.status === 'cancelled')

  it('selects by source and the exact canceled source_ids', async (t) => {
    const fake = makeFakeClient()
    const { fetchImpl } = feedFetch(upcoming())
    await runWith(t, { client: fake.client, fetchImpl })
    const selects = fake.of('events', 'select').filter((c) => c.cols === CANCEL_COLS)
    assert.equal(selects.length, 1)
    assert.deepEqual(selects[0].filters, [
      ['eq', 'source', 'barberton_library'],
      ['in', 'source_id', ['bpl_16738055', 'bpl_16636588']],
    ])
    // Nothing published came back, so nothing is written.
    assert.equal(cancelUpdates(fake).length, 0)
  })

  it('issues no cancel query at all when the feed has no canceled titles', async (t) => {
    const fake = makeFakeClient()
    const { fetchImpl } = feedFetch([kept(0)])
    await runWith(t, { client: fake.client, fetchImpl })
    assert.equal(fake.of('events', 'select').filter((c) => c.cols === CANCEL_COLS).length, 0)
  })

  it('updates only published, un-pinned rows, guarded by id, source and status', async (t) => {
    const fake = makeFakeClient({
      cancelRows: [
        published('bpl_16738055'),
        published('bpl_16636588', { manual_overrides: { status: { at: 'x', by: 'admin', reason: 'still on' } } }),
      ],
    })
    const { fetchImpl } = feedFetch(upcoming())
    const { result, logs } = await runWith(t, { client: fake.client, fetchImpl })
    const updates = cancelUpdates(fake)
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].payload, { status: 'cancelled' })
    assert.deepEqual(updates[0].filters, [
      ['eq', 'id', 'row-bpl_16738055'],
      ['eq', 'source', 'barberton_library'],
      ['eq', 'status', 'published'],
    ])
    // The status-pinned row is never written, by any update.
    assert.equal(fake.of('events', 'update').some((c) => c.filters.some((f) => f[2] === 'row-bpl_16636588')), false)
    assert.equal(result.cancelled, 1)
    assert.ok(logs.log.some((l) => /manual_overrides\.status is a human decision/.test(l)))
    const [log] = fake.of('scraper_runs', 'insert')
    assert.equal(log.payload.status, 'success')
    assert.equal(log.payload.error_message, null)
  })

  it('leaves already-cancelled and in-review rows alone', async (t) => {
    const fake = makeFakeClient({
      cancelRows: [published('bpl_16738055', { status: 'cancelled' }), published('bpl_16636588', { status: 'pending_review' })],
    })
    const { fetchImpl } = feedFetch(upcoming())
    const { result } = await runWith(t, { client: fake.client, fetchImpl })
    assert.equal(cancelUpdates(fake).length, 0)
    assert.equal(result.cancelled, 0)
  })

  it('many canceled titles do not trip the cap when few rows would change', async (t) => {
    // 30 canceled titles in the feed, 28 of them flipped on earlier nights.
    const ids = canceledIds(30)
    const fake = makeFakeClient({
      cancelRows: ids.map((id, i) => published(id, { status: i < 2 ? 'published' : 'cancelled' })),
    })
    const { fetchImpl } = feedFetch([kept(0), ...canceledRows(30)])
    const { result } = await runWith(t, { client: fake.client, fetchImpl })
    assert.equal(cancelUpdates(fake).length, 2)
    assert.equal(result.cancelled, 2)
    assert.equal(fake.of('scraper_runs', 'insert')[0].payload.error_message, null)
  })

  it('over the cap: skips the step, keeps the run successful, records a degraded note', async (t) => {
    const ids = canceledIds(26)
    const fake = makeFakeClient({ cancelRows: ids.map((id) => published(id)) })
    const { fetchImpl } = feedFetch([kept(0), ...canceledRows(26)])
    const { result, logs } = await runWith(t, { client: fake.client, fetchImpl })
    assert.equal(cancelUpdates(fake).length, 0)
    assert.equal(result.exitCode, 0)
    assert.equal(result.status, 'success')
    assert.equal(result.inserted, 1)
    const [log] = fake.of('scraper_runs', 'insert')
    assert.equal(log.payload.status, 'success')
    assert.match(log.payload.error_message, /^degraded: cancel-on-flip skipped, 26 published rows over the cap of 25$/)
    assert.ok(logs.warn.some((l) => /Cancel-on-flip SKIPPED/.test(l)))
  })

  it('a thrown cancel step does not fail a completed run', async (t) => {
    const fake = makeFakeClient({ cancelSelect: 'throw' })
    const { fetchImpl } = feedFetch(upcoming())
    const { result } = await runWith(t, { client: fake.client, fetchImpl })
    assert.equal(result.exitCode, 0)
    assert.equal(result.status, 'success')
    assert.equal(result.inserted, 12)
    assert.equal(cancelUpdates(fake).length, 0)
    const logsWritten = fake.of('scraper_runs', 'insert')
    assert.equal(logsWritten.length, 1)
    assert.equal(logsWritten[0].payload.status, 'success')
    assert.equal(logsWritten[0].payload.events_inserted, 12)
    assert.match(logsWritten[0].payload.error_message, /^degraded: cancel-on-flip threw \(simulated cancel-step failure\)$/)
  })

  it('a failed cancel query cancels nothing and is disclosed the same way', async (t) => {
    const fake = makeFakeClient({ cancelSelect: 'error' })
    const { fetchImpl } = feedFetch(upcoming())
    const { result } = await runWith(t, { client: fake.client, fetchImpl })
    assert.equal(result.exitCode, 0)
    assert.equal(cancelUpdates(fake).length, 0)
    const [log] = fake.of('scraper_runs', 'insert')
    assert.equal(log.payload.status, 'success')
    assert.match(log.payload.error_message, /^degraded: cancel-on-flip query failed \(simulated cancel query error\)$/)
  })
})

describe('emptyFeedOutcome', () => {
  it('records an empty library calendar as an error run', () => {
    const outcome = emptyFeedOutcome()
    assert.equal(outcome.status, 'error')
    assert.equal(typeof outcome.errorMessage, 'string')
    assert.ok(outcome.errorMessage.length > 0)
    assert.equal(outcome.reason, outcome.errorMessage)
  })
})
