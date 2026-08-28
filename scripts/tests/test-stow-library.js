/**
 * test-stow-library.js — pure parsers for the Stow-Munroe Falls Library
 * (LibCal calendar/list JSON) scraper. Fixtures are trimmed from the real
 * live feed (GET /ajax/calendar/list?c=15865&date=0000-00-00). Network fetch +
 * pagination are integration concerns and aren't unit-tested here.
 *
 * Run:  node --test scripts/tests/test-stow-library.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  mapCategory, isSkippable, parseIsFamily, parseTags, parsePrice,
  resolveVenue, resolveOffsiteVenueFromDescription, shouldDropForGeo,
  buildRow, SOURCE_KEY,
} = await import('../scrape-stow-library.js')
// The real shared constant, not a copy: the digest subtracts this exact string.
const { DATE_ONLY_TIME_NOTE } = await import('../lib/ics.js')

// A real feed object (2- to 5-Year-Old Story Time), trimmed.
const storyTime = {
  id: 15898186,
  title: '2- to 5-Year-Old Story Time',
  description: '<p>Children ages 2&nbsp;- 5&nbsp;and their families can join us for Story Time every Tuesday at 10&nbsp;AM.</p>\n',
  startdt: '2026-07-14 10:00:00',
  enddt: '2026-07-14 10:30:00',
  all_day: false,
  ymd: '20260714',
  url: 'https://events.smfpl.org/event/15898186',
  location: 'Stow-Munroe Falls Room',
  featured_image: 'https://d2jv02qf7xgjwx.cloudfront.net/accounts/302746/images/Story-Time.jpg',
  audiences: [{ id: 4858, name: 'Children - Preschool' }],
  categories_arr: [{ cat_id: 56712, name: 'Story Time' }, { cat_id: 57707, name: 'Summer Reading Event' }],
  registration_cost: '',
  online_event: false,
  recurring_event: true,
}

// Real feed prose (verbatim) from live "Off Site Location" rows.
// id 16482030 — Bookmobile Visit: Munroe Falls. Exactly ONE street address in
// the prose, with the venue named immediately before it.
const bookmobileDescription = '<p>Our Bookmobile is a traveling library, bringing the joy of reading and more right to your neighborhood! With easy access to books, movies, and other materials for all ages &ndash; and best of all, it&rsquo;s completely free &ndash; you can enjoy the library wherever you are.</p>\n\n<p>At the Bookmobile, you can:</p>\n\n<ul>\n\t<li>Sign up for a library card</li>\n\t<li>Browse a variety of books and movies</li>\n\t<li>Check out and return materials</li>\n\t<li>Place holds on your favorite items</li>\n\t<li>Get personalized reading recommendations</li>\n</ul>\n\n<p>The Bookmobile will visit Munroe Falls Center at 9 S. Main St. (the intersection with Munroe Falls Ave.),&nbsp;every Monday.&nbsp;</p>\n\n<p>Don&#39;t miss this convenient way to stay connected to your library!</p>'

// id 17308603 — Read and Recharge: Silent Book Club. TWO distinct street
// addresses (a multi-park fall tour) → ambiguous, must resolve to null.
const silentBookClubDescription = '<p>Tues., September 1, 5 - 6 PM<br />\nSherwood Neighborhood Park&nbsp;<br />\n4344 Foresthill Rd.</p>\n\n<p><br />\nTues., October 6, 5 - 6 PM<br />\nSilver Springs Park, Lakeview Shelter<br />\n4995 Stow Rd.</p>\n\n<p>Free program for all ages&nbsp;<br />\nRead and Recharge&nbsp;on select Tuesday&nbsp;evenings this fall.&nbsp;Join the Bookmobile&nbsp;at City of Stow parks&nbsp;for an hour of reading&nbsp;in the community. In case of inclement weather, we will meet at the Stow Community and Senior Center. To register, call&nbsp;(330) 688-3295, ext. 4, visit events.smfpl.org, or&nbsp;stop by the library.</p>\n'

describe('mapCategory (controlled vocab + title)', () => {
  it('maps program-type names first-match-wins', () => {
    assert.equal(mapCategory(['Story Time', 'Summer Reading Event']), 'learning')
    assert.equal(mapCategory(["Children's Crafts"]), 'visual-art')
    assert.equal(mapCategory(['Book Sale']), 'market')
    assert.equal(mapCategory(['Movie ']), 'film')
    assert.equal(mapCategory(['Book Discussion']), 'learning')
  })
  it('falls back to the title when the category is audience-shaped', () => {
    assert.equal(mapCategory(['Adult Program'], 'Chair Yoga for Seniors'), 'fitness')
    assert.equal(mapCategory(['Adult Program'], 'Watercolor Craft Night'), 'visual-art')
  })
  it('returns null when nothing content-specific matches', () => {
    assert.equal(mapCategory(['Adult Program'], 'Trivia Night'), null)
    assert.equal(mapCategory([], ''), null)
  })
})

describe('isSkippable', () => {
  it('skips internal Board of Trustees meetings', () => {
    assert.equal(isSkippable(['Board of Trustees Meeting'], 'Board of Trustees Meeting'), true)
    assert.equal(isSkippable([], 'Story Time'), false)
  })
  it('skips canceled events (title-prefixed by LibCal)', () => {
    assert.equal(isSkippable([], '(Canceled) Job Seeker Station'), true)
    assert.equal(isSkippable([], '(Cancelled) Book Club'), true)
    assert.equal(isSkippable([], 'Cancel Culture: A Discussion'), false)
  })
  it('skips library closures (published as all-day non-events)', () => {
    assert.equal(isSkippable([], 'Library Closed'), true)
    assert.equal(isSkippable([], 'Library Closed for Staff Training'), true)
    assert.equal(isSkippable([], 'Closed for the Holiday'), true)
    assert.equal(isSkippable([], 'Story Time'), false)
    assert.equal(isSkippable([], 'Adult Craft Night'), false)
  })
})

describe('parseIsFamily (authoritative Audience field)', () => {
  it('true for youth/family/all-ages audiences', () => {
    assert.equal(parseIsFamily(['Children - Preschool']), true)
    assert.equal(parseIsFamily(['Children - School Age']), true)
    assert.equal(parseIsFamily(['Teen']), true)
    assert.equal(parseIsFamily(['All Ages']), true)
  })
  it('undefined (not false) for adult-only', () => {
    assert.equal(parseIsFamily(['Adult']), undefined)
    assert.equal(parseIsFamily([]), undefined)
  })
})

describe('parseTags', () => {
  it('always tags free/library/stow and maps audiences', () => {
    const t = parseTags(['Children - Preschool', 'Adult'])
    assert.ok(t.includes('free') && t.includes('library') && t.includes('stow'))
    assert.ok(t.includes('kids') && t.includes('adults'))
  })
  it('adds online when flagged and dedupes', () => {
    const t = parseTags(['Adult'], true)
    assert.ok(t.includes('online'))
    assert.equal(new Set(t).size, t.length)
  })
})

describe('parsePrice', () => {
  it('empty cost → free (library programs are free)', () => {
    assert.deepEqual(parsePrice(''), { price_min: 0, price_max: null })
    assert.deepEqual(parsePrice(), { price_min: 0, price_max: null })
  })
  it('parses a populated fee', () => {
    assert.deepEqual(parsePrice('$5'), { price_min: 5, price_max: null })
    assert.deepEqual(parsePrice('$5 - $10'), { price_min: 5, price_max: 10 })
  })
})

describe('resolveVenue', () => {
  it('collapses internal room names onto the one library venue', () => {
    assert.equal(resolveVenue('Community Room').name, 'Stow-Munroe Falls Public Library')
    assert.equal(resolveVenue('Pavilion, Stow-Munroe Falls Room').name, 'Stow-Munroe Falls Public Library')
    assert.equal(resolveVenue('Stow-Munroe Falls Room').details.address, '3512 Darrow Rd')
  })
  it('parses a fully-addressed off-site venue', () => {
    const v = resolveVenue('Stow Community and Senior Center, 5344 Fishcreek Rd, Stow, OH 44224')
    assert.equal(v.name, 'Stow Community and Senior Center')
    assert.equal(v.details.address, '5344 Fishcreek Rd')
    assert.equal(v.details.city, 'Stow')
    assert.equal(v.details.state, 'OH')
    assert.equal(v.details.zip, '44224')
  })
  it('parses an off-site venue with only a street address (city defaults to Stow)', () => {
    const v = resolveVenue('Adell Durbin Park, 3300 Darrow Rd')
    assert.equal(v.name, 'Adell Durbin Park')
    assert.equal(v.details.address, '3300 Darrow Rd')
    assert.equal(v.details.city, 'Stow')
  })
  it('returns null for online / off-site-placeholder', () => {
    assert.equal(resolveVenue('Community Room', true), null)
    assert.equal(resolveVenue('', true), null)
    assert.equal(resolveVenue('Off Site Location'), null)
  })
  it('resolves a blank in-person location to the library venue', () => {
    assert.equal(resolveVenue('').name, 'Stow-Munroe Falls Public Library')
    // shouldDropForGeo and the linkOrganizationVenue gate both key off
    // `=== MAIN_VENUE` reference identity, not just the venue's shape.
    assert.equal(resolveVenue(''), resolveVenue('Community Room'))
  })
  it('resolves other falsy locations to the library venue too', () => {
    assert.equal(resolveVenue(null), resolveVenue('Community Room'))
    assert.equal(resolveVenue(undefined), resolveVenue('Community Room'))
    assert.equal(resolveVenue('   '), resolveVenue('Community Room'))
  })
  it('returns null for a blank location tagged an off-site category', () => {
    assert.equal(resolveVenue('', false, ['Off-Site Community Event']), null)
    assert.equal(resolveVenue('   ', false, ['Off-Site Community Event']), null)
    // A non-blank location still wins even if the category also says off-site.
    assert.equal(resolveVenue('Community Room', false, ['Off-Site Community Event']).name, 'Stow-Munroe Falls Public Library')
  })
})

describe('resolveOffsiteVenueFromDescription', () => {
  it('recovers a single prose-named venue (Bookmobile → Munroe Falls Center)', () => {
    const v = resolveOffsiteVenueFromDescription(bookmobileDescription)
    assert.equal(v.name, 'Munroe Falls Center')
    // The one address, entity-folded and trailing-period-normalized.
    assert.equal(v.details.address, '9 S. Main St')
    // "Munroe Falls" in the name/nearby prose beats the Stow default.
    assert.equal(v.details.city, 'Munroe Falls')
    assert.equal(v.details.state, 'OH')
    // No lat/lng — the geocoder owns coordinates.
    assert.equal('lat' in v.details, false)
    assert.equal('lng' in v.details, false)
  })
  it('returns null when the prose lists TWO addresses (Silent Book Club tour)', () => {
    assert.equal(resolveOffsiteVenueFromDescription(silentBookClubDescription), null)
  })
  it('returns null with no address at all', () => {
    assert.equal(resolveOffsiteVenueFromDescription('<p>Join us for reading fun around town!</p>'), null)
    assert.equal(resolveOffsiteVenueFromDescription(''), null)
    assert.equal(resolveOffsiteVenueFromDescription(), null)
  })
  // Review P2: sentence-initial capitals must not mint junk venues.
  it('rejects a lone-token capture (sentence-start word before the address)', () => {
    assert.equal(resolveOffsiteVenueFromDescription('<p>Held at Heritage, 4141 Darrow Rd.</p>'), null)
  })
  it('rejects the bare service-area city as a venue name', () => {
    assert.equal(resolveOffsiteVenueFromDescription('<p>We will gather in Munroe Falls, 9 S. Main St. for the parade.</p>'), null)
  })
  it('rejects a sentence-start verb capture, even multi-token', () => {
    // Single-token verb (the reviewer's exact repro).
    assert.equal(resolveOffsiteVenueFromDescription('<p>Meet at 4141 Darrow Rd.</p>'), null)
    // Multi-token capture that still starts with a verb.
    assert.equal(resolveOffsiteVenueFromDescription('<p>Visit Downtown Stow at 3760 Darrow Rd. with us.</p>'), null)
  })
  it('dedupes a repeated identical address to one and still resolves', () => {
    const v = resolveOffsiteVenueFromDescription(
      '<p>Munroe Falls Center, 9 S. Main St. Enter from the lot behind 9 S. Main St.</p>',
    )
    assert.equal(v.name, 'Munroe Falls Center')
    assert.equal(v.details.address, '9 S. Main St')
    assert.equal(v.details.city, 'Munroe Falls')
  })
})

describe('shouldDropForGeo', () => {
  it('never drops the library or venue-less events', () => {
    assert.equal(shouldDropForGeo(null), false)
    assert.equal(shouldDropForGeo(resolveVenue('Community Room')), false)
  })
  it('drops an explicit known non-Summit city, keeps Summit + unknown', () => {
    assert.equal(shouldDropForGeo({ name: 'X', details: { city: 'Cleveland' } }), true)
    assert.equal(shouldDropForGeo({ name: 'Y', details: { city: 'Stow' } }), false)
    assert.equal(shouldDropForGeo({ name: 'Z', details: { city: undefined } }), false)
  })
})

describe('buildRow', () => {
  it('builds a free, dated, categorized, family row with a stable id', () => {
    const { row, venue } = buildRow(storyTime)
    assert.equal(row.title, '2- to 5-Year-Old Story Time')
    assert.ok(row.start_at.endsWith('Z'))
    // 10:00 ET in July (EDT, UTC-4) → 14:00Z
    assert.equal(row.start_at, '2026-07-14T14:00:00.000Z')
    assert.equal(row.end_at, '2026-07-14T14:30:00.000Z')
    assert.equal(row.category, 'learning')
    assert.equal(row.is_family, true)
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null)
    assert.equal(row.image_url, 'https://d2jv02qf7xgjwx.cloudfront.net/accounts/302746/images/Story-Time.jpg')
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'smfpl_15898186_20260714')
    assert.equal(row.status, 'published')
    assert.equal(venue.name, 'Stow-Munroe Falls Public Library')
  })

  it('handles an all-day event (uses the parsed enddt, never a synthesized time)', () => {
    const { row } = buildRow({
      id: 111, title: 'City-Wide Scavenger Hunt',
      startdt: '2026-07-01 00:00:00', enddt: '2026-08-01 23:59:59',
      all_day: true, ymd: '20260701', url: 'https://events.smfpl.org/event/111',
      location: '', audiences: [{ name: 'All Ages' }], categories_arr: [{ name: 'Contest' }],
      registration_cost: '', online_event: false,
    })
    assert.ok(row.start_at.endsWith('Z'))
    assert.ok(row.end_at.endsWith('Z'))
    assert.equal(row.is_family, true)
    assert.equal(row.source_id, 'smfpl_111_20260701')
  })

  it('flags an all-day event needs_review and defaults it to noon ET', () => {
    // The real LibCal feed never sends a bare date — all-day events arrive as
    // "…  00:00:00" WITH all_day:true, so the missing time must be caught off
    // the authoritative flag, not a clock-in-string regex.
    const { row } = buildRow({
      id: 444, title: 'Library Book Sale', startdt: '2026-07-31 00:00:00',
      all_day: true, ymd: '20260731', url: 'https://events.smfpl.org/event/444',
      location: 'Stow-Munroe Falls Room', audiences: [{ name: 'All Ages' }],
      categories_arr: [{ name: 'Book Sale' }], registration_cost: '', online_event: false,
    })
    // Noon is a default, not a confirmed time: the review queue is its only
    // audit trail, so the flag stays even though the time now looks plausible.
    assert.equal(row.needs_review, true)
    // SANCTIONED-DEFAULT-TIME: the date survives and the clock is noon ET
    // (16:00Z in EDT), NOT the 04:00Z midnight that fell out of every feed at
    // 00:00:01 on the morning of the event.
    assert.equal(row.start_at, '2026-07-31T16:00:00.000Z')
  })

  it('discloses the invented time in the description, exactly once', () => {
    const base = { id: 445, title: 'Seed Swap', startdt: '2026-07-31 00:00:00',
      all_day: true, ymd: '20260731', url: 'https://events.smfpl.org/event/445',
      location: 'Stow-Munroe Falls Room', audiences: [{ name: 'All Ages' }],
      categories_arr: [{ name: 'Contest' }], registration_cost: '', online_event: false }

    const { row } = buildRow({ ...base, description: '<p>Bring seeds, take seeds.</p>' })
    assert.ok(row.description.endsWith(DATE_ONLY_TIME_NOTE), 'note must be the final clause')
    assert.equal(row.description.split(DATE_ONLY_TIME_NOTE).length - 1, 1)

    // A source that already quotes the sentence must not get it twice.
    const { row: quoted } = buildRow({
      ...base, description: `Bring seeds. ${DATE_ONLY_TIME_NOTE}`,
    })
    assert.equal(quoted.description.split(DATE_ONLY_TIME_NOTE).length - 1, 1)

    // No prose = no note. A note-only description would read as a real
    // listing to anything measuring description length.
    assert.equal(buildRow({ ...base, description: '' }).row.description, null)
  })

  it('nulls an all-day end_at that the noon shift would invert', () => {
    // LibCal sends midnight-to-midnight for a same-day all-day row. Left
    // alone, end_at (04:00Z) would now precede start_at (16:00Z).
    const { row } = buildRow({
      id: 446, title: 'Food Drive', startdt: '2026-07-31 00:00:00',
      enddt: '2026-07-31 00:00:00', all_day: true, ymd: '20260731',
      url: 'https://events.smfpl.org/event/446', location: '',
      audiences: [{ name: 'All Ages' }], categories_arr: [{ name: 'Contest' }],
      registration_cost: '', online_event: false,
    })
    assert.equal(row.start_at, '2026-07-31T16:00:00.000Z')
    assert.equal(row.end_at, null)
  })

  it('does NOT touch the description or the clock of a timed row', () => {
    const { row } = buildRow({
      id: 447, title: 'Chess Club', startdt: '2026-07-31 18:00:00',
      enddt: '2026-07-31 19:30:00', all_day: false, ymd: '20260731',
      description: '<p>Boards provided.</p>',
      url: 'https://events.smfpl.org/event/447', location: 'Stow-Munroe Falls Room',
      audiences: [{ name: 'Adult' }], categories_arr: [{ name: 'Club' }],
      registration_cost: '', online_event: false,
    })
    assert.equal(row.start_at, '2026-07-31T22:00:00.000Z')
    assert.equal(row.end_at, '2026-07-31T23:30:00.000Z')
    assert.equal(row.description, 'Boards provided.')
    assert.equal(row.needs_review, undefined)
  })

  it('does NOT force needs_review on a timed, non-all-day startdt', () => {
    const { row } = buildRow({
      id: 555, title: 'Evening Poetry Reading', startdt: '2026-07-31 18:00:00',
      enddt: '2026-07-31 19:30:00', all_day: false, ymd: '20260731',
      url: 'https://events.smfpl.org/event/555', location: 'Stow-Munroe Falls Room',
      audiences: [{ name: 'Adult' }], categories_arr: [{ name: 'Reading' }],
      registration_cost: '', online_event: false,
    })
    assert.equal(row.needs_review, undefined)
    assert.equal(row.start_at, '2026-07-31T22:00:00.000Z')
  })

  it('ingests an online author talk with no venue', () => {
    const { row, venue } = buildRow({
      id: 222, title: 'Online Author Talk: Jane Doe',
      startdt: '2026-08-05 19:00:00', enddt: '2026-08-05 20:00:00',
      all_day: false, ymd: '20260805', url: 'https://events.smfpl.org/event/222',
      location: '', audiences: [{ name: 'Adult' }], categories_arr: [{ name: 'Online Author Talk' }],
      registration_cost: '', online_event: true,
    })
    assert.equal(venue, null)
    assert.equal(row.category, 'learning')
    assert.ok(row.tags.includes('online'))
  })


  it('recovers the prose venue for an in-person "Off Site Location" row', () => {
    const { row, venue } = buildRow({
      id: 16482030, title: 'Bookmobile Visit: Munroe Falls',
      startdt: '2026-08-31 15:30:00', all_day: false, ymd: '20260831',
      url: 'https://events.smfpl.org/event/16482030',
      location: 'Off Site Location', description: bookmobileDescription,
      audiences: [{ name: 'All Ages' }], categories_arr: [{ name: 'Off-Site Community Event' }],
      registration_cost: '', online_event: false,
    })
    assert.equal(venue.name, 'Munroe Falls Center')
    assert.equal(venue.details.city, 'Munroe Falls')
    assert.equal(row.status, 'published')
    // Munroe Falls is in-county: the recovered venue must survive the geo gate.
    assert.equal(shouldDropForGeo(venue), false)
  })

  it('does NOT recover a prose venue for an ONLINE off-site row', () => {
    const { venue } = buildRow({
      id: 16482030, title: 'Bookmobile Visit: Munroe Falls',
      startdt: '2026-08-31 15:30:00', all_day: false, ymd: '20260831',
      url: 'https://events.smfpl.org/event/16482030',
      location: 'Off Site Location', description: bookmobileDescription,
      audiences: [{ name: 'All Ages' }], categories_arr: [],
      registration_cost: '', online_event: true,
    })
    assert.equal(venue, null)
  })

  it('leaves an ambiguous multi-address off-site row venue-less', () => {
    const { venue } = buildRow({
      id: 17308603, title: 'Read and Recharge: Silent Book Club',
      startdt: '2026-09-01 17:00:00', all_day: false, ymd: '20260901',
      url: 'https://events.smfpl.org/event/17308603',
      location: 'Off Site Location', description: silentBookClubDescription,
      audiences: [{ name: 'All Ages' }], categories_arr: [],
      registration_cost: '', online_event: false,
    })
    assert.equal(venue, null)
  })

  it('skips internal Board of Trustees meetings', () => {
    assert.equal(buildRow({
      id: 333, title: 'Board of Trustees Meeting', startdt: '2026-07-20 18:00:00',
      categories_arr: [{ name: 'Board of Trustees Meeting' }], audiences: [], location: 'Conference Room',
    }), null)
  })

  it('returns null when undatable', () => {
    assert.equal(buildRow({ id: 9, title: 'Mystery', startdt: '' }), null)
    assert.equal(buildRow({ id: 9, title: '', startdt: '2026-07-01 10:00:00' }), null)
  })
})
