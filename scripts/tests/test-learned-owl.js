/**
 * test-learned-owl.js
 *
 * Tests the pure parsers behind the Learned Owl Book Shop scraper. The HTML
 * fixtures are trimmed verbatim from the live Drupal /events month view and a
 * detail page (captured 2026-07-14), so they lock in:
 *   - card slicing across the nested <article> inside each Place block
 *   - "M/D/YYYY" date + "11:00am - 1:00pm" time-range parsing (start + end)
 *   - meridiem inheritance on ranges quoting am/pm only on the end
 *   - Summit-gate location parsing + children → is_family facet
 *   - the Obolus proof-of-work solver (deterministic, no network)
 *
 * Run:
 *   node --test scripts/tests/test-learned-owl.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// Dummy env so importing the scraper module never touches a real DB.
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  parseEventCards,
  parseListingDate,
  parseTimeRange,
  timeFromProse,
  parseLocation,
  parseTags,
  isFamilyEvent,
  monthsForward,
  parseObolusConfig,
  solveObolusChallenge,
  isObolusChallenge,
} from '../scrape-learned-owl.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

// Two real cards back-to-back plus a trailing "next event" event-block, so the
// slicing is exercised against both the nested <address> <article> and the
// non-event-list markup that follows the last card.
const LISTING_HTML = `
<div class="view-content">
  <div class="views-row">
<article id="event-1103" class="event-list">
  <div class="event-list__second">
    <div class="event-list__second--bot">
      <div class="event-list__details">
        <div class="event-list__second--top">
          <h3 class="event-list__title">
            <a href="/event/2026-07-04/david-allen-edmonds" hreflang="en">David Allen Edmonds</a>
          </h3>
          <span class="event-list__tags">
            <div class="event-tag__term"><a href="/events/tags/author-events-adults">Author Events-Adults</a></div>
          </span>
          <div class="event-list__image">
            <img loading="lazy" src="/sites/default/files/styles/large/public/image/2026/06/06/david-edmonds.webp?itok=5NE1RKzg" width="480" height="480" alt="David Allen Edmonds" />
          </div>
        </div>
        <div class="event-list__body">
          Join the Learned Owl Book Shop in welcoming David Allen Edmonds on Saturday, July 04, 2026 at 11:00 am.
        </div>
        <div class="event-list__details--item">
          <span class="event-list__details--label">Date: </span>
          Sat, 7/4/2026
        </div>
        <div class="event-list__details--item">
          <span class="event-list__details--label">Time: </span>
          11:00am - 1:00pm
        </div>
        <div class="event-list__details--item event-details__location--location">
          <span class="event-list__details--label">Place:  </span>
          <div><article>
            <div><address>
      The Learned Owl Book Shop <br/>
        204 N Main St <br/>
          Hudson, OH 44236-2826
  </address>
</div>
          </article></div>
        </div>
      </div>
    </div>
  </div>
</article>
  </div>
  <div class="views-row">
<article id="event-1099" class="event-list">
  <div class="event-list__second">
    <div class="event-list__details">
      <h3 class="event-list__title">
        <a href="/event/2026-07-11/andi-michelson-learned-owl-book-shop" hreflang="en">Andi Michelson at The Learned Owl Book Shop</a>
      </h3>
      <span class="event-list__tags">
        <div class="event-tag__term"><a href="/events/tags/author-events-adults">Author Events-Adults</a></div>
        <div class="event-tag__term"><a href="/events/tags/author-events-children">Author Events-Children</a></div>
      </span>
      <div class="event-list__image">
        <img loading="lazy" src="/sites/default/files/styles/large/public/image/2026/06/06/andi.webp?itok=abc" width="480" height="480" alt="Andi" />
      </div>
      <div class="event-list__body">Storytime and signing with Andi Michelson.</div>
      <div class="event-list__details--item">
        <span class="event-list__details--label">Date: </span>
        Sat, 7/11/2026
      </div>
      <div class="event-list__details--item">
        <span class="event-list__details--label">Time: </span>
        11:00am - 1:00pm
      </div>
      <div class="event-list__details--item event-details__location--location">
        <span class="event-list__details--label">Place:  </span>
        <div><article>
          <div><address>
      The Learned Owl Book Shop <br/>
        204 N Main St <br/>
          Hudson, OH 44236-2826
  </address>
</div>
        </article></div>
      </div>
    </div>
  </div>
</article>
  </div>
</div>
<article class="event-block">
  <h3 class="event-block__title">Jack Ricchiuto at The Learned Owl Book Shop</h3>
  <div class="event-block__cta"><a href="/event/2026-07-18/jack-ricchiuto-learned-owl-book-shop">View event</a></div>
</article>
`

const ADDRESS_HTML = `
      The Learned Owl Book Shop <br/>
        204 N Main St <br/>
          Hudson, OH 44236-2826
`

// ── parseEventCards ─────────────────────────────────────────────────────────

describe('parseEventCards', () => {
  const cards = parseEventCards(LISTING_HTML)

  it('extracts exactly the two event-list cards (ignores the event-block)', () => {
    assert.equal(cards.length, 2)
  })

  it('parses title, href and a date-slug source_id', () => {
    assert.equal(cards[0].title, 'David Allen Edmonds')
    assert.equal(cards[0].href, 'https://learnedowl.com/event/2026-07-04/david-allen-edmonds')
    assert.equal(cards[0].sourceId, '2026-07-04/david-allen-edmonds')
  })

  it('captures date and time lines', () => {
    assert.equal(cards[0].dateText, 'Sat, 7/4/2026')
    assert.equal(cards[0].timeText, '11:00am - 1:00pm')
  })

  it('captures every tag term', () => {
    assert.deepEqual(cards[0].tags, ['Author Events-Adults'])
    assert.deepEqual(cards[1].tags, ['Author Events-Adults', 'Author Events-Children'])
  })

  it('captures the Place <address> block per card (slicing survives nesting)', () => {
    assert.match(cards[0].locationHtml, /204 N Main St/)
    assert.match(cards[1].locationHtml, /Hudson, OH 44236/)
  })

  it('strips the Drupal image-style segment and itok token', () => {
    assert.equal(
      cards[0].imageUrl,
      'https://learnedowl.com/sites/default/files/image/2026/06/06/david-edmonds.webp',
    )
  })
})

// ── parseListingDate ────────────────────────────────────────────────────────

describe('parseListingDate', () => {
  it('parses "Sat, 7/4/2026"', () => assert.equal(parseListingDate('Sat, 7/4/2026'), '2026-07-04'))
  it('parses a bare "12/25/2026"', () => assert.equal(parseListingDate('12/25/2026'), '2026-12-25'))
  it('zero-pads month and day', () => assert.equal(parseListingDate('Sun, 3/9/2027'), '2027-03-09'))
  it('returns null when no date is present', () => assert.equal(parseListingDate('Coming soon'), null))
  it('returns null on empty input', () => assert.equal(parseListingDate(''), null))
})

// ── parseTimeRange ──────────────────────────────────────────────────────────

describe('parseTimeRange', () => {
  it('parses a full am→pm range', () => {
    assert.deepEqual(parseTimeRange('11:00am - 1:00pm'), { startTime: '11:00:00', endTime: '13:00:00' })
  })
  it('parses an afternoon range', () => {
    assert.deepEqual(parseTimeRange('1:00pm - 3:00pm'), { startTime: '13:00:00', endTime: '15:00:00' })
  })
  it('inherits the end meridiem when the start omits it', () => {
    assert.deepEqual(parseTimeRange('11 - 11:30am'), { startTime: '11:00:00', endTime: '11:30:00' })
  })
  it('parses a single time with no range', () => {
    assert.deepEqual(parseTimeRange('7:00pm'), { startTime: '19:00:00', endTime: null })
  })
  it('handles noon correctly', () => {
    assert.deepEqual(parseTimeRange('12:00pm - 1:00pm'), { startTime: '12:00:00', endTime: '13:00:00' })
  })
  it('returns nulls when no clock time is published', () => {
    assert.deepEqual(parseTimeRange('All Day'), { startTime: null, endTime: null })
    assert.deepEqual(parseTimeRange(''), { startTime: null, endTime: null })
  })
})

// ── timeFromProse ───────────────────────────────────────────────────────────

describe('timeFromProse', () => {
  it('recovers "at 11:00 am" from the teaser', () => {
    assert.equal(
      timeFromProse('…welcoming David Allen Edmonds on Saturday, July 04, 2026 at 11:00 am.'),
      '11:00:00',
    )
  })
  it('ignores dash-joined digits without a meridiem (phone numbers)', () => {
    assert.equal(timeFromProse('Call the shop at 330-653-2252 for details.'), null)
  })
  it('returns null when the prose has no time', () => {
    assert.equal(timeFromProse('Join us for a fun morning of stories.'), null)
  })
})

// ── parseLocation ───────────────────────────────────────────────────────────

describe('parseLocation', () => {
  it('splits the <address> block into name/street/city/state/zip', () => {
    assert.deepEqual(parseLocation(ADDRESS_HTML), {
      name:  'The Learned Owl Book Shop',
      street: '204 N Main St',
      city:  'Hudson',
      state: 'OH',
      zip:   '44236',
    })
  })
  it('handles a plain zip without the +4 suffix', () => {
    const loc = parseLocation('Some Library <br/> 1 Library Ln <br/> Stow, OH 44224')
    assert.equal(loc.city, 'Stow')
    assert.equal(loc.zip, '44224')
  })
  it('returns null on empty input', () => assert.equal(parseLocation(''), null))
})

// ── tags / facets ───────────────────────────────────────────────────────────

describe('parseTags + isFamilyEvent', () => {
  it('adult author event → author-event, no family', () => {
    assert.deepEqual(parseTags(['Author Events-Adults'], 'David Allen Edmonds'), ['bookstore', 'author-event'])
    assert.equal(isFamilyEvent(['Author Events-Adults'], 'David Allen Edmonds'), false)
  })
  it('children author event → family tag + is_family', () => {
    const tags = parseTags(['Author Events-Children'], 'Storytime with Andi')
    assert.ok(tags.includes('author-event'))
    assert.ok(tags.includes('family'))
    assert.ok(tags.includes('storytime'))
    assert.equal(isFamilyEvent(['Author Events-Children'], 'Storytime with Andi'), true)
  })
})

// ── monthsForward ───────────────────────────────────────────────────────────

describe('monthsForward', () => {
  it('rolls over the year boundary', () => {
    assert.deepEqual(monthsForward({ year: 2026, month: 11 }, 4), [
      { year: 2026, month: 11 },
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
      { year: 2027, month: 2 },
    ])
  })
  it('returns the requested count', () => {
    assert.equal(monthsForward({ year: 2026, month: 7 }, 6).length, 6)
  })
})

// ── Obolus proof-of-work ────────────────────────────────────────────────────

describe('Obolus challenge solver', () => {
  const CHALLENGE_HTML = `
    <title>Checking connection</title>
    <script>
      var PROOF_COOKIE_NAME = 'X_Obolus_Proof';
      const BENCHMARK_ITERATIONS = 4096;
      const CONFIG = {
        targetTime: parseInt('500', 10),
        maxTime: parseInt('4000', 10),
        nonce: 'c5530ed302b226ee',
        challengeToken: 'f13402676c7e888db914ac9d9e5ff66fac8547ffe531d2b401afe8c00322207a',
        challengeTimestamp: '1784078648',
        difficulty: '14',
        mode: 'aggressive'
      };
    </script>`

  it('detects the interstitial', () => {
    assert.equal(isObolusChallenge(CHALLENGE_HTML), true)
    assert.equal(isObolusChallenge('<html>real events</html>'), false)
  })

  it('parses the inline CONFIG (fixed difficulty)', () => {
    assert.deepEqual(parseObolusConfig(CHALLENGE_HTML), {
      nonce: 'c5530ed302b226ee',
      challengeToken: 'f13402676c7e888db914ac9d9e5ff66fac8547ffe531d2b401afe8c00322207a',
      challengeTimestamp: '1784078648',
      difficulty: 14,
      maxTime: 4000,
      iterations: 4096,
    })
  })

  it('parses the adaptive variant and solves it at the 12-bit floor', () => {
    const adaptiveHtml = CHALLENGE_HTML.replace("difficulty: '14'", "difficulty: 'adaptive'")
    const cfg = parseObolusConfig(adaptiveHtml)
    assert.equal(cfg.difficulty, 'adaptive')
    const proof = solveObolusChallenge(cfg)
    assert.ok(proof, 'expected a proof for the adaptive challenge')
    const miningNonce = proof.split(':')[4]
    const digest = createHash('sha256').update(`${cfg.nonce}:mine:${miningNonce}`).digest()
    let bits = 0
    for (const byte of digest) { if (byte === 0) { bits += 8; continue } bits += Math.clz32(byte) - 24; break }
    assert.ok(bits >= 12, `adaptive hash has ${bits} leading zero bits, expected >= 12`)
  })

  it('mines a proof whose hash actually meets the difficulty', () => {
    // Use a modest difficulty for a fast, deterministic test.
    const config = { nonce: 'testnonce', challengeToken: 'tok', challengeTimestamp: '1700000000', difficulty: 12 }
    const proof = solveObolusChallenge(config, { benchmarkElapsed: 250 })
    assert.ok(proof, 'expected a proof string')
    const parts = proof.split(':')
    assert.equal(parts.length, 5)
    assert.equal(parts[0], '1700000000')
    assert.equal(parts[1], 'testnonce')
    assert.equal(parts[2], 'tok')
    assert.equal(parts[3], '250')
    const miningNonce = parts[4]
    // Recompute the winning hash and count leading zero bits ourselves.
    const digest = createHash('sha256').update(`testnonce:mine:${miningNonce}`).digest()
    let bits = 0
    for (const byte of digest) {
      if (byte === 0) { bits += 8; continue }
      bits += Math.clz32(byte) - 24
      break
    }
    assert.ok(bits >= 12, `winning hash has ${bits} leading zero bits, expected >= 12`)
  })

  it('returns null if it cannot solve within the attempt cap', () => {
    const config = { nonce: 'x', challengeToken: 't', challengeTimestamp: '1', difficulty: 40 }
    assert.equal(solveObolusChallenge(config, { maxAttempts: 1000 }), null)
  })
})
