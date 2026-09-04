/**
 * test-greater-akron-chamber.js — pure parsers for the Greater Akron Chamber
 * scraper (GrowthZone/WebLink JSON API) and its shared platform module,
 * scripts/lib/growthzone.js.
 *
 * Fixtures:
 *   scripts/tests/fixtures/greater-akron-chamber-events.json  — a trimmed
 *     slice of the live 2026-09-01..2027-01-01 Events feed for tenant
 *     AkronOHCOC, chosen to exercise every location/category/skip shape:
 *     the "7 17" GAC event-space aliases, both Ratliff/Business Commons
 *     venue-name spellings, a virtual event, a plain hotel venue, a
 *     venue-less event (blank Venue), and (since none exist live in the
 *     captured window) three hand-built rows in the same shape covering an
 *     IsAllDay event, a members-only event, and a cancelled-title event.
 *   scripts/tests/fixtures/greater-akron-chamber-details.json — matching
 *     Event/{id}/Details bodies (trimmed Descr/Items), plus a hand-built
 *     detail for the synthetic all-day event (EventId 9001).
 *
 * Run:  node --test scripts/tests/test-greater-akron-chamber.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  buildEventsUrl,
  buildDetailUrl,
  fetchGrowthZoneEvents,
  fetchGrowthZoneDetail,
  growthZoneStartIso,
  growthZoneEndIso,
  growthZonePriceRange,
  cleanGrowthZoneDescription,
} = await import('../lib/growthzone.js')

const {
  resolveLocation,
  resolveGeoCity,
  mapCategory,
  toEventRow,
  isChamberCreditedEventType,
  allDayStartIso,
} = await import('../scrape-greater-akron-chamber.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const EVENTS = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/greater-akron-chamber-events.json'), 'utf8'),
).Result
const DETAILS = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/greater-akron-chamber-details.json'), 'utf8'),
)

const byId = (id) => EVENTS.find((e) => e.EventId === id)
const detailById = (id) => DETAILS.find((d) => d.EventId === id)

const GAC_SPACE    = byId(3543)  // 7 17 Event Space at the GAC — alias
const GAC_SPACE_2  = byId(3621)  // 7 17 Credit Union Event Space at GAC — alias
const RATLIFF_1    = byId(3527)  // Ratliff and Company Event Space at the Business Commons
const RATLIFF_2    = byId(3607)  // The Business Commons ... - Ratliff Event Space
const AFTER5       = byId(3583)  // Crave — plain venue
const VIRTUAL      = byId(3629)  // Online - Virtual Event
const MORNING_BUZZ = byId(3497)  // Firestone Country Club — plain venue
const THIRTY_FTF   = byId(3508)  // DoubleTree by Hilton — plain hotel venue, multi-fee sponsor/table set
const BLANK_VENUE  = byId(3556)  // Venue: "" — venue-less
const ALL_DAY      = byId(9001)  // synthesized IsAllDay event
const MEMBERS_ONLY = byId(9002)  // synthesized MembersOnly event
const CANCELLED    = byId(9003)  // synthesized cancelled-title event

describe('buildEventsUrl / buildDetailUrl', () => {
  it('builds the shared GrowthZone Events search URL', () => {
    const url = buildEventsUrl({ searchDateBegin: '2026-09-01T00:00:00.000Z', searchDateEnd: '2027-01-01T00:00:00.000Z' })
    assert.match(url, /api-internal\.weblinkconnect\.com\/api\/Events\?/)
    assert.match(url, /PageSize=0/)
    assert.match(url, /MembersOnlyEvent=true/)
    assert.match(url, /SearchDateBegin=2026-09-01T00%3A00%3A00\.000Z/)
    assert.match(url, /EventClosed=false/)
  })

  it('builds the per-event details URL', () => {
    assert.equal(buildDetailUrl(3543), 'https://api-internal.weblinkconnect.com/api/Event/3543/Details')
  })

  it('URL-encodes a non-numeric event id', () => {
    assert.equal(
      buildDetailUrl('abc/def'),
      'https://api-internal.weblinkconnect.com/api/Event/abc%2Fdef/Details',
    )
  })
})

describe('fetchGrowthZoneEvents / fetchGrowthZoneDetail', () => {
  it('sends the x-tenant header on the list request', async () => {
    let seenHeaders
    const fetchImpl = async (url, opts) => {
      seenHeaders = opts.headers
      return { ok: true, json: async () => ({ Result: [] }) }
    }
    await fetchGrowthZoneEvents({ tenant: 'AkronOHCOC', fetchImpl })
    assert.equal(seenHeaders['x-tenant'], 'AkronOHCOC')
  })

  it('throws without a tenant (the API 500s, not a friendlier error)', async () => {
    await assert.rejects(() => fetchGrowthZoneEvents({ fetchImpl: async () => ({ ok: true, json: async () => ({ Result: [] }) }) }))
    await assert.rejects(() => fetchGrowthZoneDetail(1, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }))
  })

  it('sends the x-tenant header on the detail request', async () => {
    let seenHeaders, seenUrl
    const fetchImpl = async (url, opts) => {
      seenUrl = url
      seenHeaders = opts.headers
      return { ok: true, json: async () => ({ EventId: 3543 }) }
    }
    await fetchGrowthZoneDetail(3543, { tenant: 'AkronOHCOC', fetchImpl })
    assert.equal(seenHeaders['x-tenant'], 'AkronOHCOC')
    assert.match(seenUrl, /\/Event\/3543\/Details$/)
  })

  it('throws a descriptive error on a non-ok response', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500 })
    await assert.rejects(
      () => fetchGrowthZoneEvents({ tenant: 'AkronOHCOC', fetchImpl }),
      /HTTP 500/,
    )
  })
})

describe('growthZoneStartIso / growthZoneEndIso', () => {
  it('parses a UTC timestamp with an explicit Z suffix', () => {
    assert.equal(growthZoneStartIso(GAC_SPACE), '2026-09-02T12:00:00.000Z')
    assert.equal(growthZoneEndIso(GAC_SPACE), '2026-09-02T14:00:00.000Z')
  })

  it('appends Z when the source omits an explicit offset', () => {
    assert.equal(growthZoneStartIso({ StartDateTimeUtc: '2026-09-02T12:00:00' }), '2026-09-02T12:00:00.000Z')
  })

  it('leaves an explicit non-Z offset alone', () => {
    assert.equal(growthZoneStartIso({ StartDateTimeUtc: '2026-09-02T08:00:00-04:00' }), '2026-09-02T12:00:00.000Z')
  })

  it('returns null for a missing/unparseable timestamp', () => {
    assert.equal(growthZoneStartIso({}), null)
    assert.equal(growthZoneStartIso({ StartDateTimeUtc: 'not a date' }), null)
  })
})

describe('growthZonePriceRange', () => {
  it('excludes sponsor/table line items even when public and priced', () => {
    const detail = detailById(3508)
    const { price_min, price_max } = growthZonePriceRange(detail.Items)
    // Only "30 for the Future Individual Ticket" ($45) qualifies; every
    // Presenting/Supporting/Patron Sponsor and Reserved Table tier is excluded.
    assert.equal(price_min, 45)
    assert.equal(price_max, 45)
  })

  it('takes min(MemberPrice) / max(NonMemberPrice) across qualifying tiers', () => {
    const detail = detailById(3583)
    assert.deepEqual(growthZonePriceRange(detail.Items), { price_min: 25, price_max: 35 })
  })

  it('handles member/non-member prices that differ', () => {
    const detail = detailById(9001)
    assert.deepEqual(growthZonePriceRange(detail.Items), { price_min: 600, price_max: 700 })
  })

  it('returns nulls when every item is comp/internal/sponsor (no real admission tier)', () => {
    const detail = detailById(3629)
    assert.deepEqual(growthZonePriceRange(detail.Items), { price_min: null, price_max: null })
  })

  it('returns nulls for an empty/missing item list', () => {
    assert.deepEqual(growthZonePriceRange([]), { price_min: null, price_max: null })
    assert.deepEqual(growthZonePriceRange(undefined), { price_min: null, price_max: null })
  })

  it('excludes a public, member-priced item whose NonMemberPrice is 0 (data glitch, not a real free tier)', () => {
    assert.deepEqual(
      growthZonePriceRange([
        { IsPublic: true, MemberPrice: 20, NonMemberPrice: 0, Descr: 'Registration' },
      ]),
      { price_min: null, price_max: null },
    )
  })

  it('never inverts the range when a discounted member tier is the only qualifying item', () => {
    // price_max is clamped to Math.max(price_min, ...NonMemberPrice) so a
    // member-only discount can never make the displayed range look inverted.
    const { price_min, price_max } = growthZonePriceRange([
      { IsPublic: true, MemberPrice: 40, NonMemberPrice: 10, Descr: 'Registration' },
    ])
    assert.ok(price_max >= price_min)
    assert.equal(price_min, 40)
    assert.equal(price_max, 40)
  })
})

describe('cleanGrowthZoneDescription', () => {
  it('strips HTML and cuts the sponsor-tier boilerplate tail', () => {
    const detail = detailById(3508)
    const text = cleanGrowthZoneDescription(detail.Descr)
    assert.ok(!text.includes('Presenting Sponsor'))
    assert.ok(!text.includes('<img'))
    assert.ok(!text.includes('<p>'))
  })

  it('drops the standing photo/video consent notice', () => {
    const detail = detailById(3607)
    const text = cleanGrowthZoneDescription(detail.Descr)
    assert.ok(!text.toLowerCase().includes('consent to the recording'))
    assert.ok(text.includes('Generations in the Workplace'))
  })

  it('returns null for empty/blank input', () => {
    assert.equal(cleanGrowthZoneDescription(null), null)
    assert.equal(cleanGrowthZoneDescription(''), null)
  })
})

describe('MembersOnly fixture (exercised only by main(), not exported as a pure function)', () => {
  it('carries the raw flag main() uses to skip members-only events before a detail fetch', () => {
    // main()'s skip check is `raw?.MembersOnly === true`, tested here at the
    // fixture level since main() itself isn't a pure export.
    assert.equal(MEMBERS_ONLY.MembersOnly, true)
  })
})

describe('resolveLocation', () => {
  it('folds "7 17 Event Space at the GAC" onto the chamber\'s own venue', () => {
    const loc = resolveLocation(GAC_SPACE)
    assert.equal(loc.venueName, 'Greater Akron Chamber')
    assert.equal(loc.address, '388 S Main St Ste 205')
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.zip, '44311')
    assert.equal(loc.isVirtual, false)
  })

  it('folds the "7 17 Credit Union Event Space at GAC" spelling onto the same venue', () => {
    const loc = resolveLocation(GAC_SPACE_2)
    assert.equal(loc.venueName, 'Greater Akron Chamber')
  })

  it('folds "The Ratliff and Company Event Space at The Business Commons of Cuyahoga Falls" (name only, no details)', () => {
    const loc = resolveLocation(RATLIFF_1)
    assert.equal(loc.venueName, 'The Business Commons of Cuyahoga Falls')
    assert.equal(loc.address, null)
    assert.equal(loc.city, null)
  })

  it('folds "The Business Commons of Cuyahoga Falls - Ratliff Event Space" onto the same venue', () => {
    const loc = resolveLocation(RATLIFF_2)
    assert.equal(loc.venueName, 'The Business Commons of Cuyahoga Falls')
    assert.equal(loc.address, null)
  })

  it('passes a plain venue name straight through with its address', () => {
    const loc = resolveLocation(AFTER5)
    assert.equal(loc.venueName, 'Crave')
    assert.equal(loc.address, '156 South Main St.')
    assert.equal(loc.city, 'Akron')
  })

  it('recognizes a hotel venue with no alias (DoubleTree)', () => {
    const loc = resolveLocation(THIRTY_FTF)
    assert.equal(loc.venueName, 'DoubleTree by Hilton Akron/Fairlawn')
    assert.equal(loc.city, 'Akron')
  })

  it('flags "Online - Virtual Event" as virtual with no venue', () => {
    const loc = resolveLocation(VIRTUAL)
    assert.equal(loc.isVirtual, true)
    assert.equal(loc.venueName, null)
    assert.equal(loc.city, null)
  })

  it('leaves a blank Venue field venue-less with unknown city', () => {
    const loc = resolveLocation(BLANK_VENUE)
    assert.equal(loc.venueName, null)
    assert.equal(loc.city, null)
    assert.equal(loc.isVirtual, false)
  })
})

describe('resolveGeoCity', () => {
  it('prefers the resolved location city', () => {
    assert.equal(resolveGeoCity({ city: 'Akron' }, { City: 'Cuyahoga Falls' }), 'Akron')
  })

  it('falls back to the raw event City when the location has no city (VENUE_ALIASES no-details case)', () => {
    const loc = resolveLocation(RATLIFF_1)
    assert.equal(loc.city, null)
    assert.equal(resolveGeoCity(loc, RATLIFF_1), 'Cuyahoga Falls')
  })

  it('returns null when neither has a city', () => {
    assert.equal(resolveGeoCity({ city: null }, {}), null)
  })
})

describe('isChamberCreditedEventType', () => {
  it('credits the chamber\'s own convened programming', () => {
    assert.equal(isChamberCreditedEventType({ EventType: 'After 5' }), true)
    assert.equal(isChamberCreditedEventType({ EventType: 'Morning Buzz' }), true)
    assert.equal(isChamberCreditedEventType({ EventType: '30 FTF' }), true)
    assert.equal(isChamberCreditedEventType({ EventType: 'NFP' }), true)
    // ACAA webinars are a chamber program, filed under Government Affairs.
    assert.equal(isChamberCreditedEventType(VIRTUAL), true)
  })

  it('does not credit member-hosted or unknown EventTypes', () => {
    assert.equal(isChamberCreditedEventType({ EventType: 'ConxusNEO' }), false)
    assert.equal(isChamberCreditedEventType({ EventType: 'Something Unmapped' }), false)
    assert.equal(isChamberCreditedEventType({}), false)
  })
})

describe('allDayStartIso', () => {
  it('derives the noon-ET placeholder from the detail StartDate when present', () => {
    const detail = detailById(9001)
    assert.equal(allDayStartIso(ALL_DAY, detail), '2026-09-15T16:00:00.000Z')
  })

  it('falls back to the raw list event\'s own StartDate when there is no detail yet (pre-fetch window filter)', () => {
    assert.equal(allDayStartIso(ALL_DAY, null), '2026-09-15T16:00:00.000Z')
  })

  it('still resolves a start when StartDateTimeUtc is null/zeroed, as long as StartDate is present', () => {
    const raw = { ...ALL_DAY, StartDateTimeUtc: null }
    assert.equal(allDayStartIso(raw, null), '2026-09-15T16:00:00.000Z')
  })

  it('returns null when neither raw nor detail carries a StartDate', () => {
    assert.equal(allDayStartIso({}, null), null)
  })

  it('derives the Eastern calendar date from the parsed instant, not a raw UTC slice (2026-12-01T04:30:00Z = 2026-11-30 23:30 ET)', () => {
    // If this ever regressed to a naive .toISOString().slice(0, 10) on the
    // parsed instant, it would still read 2026-12-01 here since that only
    // breaks when the feed's anchor moves off the current 16:00Z convention
    // -- so this asserts against the Eastern-zone formatter path directly by
    // using an instant far from that anchor, which a UTC-based slice would
    // get wrong (Dec 1) versus the correct Eastern calendar day (Nov 30).
    const detail = { StartDate: '2026-12-01T04:30:00Z' }
    // Nov 30 2026 is EST (UTC-5): noon ET == 17:00Z.
    assert.equal(allDayStartIso({}, detail), '2026-11-30T17:00:00.000Z')
  })
})

describe('mapCategory', () => {
  it('maps civic EventTypes', () => {
    assert.equal(mapCategory(GAC_SPACE, GAC_SPACE.EventName, ''), 'civic')       // NFP
    assert.equal(mapCategory(AFTER5, AFTER5.EventName, ''), 'civic')             // After 5
    assert.equal(mapCategory(RATLIFF_2, RATLIFF_2.EventName, ''), 'civic')       // General Membership
    assert.equal(mapCategory(VIRTUAL, VIRTUAL.EventName, ''), 'civic')           // Government Affairs
    assert.equal(mapCategory(THIRTY_FTF, THIRTY_FTF.EventName, ''), 'civic')     // 30 FTF
  })

  it('maps learning EventTypes', () => {
    assert.equal(mapCategory(RATLIFF_1, RATLIFF_1.EventName, ''), 'learning')    // Small Business
    assert.equal(mapCategory(MORNING_BUZZ, MORNING_BUZZ.EventName, ''), 'learning') // Morning Buzz
    assert.equal(mapCategory(GAC_SPACE_2, GAC_SPACE_2.EventName, ''), 'learning')   // ConxusNEO
  })

  it('maps golf outing to sports', () => {
    assert.equal(mapCategory(ALL_DAY, ALL_DAY.EventName, ''), 'sports')
  })

  it('falls back to the title when EventType itself has no signal', () => {
    // "Polymer" (EventType) matches nothing, but the title's "Conference" does.
    assert.equal(mapCategory({ EventType: 'Polymer' }, 'Polymer Cluster Connectivity Conference', ''), 'learning')
  })

  it('returns undefined when nothing in EventType/title/description matches', () => {
    assert.equal(mapCategory({ EventType: 'Something Unmapped' }, 'A Title With No Signal', ''), undefined)
  })

  it('does not scan the description for category signal', () => {
    // "networking" only appears in the description here, not EventType/title
    // — must NOT match CIVIC_TYPE_RE via the descr arm.
    assert.equal(
      mapCategory({ EventType: 'Something Unmapped' }, 'A Title With No Signal', 'Great networking event!'),
      undefined,
    )
  })
})

describe('toEventRow', () => {
  it('produces a published row with a stable source_id and both URLs pointed at the member portal', () => {
    const detail = detailById(3543)
    const row = toEventRow(GAC_SPACE, detail, 'in')
    assert.equal(row.source, 'greater_akron_chamber')
    assert.equal(row.source_id, '3543')
    assert.equal(row.title, 'Non-Profit Leader Dialogue')
    assert.equal(row.status, 'published')
    assert.equal(row.needs_review, undefined)
    assert.equal(row.source_url, 'https://members.greaterakronchamber.org/atlas/events/3543/details')
    assert.equal(row.ticket_url, row.source_url)
    assert.equal(row.featured, false)
    assert.equal(row.category, 'civic')
    assert.equal(row.start_at, '2026-09-02T12:00:00.000Z')
    assert.equal(row.price_min, 15)
    assert.equal(row.price_max, 15)
  })

  it('routes an unknown-geo event to the review queue', () => {
    const detail = detailById(3527)
    const row = toEventRow(RATLIFF_1, detail, 'unknown')
    assert.equal(row.status, 'pending_review')
    assert.equal(row.needs_review, true)
  })

  it('converts an IsAllDay event to a noon-ET placeholder and discloses it', () => {
    const detail = detailById(9001)
    const row = toEventRow(ALL_DAY, detail, 'in')
    // StartDate "2026-09-15T16:00:00Z" → calendar date 2026-09-15 → noon ET
    // (EDT, UTC-4) → 16:00Z.
    assert.equal(row.start_at, '2026-09-15T16:00:00.000Z')
    assert.equal(row.end_at, null)
    assert.match(row.description, /does not include a start time/i)
    assert.equal(row.price_min, 600)
    assert.equal(row.price_max, 700)
  })

  it('returns null for a cancelled/postponed title', () => {
    const detail = detailById(3527)
    assert.equal(toEventRow(CANCELLED, detail, 'in'), null)
  })

  it('returns null when the event has no parseable start time', () => {
    const detail = { ...detailById(3543), StartDateTimeUtc: null }
    assert.equal(toEventRow({ ...GAC_SPACE, StartDateTimeUtc: null }, detail, 'in'), null)
  })

  it('returns null when EventId is missing, non-numeric, zero, or negative', () => {
    const detail = detailById(3543)
    assert.equal(toEventRow({ ...GAC_SPACE, EventId: undefined }, detail, 'in'), null)
    assert.equal(toEventRow({ ...GAC_SPACE, EventId: 'not-an-id' }, detail, 'in'), null)
    assert.equal(toEventRow({ ...GAC_SPACE, EventId: 0 }, detail, 'in'), null)
    assert.equal(toEventRow({ ...GAC_SPACE, EventId: -5 }, detail, 'in'), null)
  })

  it('accepts a numeric-string EventId and normalizes source_id/URLs to the plain integer', () => {
    const detail = detailById(3543)
    const row = toEventRow({ ...GAC_SPACE, EventId: '3543' }, detail, 'in')
    assert.equal(row.source_id, '3543')
    assert.equal(row.source_url, 'https://members.greaterakronchamber.org/atlas/events/3543/details')
  })
})
