/**
 * test-prerender-timezone.js — the prerender pass must render in Eastern.
 *
 * The defect this guards: production prerendered HTML rendered every event
 * time shifted +4h. An event whose own title read "Mon 4:30-5:15pm" was
 * served as "8:30 PM". The database was correct; only the render path was
 * wrong.
 *
 * Why it happened: the site formats times in the *viewer's* local zone, and
 * during prerender the "viewer" is headless Chrome on the build machine.
 * scripts/prerender.js set no TZ and passed none to puppeteer.launch, so on a
 * UTC builder (CI, Vercel) Chrome formatted everything in UTC and the wrong
 * time was baked into static HTML that no client-side code ever re-renders.
 *
 * Why these checks are textual: scripts/prerender.js exports nothing and
 * calls main() unconditionally at the bottom, so importing it from the test
 * suite would boot an HTTP server on :4173 and launch Chrome. It has no
 * import-safe surface to exercise, so we assert on its source — the same
 * approach, on the same file, as the ROUTES guard in
 * scripts/tests/test-financials-page-guards.js.
 *
 * The one non-textual check is on the pinned zone itself: we run real
 * Intl formatting through it, so a value that is merely a plausible-looking
 * string cannot pass.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SRC_REL = 'scripts/prerender.js'
const src = readFileSync(new URL(SRC_REL, `file://${ROOT}`), 'utf8')

// Anchored at line start: an assignment nested inside a function is indented
// and must NOT satisfy this guard. Only a module-scope assignment is
// guaranteed to have run before main() reaches launchBrowser().
const TZ_ASSIGNMENT = /^process\.env\.TZ\s*=\s*'([^']+)'/m

function wallClock(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso))
}

describe('prerender pins the render clock to Eastern', () => {
  it('assigns process.env.TZ at module scope', () => {
    assert.match(
      src,
      TZ_ASSIGNMENT,
      `${SRC_REL} must assign process.env.TZ at module scope (column 0). Without it, headless ` +
        'Chrome inherits the build machine\'s zone — UTC on CI and Vercel — and every event time ' +
        'in the prerendered HTML ships shifted. This is a static render: nothing re-corrects it ' +
        'in the browser.',
    )
  })

  it('pins it to America/New_York', () => {
    const zone = src.match(TZ_ASSIGNMENT)?.[1]
    assert.equal(
      zone,
      'America/New_York',
      `${SRC_REL} pins TZ to ${zone ?? '(nothing)'}. Akron is America/New_York; the zone must be ` +
        'named, not an offset, so DST is handled for both EST and EDT halves of the year.',
    )
  })

  it('the pinned zone really is Eastern, in both DST halves', () => {
    const zone = src.match(TZ_ASSIGNMENT)?.[1]
    assert.ok(zone, 'no TZ assignment to validate')
    // EDT (UTC-4) in July, EST (UTC-5) in January. Both land on 12:00 PM only
    // for a true Eastern zone, which rules out UTC and any fixed offset.
    assert.equal(wallClock('2026-07-01T16:00:00Z', zone), '12:00 PM', 'summer instant is not EDT')
    assert.equal(wallClock('2026-01-01T17:00:00Z', zone), '12:00 PM', 'winter instant is not EST')
  })

  it('reproduces the reported defect: the +4h shift is gone', () => {
    const zone = src.match(TZ_ASSIGNMENT)?.[1]
    assert.ok(zone, 'no TZ assignment to validate')
    // The instant behind the bug report: an event starting 4:30 PM Eastern,
    // which the UTC build rendered as 8:30 PM.
    const instant = '2026-09-14T20:30:00Z'
    assert.equal(wallClock(instant, 'UTC'), '8:30 PM', 'fixture no longer reproduces the bug')
    assert.equal(
      wallClock(instant, zone),
      '4:30 PM',
      'the pinned zone still renders the reported event at the wrong hour',
    )
  })
})

describe('the pin reaches Chrome', () => {
  it('is set before puppeteer is imported or launched', () => {
    const tzAt = src.search(TZ_ASSIGNMENT)
    assert.ok(tzAt >= 0, `${SRC_REL} has no module-scope process.env.TZ assignment`)
    for (const [label, needle] of [
      ['the puppeteer import', "import('puppeteer')"],
      ['puppeteer.launch', 'puppeteer.launch('],
    ]) {
      const at = src.indexOf(needle)
      assert.ok(at >= 0, `could not locate ${label} in ${SRC_REL} — update this guard, don't delete it`)
      assert.ok(
        tzAt < at,
        `process.env.TZ is assigned after ${label}. Chrome reads TZ from the environment at spawn ` +
          'time, so the assignment has to happen first.',
      )
    }
  })

  it('covers both launch branches', () => {
    // launchBrowser() falls back to @sparticuz/chromium when bundled Chrome
    // can't start. Neither branch sets a zone of its own, so both depend on
    // inheriting the module-scope assignment above. If a third launch path is
    // ever added, this count fails and forces a look.
    const launches = src.match(/puppeteer\.launch\(/g) ?? []
    assert.equal(
      launches.length,
      2,
      `${SRC_REL} has ${launches.length} puppeteer.launch() call(s); this guard knows about 2 ` +
        '(bundled Chrome and the @sparticuz/chromium fallback). A new launch path must also ' +
        'inherit the Eastern pin — confirm it does, then update this count.',
    )
    assert.match(src, /@sparticuz\/chromium/, 'the documented fallback launch branch is gone')
  })

  it('no launch call overrides the child environment', () => {
    // The pin works purely by inheritance: puppeteer spawns the browser with
    // `env: process.env` unless told otherwise. Passing an explicit `env`
    // would silently drop TZ and bring the bug straight back.
    assert.ok(
      !/puppeteer\.launch\(\{[^}]*\benv\s*:/s.test(src),
      `a puppeteer.launch() call in ${SRC_REL} passes an explicit env. That replaces the inherited ` +
        'environment and drops TZ. Either omit env, or spread process.env into it and set TZ there.',
    )
  })
})
