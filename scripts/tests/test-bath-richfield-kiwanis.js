/**
 * test-bath-richfield-kiwanis.js
 *
 * Covers the Modern Events Calendar (MEC) parser, the broken-timezone date
 * conversion, and the public-event allowlist for Bath Richfield Kiwanis.
 *
 * The fixture (scripts/tests/fixtures/bath-richfield-kiwanis-2026-07.json) is a
 * REAL mec_list_load_month response captured 2026-07-15 — four internal club
 * meetings, which is what the live calendar holds. Public-event assertions use
 * hand-written titles (as the Portage Lakes Kiwanis test does) because the
 * live calendar currently carries no public events to capture.
 *
 * Run:  node --test scripts/tests/test-bath-richfield-kiwanis.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  SOURCE_KEY, parseEvents, mecDateToIso, includeEvent, skipReason,
  parseCategory, parseIsFundraiser, extractCityFromTitle, buildSourceId,
} = await import('../scrape-bath-richfield-kiwanis.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/bath-richfield-kiwanis-2026-07.json'), 'utf8'),
)

describe('parseEvents (real MEC fixture)', () => {
  const events = parseEvents(fixture.html)

  it('pairs every JSON-LD block with its article', () => {
    assert.equal(events.length, 4)
  })
  it('reads the human title from the <h3>, not the stale offers.url slug', () => {
    assert.deepEqual(
      events.map((e) => e.title),
      ['No Meeting', 'General Meeting-with dessert',
       'General Meeting-Community Day prep-with dessert', 'Community Day prep-with dessert'],
    )
  })
  it('captures the stable numeric event id and permalink', () => {
    assert.equal(events[0].eventId, '8771')
    assert.match(events[0].url, /^https:\/\/www\.bathrichfieldkiwanis\.org\/events\//)
  })
  it('carries the raw JSON-LD startDate through', () => {
    assert.equal(events[0].startRaw, '2026-07-16T14:00:00-04:00')
  })
  it('tolerates empty / non-string input', () => {
    assert.deepEqual(parseEvents(''), [])
    assert.deepEqual(parseEvents(null), [])
  })
})

describe('mecDateToIso — broken-timezone conversion (QUIRK 1)', () => {
  it('reads the intended Eastern wall-clock from the UTC components', () => {
    // startDate 14:00-04:00 == 18:00Z; intended time is 6 PM ET. In summer
    // (EDT, -4) 6 PM ET serialises back to 22:00Z.
    assert.equal(mecDateToIso('2026-07-16T14:00:00-04:00'), '2026-07-16T22:00:00.000Z')
  })
  it('handles a standard-time (EST, -5) instant', () => {
    // 13:00-05:00 == 18:00Z -> intended 6 PM ET in winter -> 23:00Z.
    assert.equal(mecDateToIso('2026-12-03T13:00:00-05:00'), '2026-12-03T23:00:00.000Z')
  })
  it('returns null on empty / unparseable input', () => {
    assert.equal(mecDateToIso(null), null)
    assert.equal(mecDateToIso('not a date'), null)
  })
})

describe('includeEvent — public-event allowlist (QUIRK 3)', () => {
  it('ingests real public Kiwanis events', () => {
    assert.equal(includeEvent('Pancake Breakfast'), true)
    assert.equal(includeEvent('Kiwanis Community Day'), true)
    assert.equal(includeEvent('Annual Fish Fry Fundraiser'), true)
    assert.equal(includeEvent('Holiday Craft Show'), true)
    assert.equal(includeEvent('Peanut Day'), true)
    assert.equal(includeEvent('Charity Golf Outing'), true)
  })
  it('skips internal club business by default', () => {
    assert.equal(includeEvent('No Meeting'), false)
    assert.equal(includeEvent('General Meeting-with dessert'), false)
    assert.equal(includeEvent('Board Meeting'), false)
    assert.equal(includeEvent('Officer Installation'), false)
    assert.equal(includeEvent('Interclub'), false)
  })
  it('a prep/meeting marker beats a public-looking word', () => {
    // The live calendar's "…Community Day prep…" is club business, not the event.
    assert.equal(includeEvent('General Meeting-Community Day prep-with dessert'), false)
    assert.equal(includeEvent('Community Day prep-with dessert'), false)
    assert.equal(includeEvent('Pancake Breakfast Planning Meeting'), false)
  })
  it('hard private markers always win', () => {
    assert.equal(includeEvent('Smith Wedding Shower'), false)
    assert.equal(includeEvent('POWELL MEMORIAL'), false)
  })
  it('"Memorial Day" is a holiday, not a private memorial', () => {
    assert.equal(includeEvent('Memorial Day Pancake Breakfast'), true)
  })
  it('gates an explicitly out-of-county city named in the title', () => {
    assert.equal(includeEvent('Pancake Breakfast in Cleveland'), false)
    assert.equal(includeEvent('Pancake Breakfast in Canton'), false)
  })
  it('keeps a Summit city named in the title', () => {
    assert.equal(includeEvent('Richfield Community Day'), true)
    assert.equal(includeEvent('Bath Pancake Breakfast'), true)
  })
})

describe('skipReason labels the buckets', () => {
  it('names the internal-business bucket', () => {
    assert.equal(skipReason('Board Meeting'), 'internal club business (meeting/prep/private)')
  })
  it('names the no-signal bucket', () => {
    assert.equal(skipReason('Regular Programming'), 'no public-event signal (club-calendar default)')
  })
})

describe('parseCategory', () => {
  it('meal fundraisers get the food badge', () => {
    assert.equal(parseCategory('Pancake Breakfast'), 'food')
    assert.equal(parseCategory('Annual Fish Fry'), 'food')
  })
  it('Community Day is a festival', () => {
    assert.equal(parseCategory('Kiwanis Community Day'), 'festival')
  })
  it('falls back to other when nothing infers', () => {
    assert.equal(parseCategory('Reverse Raffle'), 'other')
  })
})

describe('parseIsFundraiser', () => {
  it('flags classic Kiwanis fundraisers', () => {
    assert.equal(parseIsFundraiser('Pancake Breakfast'), true)
    assert.equal(parseIsFundraiser('Charity Golf Outing'), true)
    assert.equal(parseIsFundraiser('Rummage Sale'), true)
  })
  it('is undefined (not false) for a plain community event', () => {
    assert.equal(parseIsFundraiser('Concert in the Park'), undefined)
  })
})

describe('extractCityFromTitle', () => {
  it('finds a Summit city', () => {
    assert.equal(extractCityFromTitle('Richfield Community Day'), 'richfield')
  })
  it('finds an out-of-county city', () => {
    assert.equal(extractCityFromTitle('Fireworks in Canton'), 'canton')
  })
  it('returns null when no city is named', () => {
    assert.equal(extractCityFromTitle('Pancake Breakfast'), null)
  })
})

describe('buildSourceId — stable per occurrence', () => {
  it('uses the numeric MEC event id', () => {
    assert.equal(buildSourceId({ eventId: '8990', url: 'https://x/events/foo/' }), '8990')
  })
  it('falls back to the permalink slug when no id', () => {
    assert.equal(buildSourceId({ url: 'https://x/events/pancake-breakfast/' }), 'pancake-breakfast')
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'bath_richfield_kiwanis')
  })
})
