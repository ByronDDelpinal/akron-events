/**
 * test-json-ld.js — tests for the shared JSON-LD helper in lib/json-ld.js.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { extractJsonLd, findSchemaObjects, isoDurationToMinutes, firstImageUrl } from '../lib/json-ld.js'

// ── extractJsonLd ─────────────────────────────────────────────────────────

describe('json-ld: extractJsonLd', () => {
  it('returns [] for empty or non-string input', () => {
    assert.deepEqual(extractJsonLd(null), [])
    assert.deepEqual(extractJsonLd(undefined), [])
    assert.deepEqual(extractJsonLd(''), [])
    assert.deepEqual(extractJsonLd(42), [])
  })

  it('parses a single JSON-LD block', () => {
    const html = '<script type="application/ld+json">{"@type":"Movie","name":"X"}</script>'
    const out = extractJsonLd(html)
    assert.equal(out.length, 1)
    assert.equal(out[0]['@type'], 'Movie')
    assert.equal(out[0].name, 'X')
  })

  it('parses multiple blocks', () => {
    const html = `
      <script type="application/ld+json">{"@type":"MovieTheater","name":"V"}</script>
      <script type="application/ld+json">{"@type":"Movie","name":"M"}</script>`
    const out = extractJsonLd(html)
    assert.equal(out.length, 2)
    assert.deepEqual(out.map(o => o['@type']), ['MovieTheater', 'Movie'])
  })

  it('unwraps @graph arrays', () => {
    const html = `
      <script type="application/ld+json">
      { "@context":"https://schema.org", "@graph":[
        {"@type":"MovieTheater","name":"V"},
        {"@type":"Movie","name":"M"}
      ]}
      </script>`
    const out = extractJsonLd(html)
    assert.equal(out.length, 2)
    assert.deepEqual(out.map(o => o['@type']), ['MovieTheater', 'Movie'])
  })

  it('handles top-level arrays', () => {
    const html = '<script type="application/ld+json">[{"@type":"A"},{"@type":"B"}]</script>'
    const out = extractJsonLd(html)
    assert.equal(out.length, 2)
  })

  it('skips malformed blocks but keeps good ones', () => {
    const html = `
      <script type="application/ld+json">{not valid json}</script>
      <script type="application/ld+json">{"@type":"Movie","name":"Z"}</script>`
    const out = extractJsonLd(html)
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'Z')
  })

  it('supports single-quoted type attribute', () => {
    const html = `<script type='application/ld+json'>{"@type":"Movie"}</script>`
    assert.equal(extractJsonLd(html).length, 1)
  })

  it('is case-insensitive on the script type attribute', () => {
    const html = `<SCRIPT TYPE="application/ld+json">{"@type":"Movie"}</SCRIPT>`
    assert.equal(extractJsonLd(html).length, 1)
  })
})

// ── findSchemaObjects ─────────────────────────────────────────────────────

describe('json-ld: findSchemaObjects', () => {
  const objs = [
    { '@type': 'Movie', name: 'A' },
    { '@type': 'MovieTheater', name: 'V' },
    { '@type': ['Movie', 'CreativeWork'], name: 'B' },
    { name: 'No type' },
    null,
  ]

  it('matches single string type', () => {
    const out = findSchemaObjects(objs, 'Movie')
    assert.equal(out.length, 2)
    assert.deepEqual(out.map(o => o.name), ['A', 'B'])
  })

  it('matches when @type is an array', () => {
    const out = findSchemaObjects(objs, 'CreativeWork')
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'B')
  })

  it('accepts a types array (OR match)', () => {
    const out = findSchemaObjects(objs, ['Movie', 'MovieTheater'])
    assert.equal(out.length, 3)
  })

  it('returns [] for non-array input', () => {
    assert.deepEqual(findSchemaObjects(null, 'Movie'), [])
    assert.deepEqual(findSchemaObjects('nope', 'Movie'), [])
  })
})

// ── isoDurationToMinutes ──────────────────────────────────────────────────

describe('json-ld: isoDurationToMinutes', () => {
  it('parses the canonical forms', () => {
    assert.equal(isoDurationToMinutes('PT2H3M'),   123)
    assert.equal(isoDurationToMinutes('PT45M'),     45)
    assert.equal(isoDurationToMinutes('PT1H'),      60)
    assert.equal(isoDurationToMinutes('PT1H30M30S'), 90)
  })

  it('is case-insensitive on the prefix', () => {
    assert.equal(isoDurationToMinutes('pt2h3m'), 123)
  })

  it('returns null for unparseable input', () => {
    assert.equal(isoDurationToMinutes(null), null)
    assert.equal(isoDurationToMinutes(''), null)
    assert.equal(isoDurationToMinutes('2h3m'), null)       // missing PT prefix
    assert.equal(isoDurationToMinutes('PT'), null)          // empty body
    assert.equal(isoDurationToMinutes('P1DT2H'), null)      // date component — out of scope
    assert.equal(isoDurationToMinutes(123), null)           // non-string
  })
})

// ── firstImageUrl ─────────────────────────────────────────────────────────

describe('json-ld: firstImageUrl', () => {
  it('handles a plain URL string', () => {
    assert.equal(firstImageUrl('https://x.com/a.jpg'), 'https://x.com/a.jpg')
  })

  it('handles an ImageObject', () => {
    assert.equal(firstImageUrl({ url: 'https://x.com/b.jpg' }), 'https://x.com/b.jpg')
    assert.equal(firstImageUrl({ contentUrl: 'https://x.com/c.jpg' }), 'https://x.com/c.jpg')
  })

  it('handles an array — first valid URL wins', () => {
    assert.equal(firstImageUrl(['not a url', 'https://x.com/d.jpg']), 'https://x.com/d.jpg')
  })

  it('rejects non-http URLs', () => {
    assert.equal(firstImageUrl('data:image/png;base64,abc'), null)
    assert.equal(firstImageUrl('/relative/path.jpg'), null)
  })

  it('returns null for empty / missing input', () => {
    assert.equal(firstImageUrl(null), null)
    assert.equal(firstImageUrl(undefined), null)
    assert.equal(firstImageUrl({}), null)
    assert.equal(firstImageUrl([]), null)
  })
})
