/**
 * test-highland-square-theatre.js — the templated screening description.
 * The homepage carries no per-film synopsis, so we compose an honest
 * description of the screening (venue/format/runtime/rating) instead of null.
 *
 * Run:  node --test scripts/tests/test-highland-square-theatre.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  buildDescription,
  parseDatePart,
  parseHomepage,
  resolveYear,
  getUnmappedMonthCount,
  resetUnmappedMonthCount,
} = await import('../scrape-highland-square-theatre.js')

describe('Highland Square buildDescription', () => {
  it('includes runtime and rating when present', () => {
    const d = buildDescription({ rating: 'PG13', runtimeMin: 132 })
    assert.ok(d.includes('132 min'))
    assert.ok(d.includes('rated PG13'))
    assert.ok(d.includes('Highland Square Theatre'))
    assert.ok(d.includes('$5'))
  })

  it('omits the meta parenthetical when rating/runtime are missing', () => {
    const d = buildDescription({})
    assert.ok(!d.includes('('), 'no empty parenthetical')
    assert.ok(d.includes('Highland Square Theatre'))
  })

  it('never returns empty', () => {
    assert.ok(buildDescription(undefined).length > 20)
  })
})

describe('Highland Square month abbreviations (regression)', () => {
  it('resolveYear resolves the 3-letter abbreviation "Aug"', () => {
    assert.strictEqual(resolveYear('Aug', 1), resolveYear('August', 1))
  })

  it('resolveYear resolves the "Sept" variant', () => {
    assert.strictEqual(resolveYear('Sept', 1), resolveYear('September', 1))
  })

  it('parseDatePart resolves "Monday Aug 1" the same as the full month name', () => {
    resetUnmappedMonthCount()
    const abbrev = parseDatePart('Monday Aug 1')
    const full   = parseDatePart('Monday August 1')
    assert.deepStrictEqual(abbrev, full)
    assert.ok(abbrev.length > 0, 'abbreviated month should resolve to a date')
    assert.strictEqual(getUnmappedMonthCount(), 0)
  })

  it('parseDatePart resolves "Monday Sept 1" the same as the full month name', () => {
    resetUnmappedMonthCount()
    const abbrev = parseDatePart('Monday Sept 1')
    const full   = parseDatePart('Monday September 1')
    assert.deepStrictEqual(abbrev, full)
    assert.ok(abbrev.length > 0, 'Sept should resolve to a date')
    assert.strictEqual(getUnmappedMonthCount(), 0)
  })

  it('rejects a garbage month token and counts it as unmapped', () => {
    resetUnmappedMonthCount()
    const result = parseDatePart('Monday Foo 1')
    assert.deepStrictEqual(result, [])
    assert.strictEqual(getUnmappedMonthCount(), 1)
  })
})

// ── parseHomepage fixtures ────────────────────────────────────────────────
//
// Captured shape of the live homepage: WordPress chrome (header logo <img>,
// inline <script>/<style>), then one block per film — poster <img>, quoted
// title, "Rated:", "(NNN min)", and one or more showtime lines. Film A packs
// two day segments onto a single text line; film B uses a "thru" range.
//
// This fixture LOCKS the selector. The nightly failures this file guards are
// bad response BODIES, not markup drift, so loosening the parse to make a
// challenge page "work" would convert a loud failure into a silent partial —
// exactly the wrong trade. A challenge body must still yield zero films.
const GOOD_HOMEPAGE_HTML = `
<!doctype html><html><head>
<style>.poster{width:100%}</style>
<script>window.dataLayer=[];</script>
</head><body>
<header><img src="https://highlandsquaretheatre.com/wp-content/uploads/logo.png" alt="Highland Square Theatre"></header>
<div class="entry-content">
  <p><img src="https://highlandsquaretheatre.com/wp-content/uploads/wallis-island.jpg" alt="poster"></p>
  <p>&ldquo;The Ballad of Wallis Island&rdquo;</p>
  <p>Rated: PG13</p>
  <p>(100 min)</p>
  <p>Monday Aug 4: 4:15, 7:00&nbsp;&nbsp;Tuesday Aug 5: 4:15, 7:00</p>
  <p><img src="https://highlandsquaretheatre.com/wp-content/uploads/superman.jpg" alt="poster"></p>
  <p>"Superman"</p>
  <p>Rated: PG13</p>
  <p>(130 min)</p>
  <p>Mon thru Wed, Aug 11-13: 7:00</p>
  <p>All times are PM unless otherwise noted.</p>
</div>
</body></html>`

// A Cloudflare-style interstitial served with HTTP 200 — the actual nightly
// failure mode behind the old "markup may have changed" message.
const BOT_CHALLENGE_HTML = `
<!doctype html><html><head><title>Just a moment...</title></head>
<body class="no-js">
<div class="main-wrapper"><h1>Checking your browser before accessing highlandsquaretheatre.com</h1>
<p>Please enable JavaScript and cookies to continue.</p>
<p>Ray ID: 8f2c1a9b0e4d7c31 &middot; Performance &amp; security by Cloudflare</p></div>
</body></html>`

describe('Highland Square parseHomepage', () => {
  it('returns [] on a bot-challenge body (loud failure, never a silent partial)', () => {
    resetUnmappedMonthCount()
    assert.deepStrictEqual(parseHomepage(BOT_CHALLENGE_HTML), [])
  })

  it('returns [] on empty/nullish HTML', () => {
    assert.deepStrictEqual(parseHomepage(''), [])
    assert.deepStrictEqual(parseHomepage(null), [])
  })

  it('parses films, ratings, runtimes, posters and showtimes from the good fixture', () => {
    resetUnmappedMonthCount()
    const movies = parseHomepage(GOOD_HOMEPAGE_HTML)

    assert.strictEqual(movies.length, 2, 'two film blocks')
    assert.deepStrictEqual(movies.map(m => m.title), [
      'The Ballad of Wallis Island',
      'Superman',
    ])

    const [wallis, superman] = movies
    assert.strictEqual(wallis.rating, 'PG13')
    assert.strictEqual(wallis.runtimeMin, 100)
    assert.ok(wallis.imageUrl?.endsWith('wallis-island.jpg'), 'poster wins over the header logo')
    // Packed line: two day segments x two times each
    assert.strictEqual(wallis.showtimes.length, 4)
    assert.deepStrictEqual([...new Set(wallis.showtimes.map(s => s.timeStr24))].sort(), [
      '16:15:00', '19:00:00',
    ])

    assert.strictEqual(superman.runtimeMin, 130)
    assert.ok(superman.imageUrl?.endsWith('superman.jpg'))
    // "Mon thru Wed, Aug 11-13: 7:00" expands to three dates, one time each
    assert.strictEqual(superman.showtimes.length, 3)
    assert.strictEqual(new Set(superman.showtimes.map(s => s.dateYmd)).size, 3)
    assert.ok(superman.showtimes.every(s => s.timeStr24 === '19:00:00'))

    assert.strictEqual(getUnmappedMonthCount(), 0, 'no month token should fail to map')
  })
})
