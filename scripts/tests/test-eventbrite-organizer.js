/**
 * test-eventbrite-organizer.js — organizer extraction for the Eventbrite scraper
 *
 * These tests import the REAL exported parsers from scrape-eventbrite.js.
 * (test-eventbrite.js deliberately does not — it keeps its own local copy of
 * normaliseEvent — so it can pass while the shipped scraper is broken. That is
 * exactly how the missing-organizer bug survived a green suite: 498 of 525
 * Eventbrite rows published with no presenter at all.)
 *
 * Run:
 *   node --test scripts/tests/test-eventbrite-organizer.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { extractOrganizer, cleanOrganizer } = await import('../scrape-eventbrite.js')

// Modelled on the real page that surfaced this bug:
// eventbrite.com/e/docents-at-kirby-mill-tickets-1992458073734
const ldJsonPage = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@type":"Event","name":"Docents at Kirby Mill","startDate":"2026-07-19T13:00:00-04:00",
 "description":"Join us at the mill.",
 "organizer":{"@type":"Organization","name":"Friends of Richfield Heritage Preserve","url":"https://www.eventbrite.com/o/friends-123"}}
</script></head><body></body></html>`

describe('eventbrite: cleanOrganizer', () => {
  it('trims and returns name + website', () => {
    assert.deepEqual(
      cleanOrganizer('  Friends of Richfield Heritage Preserve  ', ' https://example.org '),
      { name: 'Friends of Richfield Heritage Preserve', website: 'https://example.org' })
  })

  it('decodes HTML entities in the name', () => {
    assert.equal(cleanOrganizer('Bounce &amp; Co.')?.name, 'Bounce & Co.')
  })

  it('returns null website when none given', () => {
    assert.deepEqual(cleanOrganizer('Some Org'), { name: 'Some Org', website: null })
  })

  it('rejects the aggregator self-credit', () => {
    // The whole point of the fix: never assert "Eventbrite presents this".
    assert.equal(cleanOrganizer('Eventbrite'), null)
    assert.equal(cleanOrganizer('  eventbrite  '), null)
  })

  it('rejects empty / non-string input', () => {
    assert.equal(cleanOrganizer(''), null)
    assert.equal(cleanOrganizer(null), null)
    assert.equal(cleanOrganizer(undefined), null)
    assert.equal(cleanOrganizer('   '), null)
    assert.equal(cleanOrganizer({ name: 'x' }), null)
  })
})

describe('eventbrite: extractOrganizer', () => {
  it('extracts the organizer from JSON-LD (the real Kirby Mill shape)', () => {
    assert.deepEqual(extractOrganizer(ldJsonPage), {
      name:    'Friends of Richfield Heritage Preserve',
      website: 'https://www.eventbrite.com/o/friends-123',
    })
  })

  it('handles an organizer given as an array', () => {
    const html = `<script type="application/ld+json">
      {"@type":"Event","organizer":[{"@type":"Organization","name":"First Org"}]}</script>`
    assert.equal(extractOrganizer(html)?.name, 'First Org')
  })

  it('falls back to "primary_organizer" internal JSON', () => {
    const html = `<script>window.__SERVER_DATA__ = {"event":{"primary_organizer":{"id":"9","name":"Summit Land Bank"}}};</script>`
    assert.equal(extractOrganizer(html)?.name, 'Summit Land Bank')
  })

  it('falls back to "organizer" internal JSON', () => {
    const html = `<script>var x = {"organizer":{"id":"9","name":"Cuyahoga Valley Art Center"}};</script>`
    assert.equal(extractOrganizer(html)?.name, 'Cuyahoga Valley Art Center')
  })

  it('falls back to a bare "organizer_name" key', () => {
    assert.equal(extractOrganizer(`<script>{"organizer_name":"Better Kenmore CDC"}</script>`)?.name,
      'Better Kenmore CDC')
  })

  it('skips a self-crediting shape and keeps looking for the real host', () => {
    // A page can name Eventbrite in one blob and the actual host in another —
    // a self-credit must not short-circuit the search.
    const html = `<script type="application/ld+json">
      {"@type":"Event","organizer":{"@type":"Organization","name":"Eventbrite"}}</script>
      <script>{"organizer_name":"Friends of Richfield Heritage Preserve"}</script>`
    assert.equal(extractOrganizer(html)?.name, 'Friends of Richfield Heritage Preserve')
  })

  it('returns null when the page names no organizer', () => {
    assert.equal(extractOrganizer('<html><body>Nothing here</body></html>'), null)
  })

  it('returns null when the ONLY organizer is the self-credit', () => {
    assert.equal(extractOrganizer(`<script>{"organizer_name":"Eventbrite"}</script>`), null)
  })

  it('survives a malformed ld+json block and still reads a later shape', () => {
    const html = `<script type="application/ld+json">{ this is not json }</script>
      <script>{"organizer_name":"Downtown Akron Partnership"}</script>`
    assert.equal(extractOrganizer(html)?.name, 'Downtown Akron Partnership')
  })

  it('returns null for empty / non-string input', () => {
    assert.equal(extractOrganizer(''), null)
    assert.equal(extractOrganizer(null), null)
    assert.equal(extractOrganizer(undefined), null)
  })

  it('does not let a nested object drift the name to another entity', () => {
    // The venue object appears first; the organizer's own "name" must win
    // rather than the regex reaching across into an unrelated block.
    const html = `<script>{"venue":{"name":"Kirby Mill","address":{"city":"Richfield"}},"organizer_name":"Friends of RHP"}</script>`
    assert.equal(extractOrganizer(html)?.name, 'Friends of RHP')
  })
})
