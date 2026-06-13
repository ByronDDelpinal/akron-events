/**
 * test-category-inference-v2.js
 *
 * Oracle tests for the STAGED Option 6 classifier
 * (scripts/lib/category-inference.v2.draft.js).
 *
 * Each case asserts: the expected content categories are present (order-
 * independent, since multi-category is a set), the category count is within
 * [1,2], and the family/fundraiser facet flags match.
 *
 * Run:  node --test scripts/tests/test-category-inference-v2.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { inferCategories } from '../lib/category-inference.js'

// [title, description, expectedCategories[], { family, fundraiser }]
const ORACLE = [
  // single content category — the art split
  ['Akron Symphony: Beethoven 9', '', ['music'], {}],
  ['Players Guild presents Hamlet', "The Players Guild stages Shakespeare's Hamlet.", ['theater'], {}],
  ['Ohio Shakespeare Festival: Macbeth', '', ['theater', 'festival'], {}],
  ['Documentary Screening at The Nightlight', '', ['film'], {}],
  ['Stand-Up Comedy Night at Killbox', '', ['comedy'], {}],
  ['First Friday Gallery Opening Reception', '', ['visual-art'], {}],
  ['Brewery Tap Takeover', '', ['food'], {}],
  ['RubberDucks vs Erie SeaWolves', '', ['sports'], {}],
  ['Spring Half-Marathon', '', ['fitness'], {}],
  // "marathon" is gated: a media/binge "marathon" is NOT fitness, but a real
  // running marathon still is.
  ['Jaws-A-Thon Movie Marathon', 'A Jaws (1975) movie screening double feature', ['film'], {}],
  ['Akron Marathon', '', ['fitness'], {}],
  ['Guided Hike at Cuyahoga Valley', '', ['outdoors'], {}],
  ['PMP Certification Prep Course', '', ['learning'], {}],
  ['Highland Square Farmers Market', '', ['market'], {}],
  ['Akron City Council Meeting', '', ['civic'], {}],
  ['Independence Day Fireworks Festival', '', ['festival'], {}],
  ['Neighborhood Block Party', '', ['festival'], {}],

  // games & hobbies — tabletop, social, and video gaming
  ['Dungeons & Dragons', 'Players of all experience levels welcome', ['games'], {}],
  ['Trivia Night', '', ['games'], {}],
  ['Magic: The Gathering', '', ['games'], {}],
  ['Play Mahjong', '', ['games'], {}],

  // dance parties / club nights are music (title carries no "music"/"concert")
  ['Circa Pop: 80s Dance Party at the Museum', 'Get into the groove with a live DJ spinning iconic hits', ['music'], {}],
  ['Silent Disco', '', ['music'], {}],

  // multi-category (up to 2)
  ['Summer Music Festival', 'Live bands all weekend', ['music', 'festival'], {}],
  ['Sunday Drag Brunch', '', ['comedy', 'food'], {}],

  // facet: fundraiser (content scored independently)
  ['Benefit Concert for the Food Bank', 'Proceeds support hunger relief', ['music'], { fundraiser: true }],
  ['Annual Charity Gala', 'A fundraiser supporting local youth', ['other'], { fundraiser: true }],

  // facet: family high-bar
  ["Children's Art Workshop", '', ['visual-art'], { family: true }],
  ['Storytime at the Library', '', ['other'], { family: true }],
  ['Family Game Night', '', ['games'], { family: true }],

  // fallback
  ['Community Networking Mixer', 'Meet local folks', ['other'], {}],

  // ── Real-event regressions (found by validating against the live DB) ──
  // Bug: "Stand-Up Paddleboard" must NOT match the comedy "stand-up" signal.
  ['Stand-Up Paddleboard Open House', 'Learn basic paddleboard techniques and take a short paddle', ['fitness'], {}],
  // Library/craft long tail that previously fell to 'other'.
  ['Yarn Crafters Club', 'For anyone who knits, crochets, or embroiders', ['visual-art'], {}],
  ['Color Craze: Adult Coloring', 'Register online, in person, or by phone.', ['visual-art'], {}],
  ['Project Learn GED Classes', 'GED classes at the Kenmore Branch Library', ['learning'], {}],
  ['MarCom Committee Meeting', 'The Marketing & Communications Committee will be meeting', ['civic'], {}],
  ['Magnificent Moths', 'Join a naturalist as we delve into the world of moths', ['outdoors'], {}],
  // Storytime: family facet, content stays 'other' (not flagged for review).
  ['Preschool Storytime', 'Register online, in person, or by phone.', ['other'], { family: true }],
  // Volunteer "service event" → fundraiser facet; content from the text.
  ['Service Event: Park Cleanup', 'Clean up the park and give it a refresh for the community', ['outdoors'], { fundraiser: true }],
  // Bug: an indoor gallery artist talk hosted by a national-park org was tagged
  // outdoors because the venue/org name ("Cuyahoga Valley National Park") in the
  // description matched the bare "park" outdoors keyword. Venue-name nouns now
  // score SOFT and can't ride along beside a decisive visual-art signal.
  ['The Artist Talk | Spirit Wings: Tales Told in Color',
    'Join us for an artist talk to hear from the artists in this exhibition, currently on exhibit at the Boston Gallery. Location: Cuyahoga Valley National Park (CVNP). Gallery parking is available at the Boston Trailhead.',
    ['visual-art'], {}],
  // Guard: a concert at a park-named venue stays music, not music+outdoors.
  ['Summer Concert Series at Hardesty Park', 'Live bands every Friday', ['music'], {}],
]

describe('inferCategories (v2 draft) — oracle', () => {
  for (const [title, desc, expected, flags] of ORACLE) {
    it(`"${title}" → [${expected.join(', ')}]${flags.family ? ' +family' : ''}${flags.fundraiser ? ' +fundraiser' : ''}`, () => {
      const got = inferCategories(title, desc)
      // category count within [1,2]
      assert.ok(got.categories.length >= 1 && got.categories.length <= 2,
        `expected 1-2 categories, got ${JSON.stringify(got.categories)}`)
      // every expected category is present
      for (const cat of expected) {
        assert.ok(got.categories.includes(cat),
          `expected "${cat}" in ${JSON.stringify(got.categories)}`)
      }
      // expected set size matches (no surprise extras)
      assert.equal(got.categories.length, expected.length,
        `category set mismatch: got ${JSON.stringify(got.categories)}, expected ${JSON.stringify(expected)}`)
      // facet flags
      assert.equal(got.family, !!flags.family, `family flag mismatch for "${title}"`)
      assert.equal(got.fundraiser, !!flags.fundraiser, `fundraiser flag mismatch for "${title}"`)
    })
  }
})

describe('inferCategories (v2 draft) — contract', () => {
  it('returns ["other"] and no flags for empty input', () => {
    const got = inferCategories('', '')
    assert.deepEqual(got, { categories: ['other'], family: false, fundraiser: false })
  })

  it('never emits more than 2 categories', () => {
    for (const [t, d] of ORACLE) {
      assert.ok(inferCategories(t, d).categories.length <= 2)
    }
  })
})
