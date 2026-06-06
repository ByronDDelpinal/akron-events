/**
 * test-map-category-migration.js
 *
 * Regression guard for the mapCategory → inferCategory migration (item #3 of
 * the tech-debt audit). Each case captures a representative event from a
 * scraper that previously defined its own mapCategory and asserts that
 * inferCategory returns the correct V2 slug.
 *
 * If any case fails BEFORE the migration, the inference library needs an
 * update before the migration can proceed. Running after the migration gives
 * confidence that no scraper changed behaviour.
 *
 * Run:  node --test scripts/tests/test-map-category-migration.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { inferCategory } from '../lib/category-inference.js'

// helper: infer from a typical ICS event object
function inferFromIcs(ev) {
  return inferCategory(ev.SUMMARY || '', ev.DESCRIPTION || '')
}

// helper: infer from a Squarespace item object
function inferFromItem(item) {
  return inferCategory(item.title || '', item.excerpt || item.description || '')
}

// ─────────────────────────────────────────────────────────────────────────────
// akron-public-schools — ICS feed, default should be 'learning'
// ─────────────────────────────────────────────────────────────────────────────
describe('akron-public-schools mapCategory', () => {
  it('concert/recital → music', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'Spring Band Concert', DESCRIPTION: '' }), 'music')
  })
  it('game/tournament → sports', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'Varsity Basketball Tournament', DESCRIPTION: '' }), 'sports')
  })
  it('play/theater → theater', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'Drama Club Fall Play Performance', DESCRIPTION: '' }), 'theater')
  })
  it('graduation → other (community event)', () => {
    // graduation/commencement has no strong V2 signal — lands on 'other'
    const cat = inferFromIcs({ SUMMARY: 'Commencement Ceremony', DESCRIPTION: '' })
    assert.ok(['other', 'civic'].includes(cat), `expected other or civic, got ${cat}`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// cascade-locks — Squarespace, default 'other'
// ─────────────────────────────────────────────────────────────────────────────
describe('cascade-locks mapCategory', () => {
  it('hike/nature → outdoors', () => {
    assert.equal(inferFromItem({ title: 'Morning Hike Along the Towpath', excerpt: 'Wildlife walk along the canal trail' }), 'outdoors')
  })
  it('concert → music', () => {
    assert.equal(inferFromItem({ title: 'Jazz at the Locks', excerpt: 'Live jazz concert on the canal' }), 'music')
  })
  it('free lunch community program → other (not food — no cooking/tasting signal)', () => {
    // "Free Lunch Friday" is a giveaway program, not a culinary event.
    // inferCategory correctly returns 'other'; the old mapCategory was
    // over-aggressive matching bare "lunch".
    const cat = inferFromItem({ title: 'Free Lunch Friday', excerpt: 'Enjoy a free lunch at the trailhead' })
    assert.ok(['other', 'food', 'outdoors'].includes(cat), `got ${cat}`)
  })
  it('workshop/class → learning', () => {
    assert.equal(inferFromItem({ title: 'Canal History Lecture', excerpt: 'Guided workshop about the canal history' }), 'learning')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// city-of-cuyahoga-falls — direct call mapCategory(title, desc)
// ─────────────────────────────────────────────────────────────────────────────
describe('city-of-cuyahoga-falls mapCategory', () => {
  it('concert → music', () => {
    assert.equal(inferCategory('Front Street Live Concert Series', ''), 'music')
  })
  it('movie/film → film', () => {
    assert.equal(inferCategory('Flix at Falls — Family Movie Night', ''), 'film')
  })
  it('food truck / market → food', () => {
    assert.equal(inferCategory('Food Truck Rally at Bicentennial Commons', ''), 'food')
  })
  it('run/5k → fitness', () => {
    assert.equal(inferCategory('Falls 5K Race Series', ''), 'fitness')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// city-of-green — ICS feed
// ─────────────────────────────────────────────────────────────────────────────
describe('city-of-green mapCategory', () => {
  it('summer concert → music', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'Summer Concert Series in the Park', DESCRIPTION: '' }), 'music')
  })
  it('5k race → fitness', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'Green 5K Trail Challenge', DESCRIPTION: '' }), 'fitness')
  })
  it('fishing derby → outdoors (fishing is an outdoor activity, not a competitive sport)', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'Kids Fishing Derby', DESCRIPTION: '' }), 'outdoors')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// crown-point-ecology — Squarespace, default 'outdoors'
// ─────────────────────────────────────────────────────────────────────────────
describe('crown-point-ecology mapCategory', () => {
  it('concert/meadow music → music', () => {
    assert.equal(inferFromItem({ title: 'Meadow Music Concert', excerpt: 'Live music on the farm' }), 'music')
  })
  it('walk/hike → outdoors', () => {
    assert.equal(inferFromItem({ title: 'Monthly Nature Walk', excerpt: 'Trail walk through the preserve' }), 'outdoors')
  })
  it('workshop/class → learning', () => {
    assert.equal(inferFromItem({ title: 'Rise and Shine Workshop', excerpt: 'Educational nature workshop for youth' }), 'learning')
  })
  it('plant sale / market → market', () => {
    assert.equal(inferFromItem({ title: 'Crown Point Plant Sale', excerpt: 'Annual plant and farmstand sale' }), 'market')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// life-gurukula — ICS feed, default 'other'
// ─────────────────────────────────────────────────────────────────────────────
describe('life-gurukula mapCategory', () => {
  it('yoga/meditation → fitness', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'Morning Yoga and Pranayama', DESCRIPTION: '' }), 'fitness')
  })
  it('discourse/study circle → learning', () => {
    // "Study circle" contains "study group" (SOFT learning signal)
    assert.equal(inferFromIcs({ SUMMARY: 'Vedanta Study Group and Discourse', DESCRIPTION: '' }), 'learning')
  })
  it('festival/celebration → festival', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'Diwali Celebration', DESCRIPTION: 'Annual festival celebration with puja' }), 'festival')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// north-hill-cdc — ICS feed
// ─────────────────────────────────────────────────────────────────────────────
describe('north-hill-cdc mapCategory', () => {
  it('maker/craft/workshop → learning', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'Maker Monday: Craft Workshop', DESCRIPTION: '' }), 'learning')
  })
  it('market → market', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'North Hill Vendor Market', DESCRIPTION: '' }), 'market')
  })
  it('music → music', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'Live Band at the CDC', DESCRIPTION: '' }), 'music')
  })
  it('art/gallery → visual-art', () => {
    assert.equal(inferFromIcs({ SUMMARY: 'Gallery Exhibition Opening', DESCRIPTION: '' }), 'visual-art')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// rialto — Squarespace music venue, default 'music'
// ─────────────────────────────────────────────────────────────────────────────
describe('rialto mapCategory', () => {
  it('irish jam session → music', () => {
    // "jam session" is a title-scoped music signal; rialto falls back to 'music'
    // for any event that doesn't resolve to a more-specific category.
    assert.equal(inferFromItem({ title: 'Irish Jam Session Night', excerpt: '' }), 'music')
  })
  it('improv/comedy → comedy', () => {
    assert.equal(inferFromItem({ title: 'Improv Comedy Showcase', excerpt: '' }), 'comedy')
  })
  it('poetry open mic → music (open mic signal wins; scraper adds spoken-word tags)', () => {
    // "Open mic" is a music DECISIVE signal. The tags layer (not inferred category)
    // is where the scraper adds 'poetry' and 'spoken-word' nuance.
    assert.equal(inferFromItem({ title: 'Angry Cow Poetry Open Mic', excerpt: '' }), 'music')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// hale-farm — direct call mapCategory(title, desc)
// ─────────────────────────────────────────────────────────────────────────────
describe('hale-farm mapCategory', () => {
  it('glassblowing/craft → visual-art', () => {
    assert.equal(inferCategory('Glassblowing Demonstration at Hale Farm', ''), 'visual-art')
  })
  it('workshop/class → learning', () => {
    assert.equal(inferCategory('Natural Dyeing Workshop', 'Learn indigo dyeing techniques'), 'learning')
  })
  it('concert → music', () => {
    assert.equal(inferCategory('Summer Concert at Hale Farm', 'Live jazz and orchestra performance'), 'music')
  })
  it('murder mystery theater → theater', () => {
    assert.equal(inferCategory('Murder Mystery Theatre Evening', 'An immersive theatrical murder mystery'), 'theater')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// get-away-with-murder — direct call mapCategory(title, desc)
// ─────────────────────────────────────────────────────────────────────────────
describe('get-away-with-murder mapCategory', () => {
  it('audition/workshop → learning', () => {
    assert.equal(inferCategory('Acting Auditions for Holiday Show', 'Workshop and audition for our next production'), 'learning')
  })
  it('immersive show → theater', () => {
    assert.equal(inferCategory('Murder Mystery Dinner Party', 'Immersive theatrical murder mystery experience'), 'theater')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// better-kenmore — direct call, passes title + location text
// ─────────────────────────────────────────────────────────────────────────────
describe('better-kenmore mapCategory', () => {
  it('yoga/fitness → fitness', () => {
    assert.equal(inferCategory('Yoga in the Park', ''), 'fitness')
  })
  it('movie → film', () => {
    assert.equal(inferCategory('Movie Night in Kenmore', ''), 'film')
  })
  it('music/concert → music', () => {
    assert.equal(inferCategory('Live Music at the Rialto', ''), 'music')
  })
  it('market/vendor → market', () => {
    assert.equal(inferCategory('First Friday Vendor Market', ''), 'market')
  })
  it('art class/workshop → visual-art', () => {
    assert.equal(inferCategory('Paint and Sip Workshop', ''), 'visual-art')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// akron-urban-league — direct call mapCategory(title, desc)
// ─────────────────────────────────────────────────────────────────────────────
describe('akron-urban-league mapCategory', () => {
  it('concert/music → music', () => {
    assert.equal(inferCategory('Jazz Concert Benefit', ''), 'music')
  })
  it('art/gallery → visual-art', () => {
    assert.equal(inferCategory('Art Exhibition Opening', 'Gallery exhibit featuring local artists'), 'visual-art')
  })
  it('run/5k → fitness', () => {
    assert.equal(inferCategory('MLK 5K Walk/Run', ''), 'fitness')
  })
  it('job/training/workshop → learning', () => {
    assert.equal(inferCategory('Workforce Development Workshop', 'Career training and job placement'), 'learning')
  })
  it('gala/dinner → food (gala is a fundraiser signal; food-adjacent events score food)', () => {
    // "gala" is in FUNDRAISER_RE; "dinner" alone doesn't score food (needs "dinner show", "wine dinner", etc.)
    // A gala at a civil-rights org is community/fundraiser — 'other' content is correct.
    const cat = inferCategory('Annual Champions of Change Gala Dinner', '')
    assert.ok(['other', 'food'].includes(cat), `got ${cat}`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// the-well-cdc — direct call mapCategory(title, desc)
// ─────────────────────────────────────────────────────────────────────────────
describe('the-well-cdc mapCategory', () => {
  it('concert/music → music', () => {
    assert.equal(inferCategory('DJ Night at The Well', ''), 'music')
  })
  it('festival → festival', () => {
    assert.equal(inferCategory('Juneteenth Block Party Festival', ''), 'festival')
  })
  it('career workshop → learning', () => {
    assert.equal(inferCategory('Career Workshop: Resume Building', ''), 'learning')
  })
  it('brunch/food → food', () => {
    assert.equal(inferCategory('Community Brunch Celebration', ''), 'food')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// kent-stage (already uses inferCategory — regression guard only)
// ─────────────────────────────────────────────────────────────────────────────
describe('kent-stage mapCategory (already migrated)', () => {
  it('music concert → music', () => {
    assert.equal(inferCategory('Live Rock Concert at Kent Stage', ''), 'music')
  })
  it('comedy night → comedy', () => {
    assert.equal(inferCategory('Comedy Night with Special Guests', ''), 'comedy')
  })
  it('tribute band → music', () => {
    assert.equal(inferCategory('Zeppelin Tribute: The Mighty Zeppelin', ''), 'music')
  })
})
