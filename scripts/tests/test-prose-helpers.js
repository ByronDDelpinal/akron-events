/**
 * test-prose-helpers.js — lib/prose-time.js and lib/prose-venue.js.
 *
 * Both read facts out of sentences, and both are built to DECLINE when the
 * sentence does not settle the question. Most of this file is the declining:
 * a wrong time or a wrong pin is worse than a flagged placeholder.
 *
 * Every positive case is a string a live source carried on 2026-11-18
 * (Summit County Historical Society, Akron-Canton Regional Foodbank).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { proseTime } from '../lib/prose-time.js'
import { findAddressedVenue } from '../lib/prose-venue.js'

describe('proseTime: one stated time', () => {
  it('reads a range whose start has no meridiem', () => {
    assert.deepEqual(
      proseTime('Society members are invited on Saturday, November 21st from 12-3 p.m.'),
      { startTime: '12:00 pm', endTime: '3:00 pm' },
    )
  })

  it('"11-1 p.m." starts in the morning: the start cannot be after the end', () => {
    assert.deepEqual(proseTime('Open 11-1 p.m.'), { startTime: '11:00 am', endTime: '1:00 pm' })
  })

  it('reads a range with both meridiems and minutes', () => {
    assert.deepEqual(proseTime('Join us 10:00 AM - 11:30 AM'), { startTime: '10:00 am', endTime: '11:30 am' })
    assert.deepEqual(proseTime('from 6pm to 8:30pm'), { startTime: '6:00 pm', endTime: '8:30 pm' })
  })

  it('reads a single time', () => {
    assert.deepEqual(proseTime('The lecture is at 7 p.m. in the hall.'), { startTime: '7:00 pm', endTime: null })
  })

  it('the same time said twice is one time', () => {
    assert.deepEqual(proseTime('Concert at 7 p.m. Remember: 7 PM sharp.'), { startTime: '7:00 pm', endTime: null })
  })

  it('a range plus its own start said alone is still the range', () => {
    assert.deepEqual(proseTime('Runs 7-9 p.m. Doors at 7 p.m.'), { startTime: '7:00 pm', endTime: '9:00 pm' })
  })
})

describe('proseTime: an explicit start outranks other times', () => {
  it('"Doors open at 5 p.m. … will start at 6 p.m." is 6 p.m.', () => {
    const text = 'Doors open at 5 p.m. with light refreshments at the City of Joy Enrichment Center. The program will start at 6 p.m. Early bird tickets are available.'
    assert.deepEqual(proseTime(text), { startTime: '6:00 pm', endTime: null })
    // …and the opt-in below must not override an explicit statement.
    assert.deepEqual(proseTime(text, { earliestOfSlots: true }), { startTime: '6:00 pm', endTime: null })
  })

  it('"begins promptly at 7:30pm"', () => {
    assert.deepEqual(proseTime('Seating from 7pm. The show begins promptly at 7:30pm.'), { startTime: '7:30 pm', endTime: null })
  })
})

describe('proseTime: declines when the text does not settle it', () => {
  it('two different times with no stated start', () => {
    assert.equal(proseTime('6:30am Registration begins\n8:00am Race begins at the Foodbank'), null)
  })

  it('a range and an unrelated time', () => {
    assert.equal(proseTime('6PM-8:30PM\n*5PM VIP ACCESS'), null)
  })

  it('no time at all, and numbers that are not times', () => {
    assert.equal(proseTime('Tours available through Saturday, December 19th.'), null)
    assert.equal(proseTime('For ages 5-12. Call 330.535.1120. Room 245. $5-10 at the door.'), null)
    assert.equal(proseTime(''), null)
    assert.equal(proseTime(null), null)
  })

  it('an impossible clock is not a time', () => {
    assert.equal(proseTime('Meet at 13 pm or 7:75 pm'), null)
  })
})

describe('proseTime: earliestOfSlots is opt-in', () => {
  const slots = 'Visit on Wednesdays, Thursdays, Fridays and Saturdays with tours at 1 p.m., 2 p.m. and 3 p.m.'

  it('declines by default', () => {
    assert.equal(proseTime(slots), null)
  })

  it('returns the first slot when asked', () => {
    assert.deepEqual(proseTime(slots, { earliestOfSlots: true }), { startTime: '1:00 pm', endTime: null })
  })

  it('never applies when a range is among them', () => {
    assert.equal(proseTime('6PM-8:30PM\n*5PM VIP ACCESS', { earliestOfSlots: true }), null)
  })
})

describe('findAddressedVenue', () => {
  it('a venue in a sentence: the LAST "at" before the address is the venue', () => {
    assert.deepEqual(
      findAddressedVenue('Doors open at 5 p.m. with light refreshments at the City of Joy Enrichment Center, 610 W. Exchange Street, Akron.'),
      { name: 'City of Joy Enrichment Center', address: '610 W. Exchange Street', city: 'Akron' },
    )
  })

  it('a venue on its own line', () => {
    assert.deepEqual(
      findAddressedVenue('Please join us for a luncheon.\n\nJohn S. Knight Center, 77 E. Mill Street, Akron\n\nRegister today.'),
      { name: 'John S. Knight Center', address: '77 E. Mill Street', city: 'Akron' },
    )
  })

  it('name and address on separate lines, all capitals, with a quadrant', () => {
    assert.deepEqual(
      findAddressedVenue('6PM-8:30PM\n\nOHIO CHRISTMAS FACTORY\n4125 MAHONING ROAD NE, CANTON\n'),
      { name: 'Ohio Christmas Factory', address: '4125 Mahoning Road Ne', city: 'Canton' },
    )
  })

  it('stops the city at "OH" and at a ZIP', () => {
    assert.equal(
      findAddressedVenue('8:00am Race begins at the Akron-Canton Regional Foodbank\n350 Opportunity Pkwy, Akron OH 44307').city,
      'Akron',
    )
    assert.equal(findAddressedVenue('Heritage Hall, 3601 Glenwood Blvd., Reminderville, OH').city, 'Reminderville')
  })

  it('declines without a name, without a street, or without a city', () => {
    assert.equal(findAddressedVenue('Call the Society office at 330.535.1120.'), null)
    assert.equal(findAddressedVenue('Meet at the Perkins Stone Mansion.'), null)
    assert.equal(findAddressedVenue('we gather at 550 Copley Road'), null)
    assert.equal(findAddressedVenue(''), null)
    assert.equal(findAddressedVenue(null), null)
  })

  it('a lower-case fragment before an address is not a venue name', () => {
    assert.equal(findAddressedVenue('please park behind the building, 12 Main Street, Akron'), null)
  })
})
