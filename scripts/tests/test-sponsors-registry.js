/**
 * test-sponsors-registry.js — shape guards on src/lib/sponsors.ts.
 *
 * The sponsor list is the one place on /financials where an outside party's
 * name and logo appear, so every failure here is a public one:
 *   - a missing `support` prints an in-kind supporter as if they wrote a
 *     cheque, under a table of real dollar amounts
 *   - a logo path pointing at a file nobody committed renders a broken image
 *     next to a business's name
 *   - a duplicate key collapses two supporters into one React node
 *
 * sponsors.ts is TypeScript, which node can't import, so entries are
 * extracted textually (same approach as test-manifest-sync.js).
 *
 * The registry is currently EMPTY and that is a passing state, asserted
 * explicitly below. Nobody should ever need to invent a sponsor in
 * src/lib/sponsors.ts to get CI green — the inline fixtures in this file
 * exist precisely so that stays true while the rules still get exercised on
 * every run.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SPONSORS_REL = 'src/lib/sponsors.ts'
const src = fs.readFileSync(path.join(ROOT, SPONSORS_REL), 'utf8')

const YM = /^\d{4}-\d{2}$/
const SUPPORT_VALUES = ['cash', 'in-kind']

// ── Textual extraction ──────────────────────────────────────────────────────

const arrayMatch = src.match(/export const SPONSORS:\s*Sponsor\[\]\s*=\s*\[([\s\S]*?)\n?\]\s*\n/)
assert.ok(
  arrayMatch,
  `could not locate the SPONSORS array in ${SPONSORS_REL} — this guard needs updating, not deleting`,
)

const field = (entry, name) => entry.match(new RegExp(`${name}:\\s*'([^']*)'`))?.[1]

const SPONSORS = arrayMatch[1]
  .split(/\n {2}\{\n/)
  .slice(1)
  .map((entry) => ({
    key: field(entry, 'key'),
    name: field(entry, 'name'),
    url: field(entry, 'url'),
    logo: field(entry, 'logo'),
    support: field(entry, 'support'),
    since: field(entry, 'since'),
    until: field(entry, 'until'),
  }))

// ── The validator, applied to the real registry AND to an empty one ─────────

/**
 * Every rule in one function, exercised against the real registry AND against
 * the inline fixtures below.
 *
 * The fixtures are load-bearing, not decoration. While SPONSORS is empty
 * `for (const s of [])` runs zero iterations, so calling this on the real
 * registry proves nothing at all: a typo in a field name here, or deleting
 * the entire logo-existence block, left the suite green at 26/26. The
 * validator was unguarded during exactly the window that matters — before
 * the first sponsor exists, when nobody has ever seen it run.
 *
 * `exists` is injectable so the good-path fixture can carry a logo without
 * committing a placeholder asset under public/sponsors/. The real registry
 * and every failure fixture use the real filesystem.
 */
function validate(sponsors, { exists = (p) => fs.existsSync(p) } = {}) {
  const seen = new Set()
  for (const s of sponsors) {
    const at = `sponsor '${s.key ?? '(no key)'}'`

    assert.ok(s.key, `${at}: every entry needs a stable key (used as the React key and logo filename)`)
    assert.ok(s.name, `${at}: name is required — it is the only field that must render`)
    assert.ok(s.since, `${at}: since is required (YYYY-MM); it drives display order`)

    assert.ok(!seen.has(s.key), `duplicate sponsor key '${s.key}' — keys are never reused, even after a supporter retires`)
    seen.add(s.key)

    assert.ok(
      SUPPORT_VALUES.includes(s.support),
      `${at}: support is '${s.support}', must be exactly 'cash' or 'in-kind'. An in-kind supporter ` +
        'shown without that qualifier, under a table of real dollar amounts, implies money the ' +
        'project never received.',
    )

    assert.match(s.since, YM, `${at}: since '${s.since}' must be YYYY-MM`)
    if (s.until != null) {
      assert.match(s.until, YM, `${at}: until '${s.until}' must be YYYY-MM`)
      assert.ok(
        s.until >= s.since,
        `${at}: until '${s.until}' is before since '${s.since}'`,
      )
    }

    if (s.url != null) {
      assert.ok(
        s.url.startsWith('https://'),
        `${at}: url '${s.url}' must start with https://`,
      )
    }

    if (s.logo != null) {
      assert.ok(
        s.logo.startsWith('/sponsors/'),
        `${at}: logo '${s.logo}' must live under /sponsors/`,
      )
      const onDisk = path.join(ROOT, 'public', s.logo)
      assert.ok(
        exists(onDisk),
        `${at}: logo '${s.logo}' has no file at public${s.logo}. A missing asset renders as a ` +
          "broken image beside a business's name.",
      )
    }

    assert.ok(
      !s.name.includes('<'),
      `${at}: name contains '<'. Sponsor names are plain text, never markup.`,
    )
  }
  return sponsors.length
}

// ── Fixtures: what a good entry looks like, and every way to get it wrong ────

/** The reference entry. Everything below is this, with one thing broken. */
const GOOD = {
  key: 'example-hardware',
  name: 'Example Hardware',
  url: 'https://example.com',
  logo: undefined,
  support: 'cash',
  since: '2026-08',
  until: undefined,
}

const withField = (patch) => [{ ...GOOD, ...patch }]

// ── Assertions ───────────────────────────────────────────────────────────────

describe('the validator itself catches bad entries', () => {
  // These run whether or not SPONSORS has anything in it. Without them every
  // rule above is dead code until the first sponsor is added, which is the
  // one moment it needs to already work.
  it('accepts a well-formed entry', () => {
    assert.equal(validate(withField({})), 1)
  })

  it('accepts a well-formed entry carrying a logo', () => {
    // exists() is stubbed: the real rule (the file must be committed) is
    // proved by the failure case below, against the real filesystem.
    assert.equal(
      validate(withField({ logo: '/sponsors/example-hardware.svg' }), { exists: () => true }),
      1,
    )
  })

  it('rejects a support value outside cash / in-kind', () => {
    assert.throws(() => validate(withField({ support: 'sponsorship' })), /must be exactly/)
    assert.throws(() => validate(withField({ support: undefined })), /must be exactly/)
  })

  it('rejects a missing since', () => {
    assert.throws(() => validate(withField({ since: undefined })), /since is required/)
  })

  it('rejects a since that is not YYYY-MM', () => {
    assert.throws(() => validate(withField({ since: 'August 2026' })), /must be YYYY-MM/)
  })

  it('rejects a missing key or name', () => {
    assert.throws(() => validate(withField({ key: undefined })), /needs a stable key/)
    assert.throws(() => validate(withField({ name: undefined })), /name is required/)
  })

  it('rejects a duplicate key', () => {
    assert.throws(
      () => validate([{ ...GOOD }, { ...GOOD, name: 'Example Hardware LLC' }]),
      /duplicate sponsor key/,
    )
  })

  it('rejects a non-https url', () => {
    assert.throws(() => validate(withField({ url: 'http://example.com' })), /must start with https/)
  })

  it('rejects a logo path outside /sponsors/', () => {
    assert.throws(
      () => validate(withField({ logo: '/images/example-hardware.svg' })),
      /must live under \/sponsors\//,
    )
  })

  it('rejects a declared logo with no file on disk', () => {
    // Real fs, no stub: this is the rule that fails publicly as a broken
    // image beside a business's name.
    assert.throws(
      () => validate(withField({ logo: '/sponsors/no-such-file-8f2a.svg' })),
      /has no file at public/,
    )
  })

  it('rejects markup in a sponsor name', () => {
    assert.throws(
      () => validate(withField({ name: '<script>Example</script>' })),
      /never markup/,
    )
  })

  it('rejects an until earlier than since', () => {
    assert.throws(() => validate(withField({ until: '2026-07' })), /is before since/)
  })

  it('accepts a retired entry whose until is on or after since', () => {
    assert.equal(validate(withField({ until: '2026-08' })), 1)
    assert.equal(validate(withField({ until: '2027-01' })), 1)
  })
})

describe('sponsors registry', () => {
  it('an empty registry is valid', () => {
    // Load-bearing: the /financials empty state IS the pitch. Nobody should
    // ever seed a placeholder sponsor row to make this suite pass.
    assert.equal(validate([]), 0)
  })

  it('every entry has key, name, support, and since; keys are unique', () => {
    validate(SPONSORS)
  })

  it('dates, urls, logos, and names all hold their contracts', () => {
    // Same validator; named separately so a failure reads as the right rule.
    validate(SPONSORS)
  })

  it('registry parsing did not silently swallow entries', () => {
    const declaredKeys = [...arrayMatch[1].matchAll(/key:\s*'([^']+)'/g)].length
    assert.equal(
      SPONSORS.length,
      declaredKeys,
      `parsed ${SPONSORS.length} sponsors but found ${declaredKeys} key: declarations in ` +
        `${SPONSORS_REL} — the textual extractor is out of step with the file's formatting`,
    )
  })
})
