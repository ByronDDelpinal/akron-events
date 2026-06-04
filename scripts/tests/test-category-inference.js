/**
 * test-category-inference.js
 *
 * Tests for the rebuilt SCORED category classifier
 * (scripts/lib/category-inference.js).
 *
 * Two layers:
 *   1. ORACLE — a labeled set of representative Akron-area event titles with
 *      their correct category. This is the real quality bar: the scored
 *      classifier must label every one correctly.
 *   2. PARITY — a verbatim copy of the OLD first-match-wins cascade. We run both
 *      over the oracle corpus and report agreement. Exact parity is NOT
 *      expected (the whole point was to fix cases the cascade got wrong); the
 *      divergences are printed and each must favor the scored classifier.
 *
 * Run:  node --test scripts/tests/test-category-inference.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { inferCategory, scoreCategories } from '../lib/category-inference.js'

// ════════════════════════════════════════════════════════════════════════════
// Legacy classifier — verbatim copy of the pre-refactor cascade, kept here as a
// regression baseline only. Do not edit; it documents the old behavior.
// ════════════════════════════════════════════════════════════════════════════
const _MUSIC_VENUES = /(@|\bat)\s+(the\s+)?(?:\w+\s+){0,2}(old 97|vortex|matinee|musica|jilly'?s|barmacy|blu jazz|empire concert|goodyear theat(er|re)|akron civic|knight stage|tangier|stage door|lock 4|kent stage|civic theatre)\b/i
const _GENERIC_TOUR_EXCLUSION = /(walking|guided|historical|garden|home|food|brewery|trolley|architecture|museum|self[- ]guided|virtual|haunted|farm|driving|kayak|free|weekly|exhibit|art|behind[- ]?the[- ]?scenes|members'?|public|private|holiday|cemetery|winery|wine|history|ghost)\s+tour|tour\s*:/i
const _LEARN_NOT_EDUCATIONAL = /\blearn\s+(more|why|all|about|everything|here|now|first|today|tomorrow)\b/i

function inferCategoryLegacy(title = '', description = '') {
  const text = `${title || ''} ${description || ''}`.toLowerCase()
  const tLow = (title || '').toLowerCase()
  if (/\bcomedy (open mic|night)\b/.test(text) || (/\bopen mic\b/.test(text) && /\bcomedy|comedians?\b/.test(text))) return 'art'
  if (/\b(concert|symphony|orchestra|recital|live music|live band|open mic|karaoke|sing[- ]along|songwriter night|jazz night|blues night|dj set|sound check|album release|ep release|single release|musical guest|tribute (band|act|show|to)|spotify|on spotify)\b/.test(text)) return 'music'
  if (/\btribute\b/.test(text)) return 'music'
  if (/\btour\b/.test(tLow) && !_GENERIC_TOUR_EXCLUSION.test(text)) return 'music'
  if (_MUSIC_VENUES.test(title)) return 'music'
  if (/\b(rubberducks|cleveland cavaliers|cleveland browns|cleveland guardians|cleveland indians|cavs|browns|guardians|hockey game|baseball game|basketball game|tournament championship|home game|home court|matchday|playoff|stadium)\b/.test(text)) return 'sports'
  if (/\b[a-z][a-z .'&]+ vs\.? [a-z][a-z .'&]+\b/.test(tLow)) return 'sports'
  if (/\b(5k|10k|half[- ]?marathon|marathon|fun run|trail run|color run|yoga|pilates|crossfit|spin class|hiit|cardio|paddleboard(ing)?|kayak(ing)?|canoe|stand[- ]up paddle|cycle class|cycling class|barre class)\b/.test(text)) return 'fitness'
  if (/\b(certification|professional development|continuing education|sat prep|gre prep|esol classes|ged classes|lean six sigma|pmp|leadership training|sales training|management training|conflict resolution training|coding bootcamp|reiki .* certification|six sigma)\b/.test(text)) return 'education'
  if (/\b\d+[- ]day workshop\b/.test(text)) return 'education'
  if (/\b(seminar|lecture series|symposium|webinar|conference|masterclass)\b/.test(text)) return 'education'
  if (/\b(scam|scammer|fraud|phishing|identity theft|cyber(security| safety)|online safety|consumer (safety|protection|fraud)|financial (literacy|safety|fraud)|digital literacy|internet safety|password safety|outsmart|avoid (scams?|fraud)|protect yourself)\b/.test(text)) return 'education'
  if (/\b(information session|info session|orientation (session|program)?|new student orientation|open enrollment|enrollment clinic|free clinic|financial aid clinic|tax clinic|legal clinic|resource fair)\b/.test(text)) return 'education'
  if (/\b(gallery|exhibition|exhibit opening|opening (reception|celebration)|artist reception|artist talk|sculpture show|mural unveiling|art show|art fair|installation|vernissage)\b/.test(text)) return 'art'
  if (/\b(theat(re|er)|playwright|broadway|stage production|musical (theatre|theater|production)s?|opera|ballet|dance company|stand[- ]?up comedy|comedy night|comedy show|improv|drag (show|brunch|king|queen|bingo))\b/.test(text)) return 'art'
  if (/\b(paint (and|&|n)\s*sip|puff (and|&|n)\s*paint|paint(ing)? class|pottery|ceramics|sketching workshop|drawing class)\b/.test(text)) return 'art'
  if (/\b(brewery|winery|wine tasting|beer tasting|cooking class|culinary|food truck|food festival|restaurant week|tap takeover|chef'?s table|tasting menu|wine dinner|whiskey tasting|cocktail (class|essentials|workshop)|brunch|luncheon|dinner show|drag brunch|sake|sushi tasting|cheese tasting|bourbon tasting|coffee tasting|chocolate tasting|culinary class)\b/.test(text)) return 'food'
  if (/\b(band\b|live performance|performer|musician|vocalist|jam session|sing[- ]?along)\b/.test(tLow)) return 'music'
  if (/\b(singer[- ]songwriter|guitarist|drummer|bassist|saxophonist|pianist|trumpeter|cellist|violinist|multi[- ]?instrumentalist|frontman|frontwoman|frontperson)\b/.test(text)) return 'music'
  if (/\b(two|three|four|five|six|seven|eight)[- ]piece band\b/.test(text)) return 'music'
  if (/\b(music scene|debut (album|record|ep|single)|released (his|her|their) (debut |first |new |latest )?(album|record|ep|single)|touring (band|artist|musician)|nationally touring|on tour\b)\b/.test(text)) return 'music'
  if (/\b(blues|jazz|metalcore|nu[- ]metal|death metal|hardcore punk|grindcore|hip[- ]?hop|rap music|reggae|bluegrass|americana|alt[- ]?country|shoegaze|electronica|\bedm\b)\b/.test(text)) return 'music'
  if (/\b(music night|night of music|performance by|featuring [a-z]+ band)\b/.test(text)) return 'music'
  if (/\b(workshop|class\b|course|training session|lesson|book club|book discussion|study group|reading group)\b/.test(text)) return 'education'
  if (/\blearn\s+\w/i.test(tLow) && !_LEARN_NOT_EDUCATIONAL.test(tLow)) return 'education'
  if (/\b(park|trail|nature walk|nature center|garden|arboretum|zoo|wildlife|botanical|bird walk|hike|hiking|conservation|outdoor adventure|metro park)\b/.test(text)) return 'nature'
  if (/\b(festival|fair|farmers market|street market|parade|block party|community gathering|town hall|civic event|neighborhood meeting|family game night|family event|game night|trivia night|story[- ]?time|story hour|holiday celebration|seniorlinked|senior expo|family gathering)\b/.test(text)) return 'community'
  if (/\b(fundraiser|benefit dinner|silent auction|gala|service event|volunteer day|charity event|nonprofit|food drive|blood drive|donation drive|support group)\b/.test(text)) return 'nonprofit'
  return 'other'
}

// ════════════════════════════════════════════════════════════════════════════
// ORACLE — [title, description, expectedCategory]
// Drawn from the documented calibration cases in the old cascade's comments and
// from the real source mix (Killbox comedy, Nightlight film, RubberDucks, etc.)
// ════════════════════════════════════════════════════════════════════════════
const ORACLE = [
  // music
  ["Akron Symphony: Beethoven's 9th", '', 'music'],
  ['The Black Keys Tribute Band', '', 'music'],
  ['Friday Night Open Mic', 'All performers welcome', 'music'],
  ['Daniel Rylander', 'A singer-songwriter based in Akron', 'music'],
  ['Summer Concert Series at Lock 3', '', 'music'],

  // art (incl. theater, comedy, gallery — all one category in today's taxonomy)
  ['Comedy Open Mic Night', '', 'art'],
  ['Improv Comedy Showcase', 'A night of improv', 'art'],
  ['First Friday Gallery Opening Reception', '', 'art'],
  ['Cleveland Ballet presents Swan Lake', '', 'art'],
  ['Paint and Sip Night', '', 'art'],

  // sports
  ['RubberDucks vs Erie SeaWolves', '', 'sports'],
  ['Cleveland Cavs Game Watch', 'Cheer on the Cavs', 'sports'],

  // fitness
  ['Spring Half-Marathon', '', 'fitness'],
  ['Vinyasa Yoga Class', '', 'fitness'],
  ['Kayaking on the Cuyahoga', '', 'fitness'],

  // education
  ['PMP Certification Prep Course', '', 'education'],
  ['Protect Yourself from Online Scams', 'Avoid fraud and phishing', 'education'],
  ['Author Talk and Book Discussion', '', 'education'],
  ['Learn to Knit', '', 'education'],

  // food
  ['Brewery Tap Takeover', '', 'food'],
  ['Sunday Jazz Brunch', 'Live jazz over brunch', 'food'],

  // nature
  ['Guided Hike at Cuyahoga Valley', '', 'nature'],
  ['Summit Metro Parks Bird Walk', '', 'nature'],

  // community
  ['North Hill Farmers Market', '', 'community'],
  ['Neighborhood Block Party', '', 'community'],
  ['Storytime at the Library', '', 'community'],

  // nonprofit
  ['Annual Charity Gala Fundraiser', '', 'nonprofit'],
  ['Community Blood Drive', '', 'nonprofit'],

  // other (true fallbacks / current-taxonomy gaps)
  ['Movie Night at the Nightlight', 'Indie film screening', 'other'],
  ['Learn More About Our Membership', 'Sign up today', 'other'],
]

describe('inferCategory (scored) — oracle correctness', () => {
  for (const [title, desc, expected] of ORACLE) {
    it(`"${title}" → ${expected}`, () => {
      assert.equal(
        inferCategory(title, desc),
        expected,
        `scores: ${JSON.stringify(scoreCategories(title, desc))}`
      )
    })
  }
})

describe('inferCategory — contract', () => {
  it('returns "other" for empty input', () => {
    assert.equal(inferCategory('', ''), 'other')
    assert.equal(inferCategory(), 'other')
  })

  it('returns "other" for text with no signal', () => {
    assert.equal(inferCategory('Miscellaneous Gathering', 'Just hanging out'), 'other')
  })

  it('never emits a slug outside the known taxonomy', () => {
    const valid = new Set([
      'music', 'art', 'food', 'nonprofit', 'sports',
      'fitness', 'education', 'nature', 'community', 'other',
    ])
    for (const [t, d] of ORACLE) assert.ok(valid.has(inferCategory(t, d)))
  })
})

describe('inferCategory — parity with legacy cascade', () => {
  it('agrees with the legacy classifier on most oracle cases, and every divergence favors the scored result', () => {
    const divergences = []
    let agree = 0
    for (const [title, desc, expected] of ORACLE) {
      const legacy = inferCategoryLegacy(title, desc)
      const scored = inferCategory(title, desc)
      if (legacy === scored) { agree++; continue }
      divergences.push({ title, expected, legacy, scored })
      // Every divergence must be the scored classifier CORRECTING the legacy
      // one (scored matches the oracle, legacy did not).
      assert.equal(
        scored, expected,
        `Divergence on "${title}" but scored result (${scored}) is not the oracle (${expected})`
      )
      assert.notEqual(
        legacy, expected,
        `"${title}" diverged yet legacy already matched the oracle — that's a regression`
      )
    }
    const rate = ((agree / ORACLE.length) * 100).toFixed(0)
    console.log(`\n  parity: ${agree}/${ORACLE.length} (${rate}%) identical to legacy`)
    if (divergences.length) {
      console.log('  scored classifier corrected these legacy mislabels:')
      for (const d of divergences) {
        console.log(`    • "${d.title}": legacy=${d.legacy} → scored=${d.scored} (correct: ${d.expected})`)
      }
    }
    assert.ok(agree / ORACLE.length >= 0.7, 'expected >=70% raw parity with legacy')
  })
})
