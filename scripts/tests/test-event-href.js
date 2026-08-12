/**
 * test-event-href.js — pure-logic unit tests for the event click-through
 * href builder (src/lib/eventHref.ts): internal vs external resolution per
 * embed target, the ticket_url/source_url fallback chain, embed search
 * carrying, and the no-id fallback. Node imports the .ts module directly
 * via type stripping (same pattern as test-when-filter.js) — eventHref
 * keeps RELATIVE imports for exactly this reason.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildEventHref, embedEventPath } from '../../src/lib/eventHref.ts'

const ORIGIN = 'https://akronpulse.test'

// Realistic event row; slug derives as cardboard-garden-may-28 under TZ=UTC.
const EVENT = {
  id: 'abc-123',
  title: 'Cardboard Garden',
  start_at: '2026-05-28T18:00:00',
  ticket_url: null,
  source_url: null,
}
const PATH = '/events/cardboard-garden-may-28/abc-123'

// Plain-object embed fixtures: buildEventHref only reads `target`, so a
// minimal cast-shaped object keeps these tests free of embedConfig's
// Vite-only import graph.
const inline = { target: 'inline' }
const blank = { target: 'blank' }
const external = { target: 'external' }

describe('buildEventHref: no embed', () => {
  it('internal canonical /events/{slug}/{id}', () => {
    assert.deepEqual(
      buildEventHref(EVENT, null, { search: '?theme=mint', origin: ORIGIN }),
      { kind: 'internal', href: PATH },
    )
  })

  it('event with no id falls back to / (eventPath fallback)', () => {
    assert.deepEqual(
      buildEventHref({ title: 'Mystery' }, null, { search: '', origin: ORIGIN }),
      { kind: 'internal', href: '/' },
    )
  })
})

describe('buildEventHref: embed target=inline', () => {
  it('internal /embed path carrying a ?-prefixed search', () => {
    assert.deepEqual(
      buildEventHref(EVENT, inline, { search: '?a=b', origin: ORIGIN }),
      { kind: 'internal', href: `/embed${PATH}?a=b` },
    )
  })

  it('normalizes a bare (no ?) search the same way', () => {
    assert.deepEqual(
      buildEventHref(EVENT, inline, { search: 'a=b', origin: ORIGIN }),
      { kind: 'internal', href: `/embed${PATH}?a=b` },
    )
  })

  it('empty search leaves no trailing ?', () => {
    assert.deepEqual(
      buildEventHref(EVENT, inline, { search: '', origin: ORIGIN }),
      { kind: 'internal', href: `/embed${PATH}` },
    )
  })
})

describe('buildEventHref: embed target=blank', () => {
  it('external full hosted detail URL', () => {
    assert.deepEqual(
      buildEventHref(EVENT, blank, { search: '?a=b', origin: ORIGIN }),
      { kind: 'external', href: `${ORIGIN}${PATH}` },
    )
  })
})

describe('buildEventHref: embed target=external', () => {
  it('ticket_url wins over source_url', () => {
    const ev = { ...EVENT, ticket_url: 'https://tickets.test/t1', source_url: 'https://source.test/s1' }
    assert.deepEqual(
      buildEventHref(ev, external, { search: '', origin: ORIGIN }),
      { kind: 'external', href: 'https://tickets.test/t1' },
    )
  })

  it('falls back to source_url when ticket_url is missing', () => {
    const ev = { ...EVENT, source_url: 'https://source.test/s1' }
    assert.deepEqual(
      buildEventHref(ev, external, { search: '', origin: ORIGIN }),
      { kind: 'external', href: 'https://source.test/s1' },
    )
  })

  it('falls back to the hosted detail URL when neither exists', () => {
    assert.deepEqual(
      buildEventHref(EVENT, external, { search: '', origin: ORIGIN }),
      { kind: 'external', href: `${ORIGIN}${PATH}` },
    )
  })
})

describe('embedEventPath', () => {
  it('re-roots under /embed and normalizes the search prefix', () => {
    assert.equal(embedEventPath(PATH, '?a=b'), `/embed${PATH}?a=b`)
    assert.equal(embedEventPath(PATH, 'a=b'), `/embed${PATH}?a=b`)
    assert.equal(embedEventPath(PATH, ''), `/embed${PATH}`)
    assert.equal(embedEventPath(PATH, null), `/embed${PATH}`)
  })
})
