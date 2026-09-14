/**
 * test-fixture-secrets.js
 *
 * Regression coverage for the 2026-09-12 fixture credential leak.
 *
 * THE INCIDENT: commit 23e60fe8 ("fix(nightly): habitat_summit retires
 * stale-date rows after a reschedule") added a 792-line fixture saved verbatim
 * off hfhsummitcounty.org. Line 77 of that page is the WordPress ECWD plugin
 * loading the Google Maps JS API with a browser key in the query string. The
 * key went public in this repo and GitHub secret scanning opened an alert on
 * ByronDDelpinal/akron-events.
 *
 * Nothing of ours leaked — it was Habitat for Humanity of Summit County's own
 * public key, already served to every visitor of their site. That is exactly
 * why it is easy to do again: the capture is mechanical, the credential belongs
 * to someone else, and no human reads 792 lines of saved markup before
 * committing it.
 *
 * THE GUARD: fixtures are raw third-party bytes, so every one of them gets
 * scanned for provider-shaped credentials on every test run. There is no shared
 * capture helper to hook — agents curl pages into scripts/tests/fixtures/ ad
 * hoc — so this test is the enforcement point, and CI runs `npm test`.
 *
 * WHEN THIS TEST FAILS: do not delete the fixture and do not loosen the
 * pattern. Scrub the value with scrubText() from scripts/lib/fixture-secrets.js
 * and re-commit the fixture. If the credential is genuinely ours, rotate it
 * first — the scan only removes the copy in this repo, not the exposure.
 *
 * Run:  node --test scripts/tests/test-fixture-secrets.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanText, scrubText, maskSecret, SECRET_PATTERNS } from '../lib/fixture-secrets.js'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(TESTS_DIR, 'fixtures')

/**
 * Sample credentials are ASSEMBLED AT RUNTIME rather than written as literals.
 * A literal of the right shape in this file would itself trip GitHub secret
 * scanning — the failure mode this test exists to prevent.
 */
const samples = {
  GOOGLE_API_KEY: 'AIza' + 'Sy' + 'B'.repeat(33),
  GITHUB_TOKEN: 'gh' + 'p_' + 'c'.repeat(36),
  SLACK_TOKEN: 'xo' + 'xb-' + '1234567890' + '-abcdefghij',
  STRIPE_SECRET_KEY: 's' + 'k_live_' + 'd'.repeat(24),
  AWS_ACCESS_KEY_ID: 'AK' + 'IA' + 'E'.repeat(16),
  PRIVATE_KEY_BLOCK: '-----BEGIN' + ' RSA PRIVATE KEY-----',
}

function walkFixtures(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkFixtures(full))
    else out.push(full)
  }
  return out
}

describe('fixture secret scan', () => {
  const files = walkFixtures(FIXTURES)

  it('finds fixtures to scan (guards against a silently empty walk)', () => {
    assert.ok(files.length > 50, `expected the fixture corpus, saw ${files.length} files`)
  })

  it('no committed fixture contains a provider-shaped credential', () => {
    const offenders = []
    for (const file of files) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue // unreadable as text; nothing a credential regex can match
      }
      for (const finding of scanText(text)) {
        offenders.push(
          `${relative(TESTS_DIR, file)}:${finding.line} — ${finding.name} (${finding.masked})`,
        )
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Credentials found in test fixtures:\n  ${offenders.join('\n  ')}\n\n` +
        'Scrub with scrubText() from scripts/lib/fixture-secrets.js before committing. ' +
        'If the credential is ours, rotate it first.',
    )
  })
})

describe('fixture secret patterns', () => {
  it('every pattern is global, or scanText silently reports one hit per file', () => {
    for (const { name, re } of SECRET_PATTERNS) {
      assert.ok(re.global, `${name} must be a /g regex`)
    }
  })

  for (const [name, value] of Object.entries(samples)) {
    it(`detects ${name}`, () => {
      const findings = scanText(`prefix ${value} suffix`)
      assert.ok(
        findings.some((f) => f.name === name),
        `${name} not detected; got ${JSON.stringify(findings)}`,
      )
    })
  }

  it('reports the line number, not just the fact of a hit', () => {
    const text = `line one\nline two\nkey=${samples.GOOGLE_API_KEY}\n`
    assert.equal(scanText(text)[0].line, 3)
  })

  it('never echoes a full credential into the failure message', () => {
    const [finding] = scanText(samples.GOOGLE_API_KEY)
    assert.ok(!finding.masked.includes(samples.GOOGLE_API_KEY))
    assert.ok(finding.masked.includes('…'))
  })

  it('leaves ordinary fixture noise alone (cache busters, versions, ids)', () => {
    const benign = [
      'style.min.css?ver=4.27.8',
      'jquery.min.js?ver=3.7.1',
      '&#038;ver=1.1.53_5af316aa7a21f',
      'GTM-XXXXXXX',
      'G-ABCDEFGHIJ',
      'UA-123456789-1',
      'data-event-id="9f8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d"',
    ].join('\n')
    assert.deepEqual(scanText(benign), [])
  })
})

describe('scrubText', () => {
  it('removes the credential and leaves surrounding markup intact', () => {
    const tag = `<script src="https://maps.googleapis.com/maps/api/js?v=3.exp&key=${samples.GOOGLE_API_KEY}&ver=1.1"></script>`
    const scrubbed = scrubText(tag)
    assert.ok(!scrubbed.includes(samples.GOOGLE_API_KEY))
    assert.ok(scrubbed.startsWith('<script src="https://maps.googleapis.com/maps/api/js?v=3.exp&key='))
    assert.ok(scrubbed.endsWith('&ver=1.1"></script>'))
  })

  it('produces output the scanner accepts, and is idempotent', () => {
    const once = scrubText(`key=${samples.GOOGLE_API_KEY}`)
    assert.deepEqual(scanText(once), [])
    assert.equal(scrubText(once), once)
  })

  it('scrubs every occurrence, not just the first', () => {
    const repeated = Array(3).fill(`key=${samples.GOOGLE_API_KEY}`).join('\n')
    assert.deepEqual(scanText(scrubText(repeated)), [])
  })
})

describe('the habitat_summit regression specifically', () => {
  const HABITAT = join(FIXTURES, 'habitat-summit-events-2026-09.html')

  it('the fixture that leaked is clean and still carries the redacted tag', () => {
    const html = readFileSync(HABITAT, 'utf8')
    assert.deepEqual(scanText(html), [])
    assert.ok(
      html.includes('maps.googleapis.com/maps/api/js'),
      'the ECWD map tag should stay in the fixture — the parser sees this markup in production',
    )
    assert.ok(html.includes('REDACTED-THIRD-PARTY-GOOGLE-API-KEY'))
  })

  it('would have failed on the fixture as originally committed', () => {
    const original = readFileSync(HABITAT, 'utf8').replace(
      /REDACTED-THIRD-PARTY-GOOGLE-API-KEY/g,
      samples.GOOGLE_API_KEY,
    )
    const findings = scanText(original)
    assert.equal(findings.length, 3, 'the original fixture carried the key three times')
    assert.equal(findings[0].name, 'GOOGLE_API_KEY')
    assert.ok(maskSecret(samples.GOOGLE_API_KEY).startsWith('AIza'))
  })
})
