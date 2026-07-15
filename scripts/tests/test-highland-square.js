/**
 * test-highland-square.js
 *
 * Unit tests for scrape-highland-square.js's pure parser (parseHomepage).
 *
 * PROVENANCE: these assertions were rescued from `_tn.mjs`, a stray scratch
 * file at the repo root that was tracked in git but lived outside
 * scripts/tests/ — so `npm test` (which globs scripts/tests/test-*.js) never
 * ran them. They were dead weight masquerading as coverage. `_tn.mjs` also
 * duplicated tests for the-well-cdc and better-kenmore, which already have
 * real suites; Highland Square was the only parser it uniquely covered, so
 * that block moved here and the scratch file was deleted (docs/AUDIT.md L-1).
 *
 * Run:  node --test scripts/tests/test-highland-square.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { parseHomepage } from '../scrape-highland-square.js'

// Highland Square is a Wix SSR page: the date lives in an <h2> in the body,
// while the blurb and poster come from OpenGraph meta tags.
const HS_FIXTURE = `
<html><head>
<meta property="og:description" content="PorchROKR is a music Festival in Highland Square, Akron."/>
<meta property="og:image" content="https://static.wixstatic.com/media/poster.jpg"/>
</head><body>
<h2>AUGUST 15, 2026</h2>
<p>Join us for a day of music, food and fun!</p>
</body></html>`

describe('Highland Square: parseHomepage', () => {
  it('parses the PorchROKR date and OpenGraph metadata', () => {
    const ev = parseHomepage(HS_FIXTURE)
    assert.ok(ev)
    assert.equal(ev.dateStr, '2026-08-15')
    assert.equal(ev.title, 'PorchROKR Music & Arts Festival')
    assert.equal(ev.startTime, '11:00:00')
    assert.equal(ev.sourceId, 'porchrokr-2026')
    assert.ok(ev.description.includes('PorchROKR'))
    assert.ok(ev.imageUrl.includes('poster.jpg'))
  })

  it('returns null when no date is announced', () => {
    // The homepage sits dateless between festival years — that must yield no
    // event rather than a row with a bogus date.
    assert.equal(parseHomepage('<html><body>No festival announced</body></html>'), null)
  })

  it('does not throw on empty or malformed input', () => {
    assert.doesNotThrow(() => parseHomepage(''))
    assert.doesNotThrow(() => parseHomepage('<html>'))
  })
})
