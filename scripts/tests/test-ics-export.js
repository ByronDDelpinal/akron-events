/**
 * test-ics-export.js — round-trip tests for src/lib/ics.js against the
 * project's OWN RFC 5545 parser (scripts/lib/ics.js's parseIcs), which is
 * already trusted by dozens of scrapers. Building with one implementation
 * and parsing with a second, independent, already-proven one is a much
 * stronger check than hand-written assertions about what we think we
 * emitted -- see docs/day-planner.md §10.2 (gitignored; rationale restated
 * here rather than pointed at).
 *
 * Guards the four real RFC 5545 bugs the previous EventPage-local `.ics`
 * builder had (no TEXT escaping, no line folding, missing DTSTAMP, an empty
 * `URL:` property) plus D9 (assumed 2-hour block when end_at is null).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseIcs, icsDateToIso } from '../lib/ics.js'
import {
  buildVCalendar,
  escapeIcsText,
  foldLine,
  computeSequence,
  formatUtcStamp,
  ASSUMED_DURATION_NOTE,
} from '../../src/lib/ics.js'

const CANONICAL_URL = 'https://akronpulse.com/events/test-event/11111111-1111-1111-1111-111111111111'

function baseEvent(overrides = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Test Event',
    description: 'A test event.',
    start_at: '2026-08-15T23:00:00.000Z', // 7:00 PM Eastern (EDT, UTC-4)
    end_at: '2026-08-16T01:00:00.000Z',   // 9:00 PM Eastern
    updated_at: '2026-08-01T00:00:00.000Z',
    venue: { name: 'Lock 3', address: '200 S Main St', city: 'Akron', state: 'OH', zip: '44308', lat: 41.08, lng: -81.52 },
    ticket_url: 'https://tickets.example.com/abc',
    source_url: 'https://source.example.com/abc',
    category_slugs: ['music', 'community'],
    canonicalUrl: CANONICAL_URL,
    ...overrides,
  }
}

/** Parse buildVCalendar's output and return the single parsed VEVENT. */
function parseOneVEvent(ics) {
  const events = parseIcs(ics)
  assert.equal(events.length, 1, 'expected exactly one VEVENT')
  return events[0]
}

describe('escapeIcsText', () => {
  it('escapes backslash, semicolon, comma, and newline in the correct order', () => {
    assert.equal(escapeIcsText('a\\b;c,d\ne'), 'a\\\\b\\;c\\,d\\ne')
  })
  it('normalizes CRLF and bare CR to \\n before escaping', () => {
    assert.equal(escapeIcsText('a\r\nb\rc'), 'a\\nb\\nc')
  })
})

describe('buildVCalendar: TEXT escaping (bug 1)', () => {
  it('a title with a comma, semicolon, backslash, and newline round-trips identically through the real parser', () => {
    const title = 'Jazz Night, Vol. 3; The "Blues" Edition \\ Encore\nSecond line'
    const ics = buildVCalendar([baseEvent({ title })])
    const ev = parseOneVEvent(ics)
    assert.equal(ev.SUMMARY, title)
  })
})

describe('buildVCalendar: line folding (bug 2)', () => {
  it('no output line exceeds 75 octets and every line is CRLF-terminated', () => {
    const description = 'x'.repeat(600)
    const ics = buildVCalendar([baseEvent({ description })])
    assert.ok(ics.endsWith('\r\n'), 'file should end with CRLF')
    // Splitting on \r\n and rejoining must reproduce the original exactly --
    // proves every line boundary is a real CRLF pair, not a bare \n.
    const lines = ics.slice(0, -2).split('\r\n')
    assert.equal(lines.join('\r\n') + '\r\n', ics)
    for (const line of lines) {
      const octets = new TextEncoder().encode(line).length
      assert.ok(octets <= 75, `line exceeds 75 octets (${octets}): ${line.slice(0, 20)}...`)
    }
  })

  it('non-ASCII title + a 500-char description survive folding with no mangled multi-byte characters at fold boundaries', () => {
    const title = 'Café Noir · Ohio Shakespeare'
    const description = 'Café Noir · Ohio Shakespeare presents an evening of música, arte, and café con leche. '.repeat(6).slice(0, 500)
    const ics = buildVCalendar([baseEvent({ title, description })])
    const ev = parseOneVEvent(ics)
    assert.equal(ev.SUMMARY, title)
    // DESCRIPTION = truncated body + blank line + "More: <url>".
    assert.ok(ev.DESCRIPTION.startsWith(description), 'description body must survive fold/unfold byte-for-byte')
    assert.ok(ev.DESCRIPTION.includes(`More: ${CANONICAL_URL}`))
    // No U+FFFD replacement character anywhere -- the tell-tale sign of a
    // multi-byte sequence severed at a fold boundary.
    assert.ok(!ev.DESCRIPTION.includes('�'), 'no mangled multi-byte characters')
  })

  it('foldLine leaves short lines untouched and folds long ones with a single leading space on continuations', () => {
    assert.equal(foldLine('SHORT:line'), 'SHORT:line')
    const folded = foldLine('DESCRIPTION:' + 'a'.repeat(200))
    const parts = folded.split('\r\n')
    assert.ok(parts.length > 1)
    for (let i = 1; i < parts.length; i++) {
      assert.ok(parts[i].startsWith(' '), 'continuation lines must start with exactly one space')
    }
  })
})

describe('buildVCalendar: DTSTAMP required, METHOD absent, VERSION present (bug 3)', () => {
  it('emits DTSTAMP, VERSION:2.0, and no METHOD property', () => {
    const ics = buildVCalendar([baseEvent()])
    assert.match(ics, /DTSTAMP:\d{8}T\d{6}Z/)
    assert.match(ics, /VERSION:2\.0/)
    assert.ok(!ics.includes('METHOD:'), 'a METHOD property turns this into an iTIP meeting invitation -- must never be emitted')
  })
})

describe('buildVCalendar: D9 -- null end_at assumes a 2-hour block and discloses it', () => {
  it('DTEND is start + 2h and DESCRIPTION carries the assumption line', () => {
    const start = '2026-09-01T18:00:00.000Z'
    const ics = buildVCalendar([baseEvent({ start_at: start, end_at: null })])
    const ev = parseOneVEvent(ics)
    const startIso = icsDateToIso(ev.DTSTART.value, ev.DTSTART.params)
    const endIso = icsDateToIso(ev.DTEND.value, ev.DTEND.params)
    assert.equal(Date.parse(endIso) - Date.parse(startIso), 2 * 3_600_000)
    assert.ok(ev.DESCRIPTION.includes(ASSUMED_DURATION_NOTE))
  })
})

describe('buildVCalendar: URL omission (bug 4)', () => {
  it('omits the URL property entirely when ticket_url, source_url, and canonicalUrl are all empty', () => {
    const ics = buildVCalendar([baseEvent({ ticket_url: null, source_url: null, canonicalUrl: '' })])
    assert.ok(!ics.includes('URL:'), 'an empty URL: property is invalid RFC 5545 and must be omitted, not emitted blank')
  })

  it('falls back to source_url when ticket_url is null', () => {
    const ics = buildVCalendar([baseEvent({ ticket_url: null, source_url: 'https://source.example.com/xyz' })])
    const ev = parseOneVEvent(ics)
    assert.equal(ev.URL, 'https://source.example.com/xyz')
  })

  it('falls back to the canonical event URL when ticket_url and source_url are both null', () => {
    const ics = buildVCalendar([baseEvent({ ticket_url: null, source_url: null })])
    const ev = parseOneVEvent(ics)
    assert.equal(ev.URL, CANONICAL_URL)
  })
})

describe('buildVCalendar: timezone round-trip (catches off-by-one-day bugs)', () => {
  it('a fixture built from a known Eastern wall-clock time round-trips to the SAME wall-clock time in America/New_York', () => {
    // 2026-08-15T19:00:00 Eastern (EDT, UTC-4) == 2026-08-15T23:00:00Z.
    const ics = buildVCalendar([baseEvent({ start_at: '2026-08-15T23:00:00.000Z' })])
    const ev = parseOneVEvent(ics)
    assert.match(ev.DTSTART.value, /Z$/, 'DTSTART must be emitted in UTC (Z) form, never floating or TZID')
    const iso = icsDateToIso(ev.DTSTART.value, ev.DTSTART.params)
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(iso))
    const get = (t) => parts.find((p) => p.type === t)?.value
    assert.equal(`${get('year')}-${get('month')}-${get('day')}`, '2026-08-15')
    assert.equal(`${get('hour')}:${get('minute')}`, '19:00')
  })
})

describe('buildVCalendar: STATUS and rot filtering', () => {
  it('rot_status=cancelled emits STATUS:CANCELLED', () => {
    const ics = buildVCalendar([baseEvent({ rot_status: 'cancelled' })])
    const ev = parseOneVEvent(ics)
    assert.equal(ev.STATUS, 'CANCELLED')
  })

  it('an item with no rot_status (the single-event export path) emits STATUS:CONFIRMED', () => {
    const ics = buildVCalendar([baseEvent()])
    const ev = parseOneVEvent(ics)
    assert.equal(ev.STATUS, 'CONFIRMED')
  })

  it('rot_status=gone and rot_status=merged_duplicate are omitted from the export entirely', () => {
    const ics = buildVCalendar([
      baseEvent({ id: 'aaaaaaaa-0000-0000-0000-000000000001', rot_status: 'gone' }),
      baseEvent({ id: 'aaaaaaaa-0000-0000-0000-000000000002', rot_status: 'merged_duplicate' }),
      baseEvent({ id: 'aaaaaaaa-0000-0000-0000-000000000003', rot_status: 'ok' }),
    ])
    const events = parseIcs(ics)
    assert.equal(events.length, 1)
    assert.equal(events[0].UID, 'aaaaaaaa-0000-0000-0000-000000000003@akronpulse.com')
  })
})

describe('buildVCalendar: SEQUENCE / re-export stability (§7.5)', () => {
  it('two exports of the same event with unchanged updated_at are byte-identical except DTSTAMP', () => {
    const ev = baseEvent()
    const a = buildVCalendar([ev]).split('\r\n').filter((l) => !l.startsWith('DTSTAMP:'))
    const b = buildVCalendar([ev]).split('\r\n').filter((l) => !l.startsWith('DTSTAMP:'))
    assert.deepEqual(a, b)
  })

  it('a strictly later updated_at (by more than a minute) produces a strictly greater SEQUENCE', () => {
    const s1 = computeSequence('2026-08-01T00:00:00.000Z')
    const s2 = computeSequence('2026-08-01T00:05:00.000Z')
    assert.ok(s2 > s1)
  })

  it('computeSequence is non-negative and stable for a missing/unparseable updated_at', () => {
    assert.equal(computeSequence(null), 0)
    assert.equal(computeSequence('not-a-date'), 0)
  })

  it('formatUtcStamp always emits the Z-suffixed compact form', () => {
    assert.equal(formatUtcStamp('2026-01-01T00:00:00.000Z'), '20260101T000000Z')
  })
})

describe('buildVCalendar: 30-item plan cap', () => {
  it('a 30-item plan produces exactly 30 BEGIN:VEVENT blocks', () => {
    const events = Array.from({ length: 30 }, (_, i) => baseEvent({
      id: `bbbbbbbb-0000-0000-0000-${String(i).padStart(12, '0')}`,
      title: `Event ${i}`,
    }))
    const ics = buildVCalendar(events)
    const count = (ics.match(/BEGIN:VEVENT/g) || []).length
    assert.equal(count, 30)
  })
})

describe('buildVCalendar: shared UID convention with the single-event export path', () => {
  it('UID is `{resolved id}@akronpulse.com`, so the same event added individually and inside a plan converges', () => {
    const ics = buildVCalendar([baseEvent({ id: 'cccccccc-0000-0000-0000-000000000001' })])
    const ev = parseOneVEvent(ics)
    assert.equal(ev.UID, 'cccccccc-0000-0000-0000-000000000001@akronpulse.com')
  })
})
