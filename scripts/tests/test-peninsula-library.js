/**
 * test-peninsula-library.js
 *
 * Unit tests for the Peninsula Library ai1ec agenda scraper's pure parsers.
 * The fixture (fixtures/peninsula-library-agenda.html) is a real slice of the
 * live agenda view captured 2026-07-14, covering a timed children's program, a
 * recurring adult book club, a local-history talk, an all-day "Library Closed"
 * block, and a "Friends of the Library" meeting.
 *
 * Run:
 *   node --test scripts/tests/test-peninsula-library.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Dummy env so importing the scraper (which imports supabase-admin) never
// touches a real project.
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  parseAgendaEvents,
  parseEventDateTime,
  shouldSkipTitle,
  resolveCategory,
  isFamilyEvent,
  buildTags,
} from '../scrape-peninsula-library.js'

const AGENDA_HTML = readFileSync(
  new URL('./fixtures/peninsula-library-agenda.html', import.meta.url), 'utf8')

const events = parseAgendaEvents(AGENDA_HTML)
const byTitle = (needle) => events.find((e) => e.title.includes(needle))

// ── parseAgendaEvents ────────────────────────────────────────────────────────

describe('parseAgendaEvents', () => {
  it('extracts every event block in the agenda', () => {
    assert.equal(events.length, 8)
  })

  it('decodes entity-escaped titles', () => {
    const talent = byTitle('Peninsula')
    assert.ok(talent)
    assert.equal(talent.title, 'Peninsula’s Got Talent'.replace('’', "'"))
  })

  it('captures event + instance ids for a stable source_id', () => {
    const talent = byTitle('Peninsula')
    assert.equal(talent.eventId, '2263')
    assert.equal(talent.instanceId, '8960')
  })

  it('captures the offset-aware data-end and human time text', () => {
    const talent = byTitle('Peninsula')
    assert.equal(talent.dataEnd, '2026-07-21T11:30:00-04:00')
    assert.match(talent.timeText, /10:30 am/)
  })

  it('captures category chip labels', () => {
    const talent = byTitle('Peninsula')
    assert.deepEqual(talent.categoryLabels, ["Children's Events"])
    const book = byTitle('Wednesday Afternoon Book Club')
    assert.deepEqual(book.categoryLabels, ['Adult Events'])
  })

  it('flags the all-day Library Closed block', () => {
    const closed = byTitle('Library Closed')
    assert.ok(closed)
    assert.equal(closed.allDay, true)
  })

  it('parses the inline description text (no HTML)', () => {
    const talent = byTitle('Peninsula')
    assert.match(talent.description, /talent show/i)
    assert.ok(!/</.test(talent.description))
  })

  it('extracts the detail-page url with instance id', () => {
    const talent = byTitle('Peninsula')
    assert.equal(talent.detailUrl, 'https://peninsulalibrary.org/event/peninsulas-got-talent/?instance_id=8960')
  })

  it('returns [] for a page with no agenda', () => {
    assert.deepEqual(parseAgendaEvents('<html><body>nothing</body></html>'), [])
  })
})

// ── parseEventDateTime ───────────────────────────────────────────────────────

describe('parseEventDateTime', () => {
  it('pairs the local date from data-end with the start clock from the text', () => {
    const t = parseEventDateTime('2026-07-21T11:30:00-04:00', 'Jul 21 @ 10:30 am – 11:30 am')
    // 10:30 am EDT (UTC-4) → 14:30 UTC
    assert.equal(t.start_at, '2026-07-21T14:30:00.000Z')
    // end from data-end → 11:30 am EDT → 15:30 UTC
    assert.equal(t.end_at, '2026-07-21T15:30:00.000Z')
  })

  it('handles evening pm ranges', () => {
    const t = parseEventDateTime('2026-08-06T19:30:00-04:00', 'Aug 6 @ 6:30 pm – 7:30 pm')
    assert.equal(t.start_at, '2026-08-06T22:30:00.000Z')
    assert.equal(t.end_at, '2026-08-06T23:30:00.000Z')
  })

  it('honors an EST (post-DST) offset', () => {
    const t = parseEventDateTime('2026-11-10T19:45:00-05:00', 'Nov 10 @ 6:30 pm – 7:45 pm')
    // 6:30 pm EST (UTC-5) → 23:30 UTC
    assert.equal(t.start_at, '2026-11-10T23:30:00.000Z')
    assert.equal(t.end_at, '2026-11-11T00:45:00.000Z')
  })

  it('accepts on-the-hour times with no minutes (ai1ec "g a" format)', () => {
    // Regression: the start-clock regex once required ":MM", so "6 pm" / "10 am"
    // returned null and the event was silently skipped.
    const evening = parseEventDateTime('2026-08-06T19:00:00-04:00', 'Aug 6 @ 6 pm – 7 pm')
    assert.equal(evening.start_at, '2026-08-06T22:00:00.000Z')
    assert.equal(evening.end_at, '2026-08-06T23:00:00.000Z')
    const morning = parseEventDateTime('2026-08-06T11:00:00-04:00', 'Aug 6 @ 10 am – 11 am')
    assert.equal(morning.start_at, '2026-08-06T14:00:00.000Z')
  })

  it('accepts a spaced "p.m." on-the-hour token', () => {
    const t = parseEventDateTime('2026-08-06T19:00:00-04:00', 'Aug 6 @ 6 p.m. – 7 p.m.')
    assert.equal(t.start_at, '2026-08-06T22:00:00.000Z')
  })

  it('returns null for an all-day block with no start clock', () => {
    assert.equal(parseEventDateTime('2026-09-07T23:59:59-04:00', 'Sep 7 all-day'), null)
  })

  it('returns null for a missing data-end', () => {
    assert.equal(parseEventDateTime(null, 'Jul 21 @ 10:30 am'), null)
  })

  it('every real (non-closed) fixture event yields a valid start/end', () => {
    for (const ev of events) {
      if (shouldSkipTitle(ev.title) || ev.allDay) continue
      const t = parseEventDateTime(ev.dataEnd, ev.timeText)
      assert.ok(t, `no time for "${ev.title}"`)
      assert.ok(t.start_at.endsWith('Z'))
      assert.ok(!t.end_at || t.end_at > t.start_at, `end precedes start for "${ev.title}"`)
    }
  })
})

// ── shouldSkipTitle ──────────────────────────────────────────────────────────

describe('shouldSkipTitle', () => {
  it('skips library closures', () => {
    assert.equal(shouldSkipTitle('Library Closed 2026'), true)
  })
  it('skips Friends of the Library meetings', () => {
    assert.equal(shouldSkipTitle('Friends of the Library Meetings 2026'), true)
  })
  it('keeps real programs', () => {
    assert.equal(shouldSkipTitle("Peninsula's Got Talent"), false)
    assert.equal(shouldSkipTitle('Area Stone Quarries'), false)
    assert.equal(shouldSkipTitle('Tuesday Evening Book Club 6:30 p.m.'), false)
  })
})

// ── resolveCategory ──────────────────────────────────────────────────────────

describe('resolveCategory', () => {
  it('maps book clubs and talks to learning', () => {
    assert.equal(resolveCategory('Tuesday Evening Book Club', ''), 'learning')
    assert.equal(resolveCategory('Area Stone Quarries', 'A local history presentation.'), 'learning')
    assert.equal(resolveCategory('Understanding Social Security Benefits', ''), 'learning')
  })
  it('promotes clearly non-learning programs', () => {
    assert.equal(resolveCategory("Peninsula's Got Talent", 'talent show'), 'theater')
    assert.equal(resolveCategory('Movie Night', 'film screening'), 'film')
    assert.equal(resolveCategory('Watercolor Crafts', ''), 'visual-art')
  })
  it('falls back to learning for unmatched library programming', () => {
    assert.equal(resolveCategory('Mystery Program', ''), 'learning')
  })
})

// ── isFamilyEvent / buildTags ────────────────────────────────────────────────

describe('isFamilyEvent', () => {
  it('flags Children\'s Events from the category chip', () => {
    assert.equal(isFamilyEvent(["Children's Events"], 'Whatever'), true)
  })
  it('does not flag adult programs (returns undefined, not false)', () => {
    assert.equal(isFamilyEvent(['Adult Events'], 'Book Club'), undefined)
  })
  it('catches a family title even without a chip', () => {
    assert.equal(isFamilyEvent([], 'Family Storytime'), true)
  })
})

describe('buildTags', () => {
  it('always includes the library tag', () => {
    assert.ok(buildTags([]).includes('library'))
  })
  it('derives audience tags from category chips', () => {
    assert.ok(buildTags(["Children's Events"]).includes('kids'))
    assert.ok(buildTags(['Adult Events']).includes('adults'))
  })
})
