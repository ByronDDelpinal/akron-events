/**
 * test-content-moderation.js — tests for the event content blocklist matcher.
 *
 * The real blocklist is never committed (it lives only in MODERATION_TERMS_B64).
 * So these tests inject their OWN small, representative term set via that same
 * env var — the matcher behaves identically, and the test stays self-contained.
 *
 * Run:
 *   node --test scripts/tests/test-content-moderation.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// A compact, representative config — NOT the production list. Enough to exercise
// every code path (severities, evasion, allowlist, Scunthorpe protection).
const FIXTURE = {
  version: 'test-fixture',
  categories: [
    { id: 'hate_groups', severity: 'high', terms: ['ku klux klan', 'kkk', 'proud boys', 'oath keepers', 'patriot front', 'neo-nazi', 'aryan nations'] },
    { id: 'hate_phrases', severity: 'high', terms: ['1488'] },
    { id: 'racial_ethnic_slurs', severity: 'high', terms: ['nigger', 'chink', 'paki'] },
    { id: 'racial_ethnic_contextual', severity: 'contextual', terms: ['negro', 'cracker'] },
    { id: 'anti_lgbtq_slurs', severity: 'high', terms: ['faggot', 'dyke'] },
    { id: 'ableist_slurs', severity: 'high', terms: ['retard'] },
    { id: 'ableist_contextual', severity: 'contextual', terms: ['midget'] },
    { id: 'gendered_slurs', severity: 'high', terms: ['cunt'] },
    { id: 'sexually_explicit', severity: 'high', terms: ['porn', 'hardcore porn', 'xxx'] },
    { id: 'sexual_contextual', severity: 'contextual', terms: ['nude', 'hooker'] },
    { id: 'hate_groups_contextual', severity: 'contextual', terms: ['nazi', 'boogaloo'] },
    { id: 'extreme_child_safety', severity: 'extreme', terms: ['child porn'] },
  ],
  allowlist: {
    phrases: [
      'Nutcracker', 'firecracker', 'Negro Leagues', 'Negro Spirituals', 'John Lee Hooker',
      'nude figure drawing', 'Scunthorpe', 'Pakistani', 'Van Dyke', 'grammar nazi',
      'electric boogaloo', 'midget car racing', 'Cracker Barrel',
    ],
  },
}

process.env.MODERATION_TERMS_B64 = Buffer.from(JSON.stringify(FIXTURE), 'utf8').toString('base64')

const {
  screenEvent,
  scanText,
  normalizeText,
  loadModerationConfig,
  STATUS_BY_SEVERITY,
} = await import('../lib/content-moderation.js')

loadModerationConfig({ force: true })

const flagged = (text) => screenEvent({ title: text }).flagged
const terms = (text) => scanText(text).map((m) => m.term)

describe('Moderation: config loads from MODERATION_TERMS_B64', () => {
  it('compiles the injected term list (no file dependency)', () => {
    const cfg = loadModerationConfig()
    assert.ok(cfg.terms.length > 0)
    assert.ok(cfg.allowlist.length > 0)
  })

  it('throws a typed error when the env var is missing', async () => {
    const mod = await import('../lib/content-moderation.js')
    const saved = process.env.MODERATION_TERMS_B64
    delete process.env.MODERATION_TERMS_B64
    try {
      assert.throws(() => mod.loadModerationConfig({ force: true }), mod.ModerationConfigError)
    } finally {
      process.env.MODERATION_TERMS_B64 = saved
      mod.loadModerationConfig({ force: true }) // restore cache for later tests
    }
  })
})

describe('Moderation: hate groups (explicitly requested)', () => {
  for (const phrase of [
    'Proud Boys rally downtown',
    'A Ku Klux Klan gathering',
    'KKK meetup',
    'Oath Keepers recruitment',
    'Patriot Front flyering',
    'neo-Nazi book club',
  ]) {
    it(`flags: "${phrase}"`, () => assert.equal(flagged(phrase), true))
  }

  it('KKK survives repeat-collapse normalization (regression)', () => {
    assert.ok(terms('the KKK').includes('kkk'))
  })
})

describe('Moderation: slurs & explicit content', () => {
  it('flags a racial slur', () => assert.equal(flagged('chink night'), true))
  it('flags an anti-LGBTQ+ slur', () => assert.equal(flagged('faggot fest'), true))
  it('flags an ableist slur', () => assert.equal(flagged('retard parade'), true))
  it('flags explicit sexual content', () => assert.equal(flagged('XXX hardcore porn party'), true))
})

describe('Moderation: evasion handling', () => {
  it('catches leetspeak (n1gg3r)', () => assert.ok(terms('n1gg3r night').includes('nigger')))
  it('catches repeat-padding (faaaaggot)', () => assert.ok(terms('faaaaggot').includes('faggot')))
  it('catches letter-spacing (f a g g o t) and marks it as evasion', () => {
    const m = scanText('come to the f a g g o t fest').find((x) => x.term === 'faggot')
    assert.ok(m)
    assert.equal(m.evasion, true)
  })
  it('catches a purely-numeric hate code (1488)', () => assert.ok(terms('1488 crew').includes('1488')))
})

describe('Moderation: false positives (Scunthorpe problem)', () => {
  for (const ok of [
    'The Nutcracker Ballet',
    'Firecracker 5K run',
    'Negro Leagues Baseball exhibit',
    'An evening of Negro Spirituals',
    'John Lee Hooker tribute',
    'Nude figure drawing class',
    'Scunthorpe United supporters night',
    'Pakistani cultural festival',
    'Dick Van Dyke film series',
    'Grammar Nazi comedy night',
    'Breakin 2: Electric Boogaloo screening',
    'Midget car racing at the speedway',
    'Live jazz and free pizza at the library',
  ]) {
    it(`does NOT flag: "${ok}"`, () => assert.equal(flagged(ok), false))
  }
})

describe('Moderation: reclaimed / intentionally-allowed terms', () => {
  it('does NOT flag "queer" (absent from list)', () => assert.equal(flagged('Queer Film Night'), false))
  it('does NOT flag "drag" (absent from list)', () => assert.equal(flagged('Sunday Drag Brunch'), false))
})

describe('Moderation: severity → status mapping', () => {
  it('high-severity slur → pending_review', () => {
    const r = screenEvent({ title: 'faggot fest' })
    assert.equal(r.severity, 'high')
    assert.equal(r.status, 'pending_review')
  })

  it('contextual term → pending_review', () => {
    const r = screenEvent({ title: 'the nazi rally' })
    assert.equal(r.severity, 'contextual')
    assert.equal(r.status, 'pending_review')
  })

  it('extreme tier → cancelled (auto-reject)', () => {
    const r = screenEvent({ description: 'child porn' })
    assert.equal(r.severity, 'extreme')
    assert.equal(r.status, 'cancelled')
    assert.equal(STATUS_BY_SEVERITY.extreme, 'cancelled')
  })

  it('clean event → not flagged, null status', () => {
    const r = screenEvent({ title: 'Akron Symphony spring concert' })
    assert.equal(r.flagged, false)
    assert.equal(r.status, null)
  })
})

describe('Moderation: field coverage', () => {
  it('scans description, organizer and tags — not just the title', () => {
    assert.equal(screenEvent({ title: 'Community Night', description: 'hosted by the Proud Boys' }).flagged, true)
    assert.equal(screenEvent({ title: 'Mixer', organizer_name: 'Aryan Nations' }).flagged, true)
    assert.equal(screenEvent({ title: 'Show', tags: ['music', 'kkk'] }).flagged, true)
  })
})

describe('Moderation: normalizeText', () => {
  it('lowercases and strips diacritics', () => {
    assert.equal(normalizeText('Café NAÏVE'), 'cafe naive')
  })
  it('collapses 3+ repeats only when asked', () => {
    assert.equal(normalizeText('soooo'), 'soooo')
    assert.equal(normalizeText('soooo', { collapseRepeats: true }), 'so')
  })
  it('de-leets only when asked', () => {
    assert.equal(normalizeText('h4ck3r', { deLeet: true }), 'hacker')
  })
  it('handles null/undefined safely', () => {
    assert.equal(normalizeText(null), '')
    assert.equal(normalizeText(undefined), '')
  })
})
