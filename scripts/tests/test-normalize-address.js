import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeStreetAddress, looksLikeStreetAddress } from '../lib/normalize.js'

// ── normalizeStreetAddress ─────────────────────────────────────────────────────────
// Canonicalizes a street line for equality comparison: street line only,
// lowercased, punctuation stripped, suffixes abbreviated.
test('normalizeStreetAddress canonicalizes punctuation, case, and street suffixes', () => {
  assert.equal(normalizeStreetAddress('943 Kenmore Blvd.'), '943 kenmore blvd')
  assert.equal(normalizeStreetAddress('1000 Kenmore Boulevard'), '1000 kenmore blvd')
  // Trailing city/state/zip is dropped (text after the first comma).
  assert.equal(normalizeStreetAddress('1000 Kenmore Blvd, Akron, OH 44314'), '1000 kenmore blvd')
  assert.equal(normalizeStreetAddress('  525   S   Main   Street  '), '525 s main st')
})

test('normalizeStreetAddress returns null for empty / non-string input', () => {
  assert.equal(normalizeStreetAddress(''), null)
  assert.equal(normalizeStreetAddress(null), null)
  assert.equal(normalizeStreetAddress(undefined), null)
  assert.equal(normalizeStreetAddress(42), null)
})

// The whole point: two surface forms of the same address collapse to one key.
test('normalizeStreetAddress makes equivalent addresses compare equal', () => {
  assert.equal(
    normalizeStreetAddress('943 Kenmore Blvd.'),
    normalizeStreetAddress('943 Kenmore Boulevard, Akron, OH 44314'),
  )
})

// Spelled-out directionals collapse to their abbreviation, so the same place
// written "East"/"E" (a common Eventbrite-vs-venue dupe) compares equal.
test('normalizeStreetAddress normalizes directionals', () => {
  assert.equal(normalizeStreetAddress('134 East Tallmadge Avenue'), '134 e tallmadge ave')
  assert.equal(
    normalizeStreetAddress('134 East Tallmadge Avenue'),
    normalizeStreetAddress('134 E Tallmadge Ave'),
  )
  assert.equal(normalizeStreetAddress('525 South Main Street'), '525 s main st')
  assert.equal(normalizeStreetAddress('100 Northwest Blvd'), '100 nw blvd')
})

// ── looksLikeStreetAddress ───────────────────────────────────────────────────
// Must require BOTH a leading house number AND a street-type suffix, so
// number-led venue NAMES are not misread as addresses.
test('looksLikeStreetAddress accepts real street addresses', () => {
  assert.equal(looksLikeStreetAddress('943 Kenmore Blvd.'), true)
  assert.equal(looksLikeStreetAddress('1000 Kenmore Boulevard'), true)
  assert.equal(looksLikeStreetAddress('525 S Main St, Akron'), true)
})

test('looksLikeStreetAddress rejects number-led venue names (no street suffix)', () => {
  assert.equal(looksLikeStreetAddress('1865 Brewing'), false)
  assert.equal(looksLikeStreetAddress('16-Bit Bar+Arcade'), false)
  assert.equal(looksLikeStreetAddress('The Rialto'), false)
  assert.equal(looksLikeStreetAddress('First Glance'), false)
})

test('looksLikeStreetAddress rejects empty / suffix-only / single-token input', () => {
  assert.equal(looksLikeStreetAddress(''), false)
  assert.equal(looksLikeStreetAddress('Blvd'), false)
  assert.equal(looksLikeStreetAddress('943'), false)
})
