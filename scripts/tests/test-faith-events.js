/**test-faith-events.js — the public-event allowlist for church/worship sources*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isPublicFaithEvent, looksLikeFaithOrg } from '../lib/faith-events.js'

describe('isPublicFaithEvent: keeps genuinely public events', () => {
  const yes = [
    'Summer Concert Series on the Lawn',
    'Annual Rummage Sale',
    'Lenten Fish Fry',
    'Vacation Bible School',
    'Community Blood Drive',
    'Craft Fair & Bake Sale',
    'Pancake Breakfast Fundraiser',
    'Trunk-or-Treat',
    'Easter Egg Hunt',
    'Live Nativity',
    '5K for Missions',
    'Spaghetti Dinner Benefit',
    'Holiday Bazaar',
    'Youth Group Car Wash Fundraiser',   // internal group but a public fundraiser → keep
    'Food Pantry Distribution',
  ]
  for (const t of yes) {
    it(`keeps "${t}"`, () => assert.equal(isPublicFaithEvent(t), true))
  }
  it('finds the signal in the description too', () => {
    assert.equal(isPublicFaithEvent('Join Us', 'A free community concert in the park.'), true)
  })
})

describe('isPublicFaithEvent: skips internal congregational events', () => {
  const no = [
    'Sunday Worship Service',
    'Wednesday Bible Study',
    "Men's Prayer Breakfast",     // "breakfast" is NOT a bare signal
    'Youth Group',
    'Choir Rehearsal',
    'Small Group Meeting',
    'Board Meeting',
    "Women's Ministry",
    'Adoration & Confession',
    'Movie Night',
    'Potluck Fellowship',
    'Sunday School',
    'Evening Vespers',
  ]
  for (const t of no) {
    it(`skips "${t}"`, () => assert.equal(isPublicFaithEvent(t), false))
  }
})

describe('looksLikeFaithOrg', () => {
  it('flags places of worship', () => {
    assert.equal(looksLikeFaithOrg('Grace Church - Bath'), true)
    assert.equal(looksLikeFaithOrg('St. Hilary Parish'), true)
    assert.equal(looksLikeFaithOrg('Rosh Pinah Congregation'), true)
    assert.equal(looksLikeFaithOrg('Messiah Lutheran'), true)
  })
  it('does not flag secular orgs', () => {
    assert.equal(looksLikeFaithOrg('Akron Civic Theatre'), false)
    assert.equal(looksLikeFaithOrg('Summit Metro Parks'), false)
    assert.equal(looksLikeFaithOrg(null), false)
  })
})
