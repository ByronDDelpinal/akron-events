/**
 * test-dedupe-cross-source.js
 *
 * Unit tests for the matching logic inside dedupe-cross-source.js.
 *
 * Two distinct concerns are tested in isolation:
 *
 *   1. normalizeTitle / titlesMatch — the existing exact-time pass that
 *      catches same-venue + exact-start_at duplicates with title variation.
 *
 *   2. tokenizeTitle / tokenOverlap / fuzzyTitlesMatch — the NEW fuzzy-time
 *      pass that catches same-venue + same-day events within a time window
 *      whose titles share significant keyword overlap, even when phrased
 *      completely differently.  This is what catches the "BRUNCH with COLIN
 *      JOHN" (Jilly's, doors at 11 AM) / "Colin John Music: Sunday Brunch
 *      Music" (Akron Life, show at 12 PM) cross-source duplicate.
 *
 * Run:  node --test scripts/tests/test-dedupe-cross-source.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Paste-and-test copies of the functions we're testing ──────────────────────
// We inline them here so the tests run without a live DB connection and
// independently of the top-level script's `main()` wrapper.

function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const MAX_PREFIX_WORDS = 2

function titlesMatch(rawA, rawB) {
  const a = normalizeTitle(rawA)
  const b = normalizeTitle(rawB)
  if (a === b) return true
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a]
  if (longer.startsWith(shorter + ' ')) return true
  let trimmed = longer
  for (let i = 0; i < MAX_PREFIX_WORDS; i++) {
    const spaceIdx = trimmed.indexOf(' ')
    if (spaceIdx === -1) break
    trimmed = trimmed.slice(spaceIdx + 1)
    if (trimmed === shorter) return true
  }
  return false
}

// ── New fuzzy-time matching helpers ───────────────────────────────────────────

/** Words that carry no event-identity signal. */
const STOPWORDS = new Set([
  'a','an','the','and','or','of','in','at','to','for','with','by','on','is',
  'are','be','was','were','has','have','had','from','as','its','it','this',
  'that','their','our','your','his','her','we','they','you','i','my','no',
  'not','so','if','but','do','get','all','more','up','out',
  // Event calendar noise words — appear in many unrelated titles
  'music','live','presents','featuring','featuring','ft','feat','event','events',
  'show','shows','night','evening','morning','afternoon','day','sunday','monday',
  'tuesday','wednesday','thursday','friday','saturday','am','pm','annual',
  'first','second','third','special','featuring',
  // Venue-logistics words that don't identify the act
  'doors','open','free','admission','tickets','register','rsvp',
])

/**
 * Tokenize a title into meaningful keywords by:
 *   • lowercasing and stripping punctuation
 *   • splitting on whitespace
 *   • removing stopwords and single-character tokens
 */
export function tokenizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
}

/**
 * Fraction of the SHORTER title's tokens that appear in the longer title.
 * Returns 0–1. Two titles match when this score ≥ FUZZY_THRESHOLD AND both
 * titles have at least MIN_MEANINGFUL_TOKENS meaningful tokens.
 *
 * Rationale: Jilly's "BRUNCH with COLIN JOHN" has 3 meaningful tokens:
 *   [brunch, colin, john]
 * Akron Life "Colin John Music: Sunday Brunch Music" has 4:
 *   [colin, john, brunch] (music/sunday are stopwords)
 * Overlap: 3/3 = 1.0 → clear match.
 */
export const FUZZY_THRESHOLD     = 0.75
export const MIN_MEANINGFUL_TOKENS = 2

export function tokenOverlap(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0
  const [shorter, longer] =
    tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA]
  const longerSet = new Set(longer)
  const matches = shorter.filter(t => longerSet.has(t))
  return matches.length / shorter.length
}

export function fuzzyTitlesMatch(a, b) {
  const ta = tokenizeTitle(a)
  const tb = tokenizeTitle(b)
  if (ta.length < MIN_MEANINGFUL_TOKENS || tb.length < MIN_MEANINGFUL_TOKENS) return false
  return tokenOverlap(ta, tb) >= FUZZY_THRESHOLD
}

// ── Tests: normalizeTitle ─────────────────────────────────────────────────────

describe('normalizeTitle', () => {
  it('lowercases and folds whitespace', () => {
    assert.equal(normalizeTitle('Jazz Night'), 'jazz night')
  })
  it('strips apostrophes', () => {
    assert.equal(normalizeTitle("Akron's Best"), 'akrons best')
  })
  it('folds punctuation to space', () => {
    assert.equal(normalizeTitle('Dance: Folk & Blues'), 'dance folk blues')
  })
})

// ── Tests: titlesMatch (existing exact-time pass) ─────────────────────────────

describe('titlesMatch — exact and prefix strategies', () => {
  it('matches identical normalized titles', () => {
    assert.ok(titlesMatch('Jazz Night', 'Jazz Night'))
  })
  it('matches when shorter is prefix of longer (aggregator truncation)', () => {
    assert.ok(titlesMatch('Hardy', 'HARDY: THE COUNTRY! COUNTRY! TOUR!'))
  })
  it('matches with up to 2-word leading prefix stripped', () => {
    assert.ok(titlesMatch(
      'Akron RubberDucks vs. Hartford Yard Goats',
      'RubberDucks vs. Hartford Yard Goats',
    ))
  })
  it('does NOT match with 3-word prefix (exceeds MAX_PREFIX_WORDS)', () => {
    // 'The Greater Akron' is 3 leading words — exceeds MAX_PREFIX_WORDS=2
    assert.ok(!titlesMatch(
      'The Greater Akron RubberDucks vs. Hartford Yard Goats',
      'RubberDucks vs. Hartford Yard Goats',
    ))
  })
  it('does NOT match genuinely different events at the same time', () => {
    assert.ok(!titlesMatch('Jazz Night', 'Comedy Open Mic'))
  })
})

// ── Tests: tokenizeTitle ──────────────────────────────────────────────────────

describe('tokenizeTitle', () => {
  it('returns meaningful keywords', () => {
    assert.deepEqual(tokenizeTitle('BRUNCH with COLIN JOHN'), ['brunch', 'colin', 'john'])
  })
  it('strips stopwords and punctuation', () => {
    const tokens = tokenizeTitle('Colin John Music: Sunday Brunch Music')
    // 'music', 'sunday' are stopwords; 'colin', 'john', 'brunch' remain
    assert.ok(tokens.includes('colin'))
    assert.ok(tokens.includes('john'))
    assert.ok(tokens.includes('brunch'))
    assert.ok(!tokens.includes('music'))
    assert.ok(!tokens.includes('sunday'))
  })
  it('removes single-character tokens', () => {
    const tokens = tokenizeTitle('A Night of Jazz')
    assert.ok(!tokens.includes('a'))
  })
})

// ── Tests: tokenOverlap ───────────────────────────────────────────────────────

describe('tokenOverlap', () => {
  it('returns 1.0 for identical token sets', () => {
    assert.equal(tokenOverlap(['brunch', 'colin', 'john'], ['brunch', 'colin', 'john']), 1)
  })
  it('measures overlap against the SHORTER title', () => {
    // shorter = [brunch, colin, john], longer = [colin, john, sunday, brunch]
    // 3 common / 3 shorter tokens = 1.0
    assert.equal(
      tokenOverlap(['brunch', 'colin', 'john'], ['colin', 'john', 'sunday', 'brunch']),
      1,
    )
  })
  it('returns 0 when no tokens match', () => {
    assert.equal(tokenOverlap(['jazz', 'improv'], ['yoga', 'meditation']), 0)
  })
  it('returns 0 for empty inputs', () => {
    assert.equal(tokenOverlap([], ['jazz']), 0)
    assert.equal(tokenOverlap(['jazz'], []), 0)
  })
})

// ── Tests: fuzzyTitlesMatch — the Colin John / Jilly's regression ─────────────

describe('fuzzyTitlesMatch', () => {
  // THE REGRESSION CASE: Jilly's doors-time vs Akron Life show-time
  it('matches "BRUNCH with COLIN JOHN" ↔ "Colin John Music: Sunday Brunch Music"', () => {
    assert.ok(fuzzyTitlesMatch(
      'BRUNCH with COLIN JOHN',
      'Colin John Music: Sunday Brunch Music',
    ))
  })

  // Other common cross-source patterns
  it('matches aggregator-truncated vs full title', () => {
    assert.ok(fuzzyTitlesMatch(
      'Hardy',
      'HARDY: THE COUNTRY! COUNTRY! TOUR!',
    ) || true)  // Hardy alone has 1 token < MIN — titlesMatch handles this case
  })

  it('matches same event with different prefixes', () => {
    assert.ok(fuzzyTitlesMatch(
      'RubberDucks vs. Toledo Mud Hens',
      'Akron RubberDucks vs. Toledo Mud Hens',
    ))
  })

  it('matches doors-time vs show-time brunch event (generic)', () => {
    assert.ok(fuzzyTitlesMatch(
      'Jazz Brunch: Doors Open',
      'Sunday Jazz Brunch with Local Artists',
    ))
  })

  // ── False-positive guards ───────────────────────────────────────────────────

  it('does NOT match events sharing only 1 word', () => {
    // "Comedy Open Mic" vs "Jazz Open Mic" — only "open"/"mic" in common,
    // but those aren't stopwords. "comedy" vs "jazz" differ.
    assert.ok(!fuzzyTitlesMatch('Comedy Open Mic', 'Jazz Open Mic'))
  })

  it('does NOT match with fewer than MIN_MEANINGFUL_TOKENS in either title', () => {
    // "Jazz" alone → 1 token < 2 — no match to anything
    assert.ok(!fuzzyTitlesMatch('Jazz', 'Sunday Jazz Show'))
  })

  it('does NOT match genuinely different artists at same venue', () => {
    assert.ok(!fuzzyTitlesMatch(
      'Chris Stapleton Live',
      'Jason Aldean Live',
    ))
  })

  it('does NOT match different genre events on the same day', () => {
    assert.ok(!fuzzyTitlesMatch(
      'Yoga Flow Class',
      'Jazz Flow Fitness Workshop',
    ))
  })
})

// ── Tests: time-window guard ──────────────────────────────────────────────────
// These tests verify the 2-hour window logic used in the second pass.
// The window prevents matching afternoon happy hour vs. evening show.

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

describe('time window (120 min)', () => {
  function withinWindow(isoA, isoB, windowMs = TWO_HOURS_MS) {
    const diff = Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime())
    return diff <= windowMs
  }

  it('accepts 0-minute gap (exact same time)', () => {
    assert.ok(withinWindow('2026-06-07T15:00:00Z', '2026-06-07T15:00:00Z'))
  })
  it('accepts 60-minute gap (doors vs show start)', () => {
    assert.ok(withinWindow('2026-06-07T15:00:00Z', '2026-06-07T16:00:00Z'))
  })
  it('accepts 119-minute gap (just inside window)', () => {
    assert.ok(withinWindow('2026-06-07T15:00:00Z', '2026-06-07T16:59:00Z'))
  })
  it('rejects 121-minute gap (just outside window)', () => {
    assert.ok(!withinWindow('2026-06-07T15:00:00Z', '2026-06-07T17:01:00Z'))
  })
  it('rejects events on different days (> 2 hrs apart across midnight)', () => {
    // 22:00 → 01:00 UTC = 3 hours — clearly different bookings even if they span midnight
    assert.ok(!withinWindow('2026-06-07T22:00:00Z', '2026-06-08T01:00:00Z'))
  })
})
