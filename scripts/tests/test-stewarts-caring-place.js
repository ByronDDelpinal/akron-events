/**
 * test-stewarts-caring-place.js — pure parsers for the Stewart's Caring Place
 * scraper. Fixtures are trimmed REAL events captured from the live Tribe REST
 * feed on 2026-07-08 (not invented shapes — see the akronym lesson).
 *
 * Run:  node --test scripts/tests/test-stewarts-caring-place.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseCategory, parseRegistrationUrl, buildSourceId, includeEvent, SOURCE_KEY } =
  await import('../scrape-stewarts-caring-place.js')

// Captured 2026-07-08 from /wp-json/tribe/events/v1/events (trimmed to used fields)
const YOGA = {
  id: 10002029,
  title: 'Yoga for Balance &#038; Mobility',
  url: 'https://stewartscaringplace.org/calendar-event/yoga-for-balance-mobility/2026-07-07/',
  start_date: '2026-07-07 09:00:00',
  utc_start_date: '2026-07-07 13:00:00',
  is_virtual: false,
  categories: [{ name: 'Group Fitness &amp; Yoga', slug: 'group-fitness-yoga', id: 46 }],
  venue: { venue: 'Stewart&#8217;s Caring Place', city: 'Fairlawn', address: '3501 Ridge Park Drive', stateprovince: 'OH', zip: '44333' },
  custom_fields: { _ecp_custom_3: { label: 'Registration Link ', value: 'https://secure.qgiv.com/for/fitnessprogramming/event/yoga2026/' } },
}

const CANTON_SUPPORT_GROUP = {
  id: 10001960,
  title: 'Canton Cancer Connect',
  url: 'https://stewartscaringplace.org/calendar-event/canton-cancer-connect/2026-07-07/',
  start_date: '2026-07-07 14:00:00',
  utc_start_date: '2026-07-07 18:00:00',
  is_virtual: false,
  categories: [{ name: 'Support Groups', slug: 'support-groups', id: 48 }],
  venue: { venue: 'Aunt Susie&#8217;s Cancer Wellness Center', city: 'Canton', address: '2813 Whipple Ave NW', stateprovince: 'OH', zip: '44708' },
  custom_fields: { _ecp_custom_3: { label: 'Registration Link ', value: 'https://secure.qgiv.com/for/supgro/event/cantoncancerconnect2026/' } },
}

const MEDITATION = {
  id: 10001946,
  title: 'Guided Meditation',
  url: 'https://stewartscaringplace.org/calendar-event/guided-meditation/2026-07-07/',
  start_date: '2026-07-07 12:00:00',
  utc_start_date: '2026-07-07 16:00:00',
  is_virtual: false,
  categories: [{ name: 'Holistic Care', slug: 'holistic-care', id: 49 }],
  venue: { venue: 'Stewart&#8217;s Caring Place', city: 'Fairlawn' },
  custom_fields: { _ecp_custom_3: { label: 'Registration Link ', value: 'https://secure.qgiv.com/for/holisticcare/event/guidedmeditation2026/' } },
}

describe('includeEvent (Summit gate + virtual)', () => {
  it('keeps Fairlawn sessions', () => {
    assert.equal(includeEvent(YOGA), true)
  })
  it('gates out the Canton (Stark County) satellite sessions', () => {
    assert.equal(includeEvent(CANTON_SUPPORT_GROUP), false)
  })
  it('skips virtual sessions', () => {
    assert.equal(includeEvent({ ...MEDITATION, is_virtual: true }), false)
  })
  it('venue-less events pass (they pin to the Fairlawn HQ)', () => {
    assert.equal(includeEvent({ ...MEDITATION, venue: undefined }), true)
  })
})

describe('parseCategory', () => {
  it('fitness for yoga/group-fitness and holistic care', () => {
    assert.equal(parseCategory(YOGA.categories), 'fitness')
    assert.equal(parseCategory(MEDITATION.categories), 'fitness')
  })
  it('other for support groups', () => {
    assert.equal(parseCategory(CANTON_SUPPORT_GROUP.categories), 'other')
  })
  it('food for cooking/nutrition, learning for workshops', () => {
    assert.equal(parseCategory([{ slug: 'nutrition-cooking' }]), 'food')
    assert.equal(parseCategory([{ slug: 'education-workshops' }]), 'learning')
  })
})

describe('parseRegistrationUrl', () => {
  it('prefers the qgiv registration custom field over the post URL', () => {
    assert.equal(parseRegistrationUrl(YOGA), 'https://secure.qgiv.com/for/fitnessprogramming/event/yoga2026/')
  })
  it('falls back to the post URL when no registration field exists', () => {
    assert.equal(parseRegistrationUrl({ url: 'https://x.test/e/1' }), 'https://x.test/e/1')
  })
  it('ignores non-URL custom field values', () => {
    assert.equal(parseRegistrationUrl({ custom_fields: { _ecp_custom_3: { label: 'Registration Link', value: 'call us' } }, url: 'https://x.test/e/2' }), 'https://x.test/e/2')
  })
})

describe('buildSourceId (recurring occurrences)', () => {
  it('appends the local occurrence date to the Tribe event id', () => {
    assert.equal(buildSourceId(YOGA), '10002029-2026-07-07')
  })
  it('two occurrences of the same series get distinct ids', () => {
    const nextWeek = { ...YOGA, start_date: '2026-07-14 09:00:00' }
    assert.notEqual(buildSourceId(YOGA), buildSourceId(nextWeek))
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'stewarts_caring_place')
  })
})

describe('virtual-venue gate (live-run fix 2026-07-08)', () => {
  // The feed's is_virtual flag is unreliable: real "Virtual Zoom Call"-venue
  // events carry is_virtual:false. The venue NAME must be checked too.
  it('rejects events whose venue is a meeting link, even with is_virtual:false', () => {
    assert.equal(includeEvent({ is_virtual: false, venue: { venue: 'Virtual Zoom Call' } }), false)
    assert.equal(includeEvent({ is_virtual: false, venue: { venue: 'Zoom' } }), false)
    assert.equal(includeEvent({ is_virtual: false, venue: { venue: 'Online via Teams' } }), false)
  })
  it('does not over-match real venue names', () => {
    assert.equal(includeEvent({ is_virtual: false, venue: { venue: "Stewart's Caring Place", city: 'Fairlawn' } }), true)
  })
})
