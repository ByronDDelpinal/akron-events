/**
 * test-workz.js
 *
 * The Workz pulls from the eventscalendar.co (Inffuse) public JSON API. These
 * tests run the REAL parser against a fixture that is a VERBATIM SUBSET of the
 * live payload (scripts/tests/fixtures/workz-events.json — every row copied
 * key-for-key, nothing invented). It covers the shapes that actually exist in
 * that feed: timed shows at four title lengths, an ALL-DAY real event, an
 * all-day closure, the trailing-form closure/promo notices, an OFF-SITE row,
 * a row with an external link, a row with NO startDate at all, and the classic
 * recurring specials.
 *
 * Pins the five defects fixed 2026-08-01:
 *   D1 age_restriction is never null (the column is NOT NULL).
 *   D2 all-day rows publish at the 7pm SANCTIONED-DEFAULT-TIME, not midnight —
 *      midnight rows are invisible behind every feed's .gte('start_at', now).
 *   D3 the closure filter is position-INDEPENDENT ("Thanksgiving - Closed") and
 *      hours/deal notices are dropped, without eating a band called "Big Deal".
 *   D4 the venue is per-row and every row passes the Summit County gate.
 *   D6 { result: false } with HTTP 200 throws instead of returning [].
 *
 * Run:  node --test scripts/tests/test-workz.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  SOURCE_KEY, isNonEvent, isTwentyOnePlus, workzStartIso, workzEndIso,
  workzStartDate, workzTitle, workzCityFromLocation, isHomeVenue,
  resolveWorkzVenue, normaliseWorkzEvent, fetchWorkzEvents, firstLink,
} = await import('../scrape-workz.js')
const { easternToIso, sanitizeEventText } = await import('../lib/normalize.js')

const __dir = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(readFileSync(join(__dir, 'fixtures/workz-events.json'), 'utf8'))
const byTitle = (re) => FIXTURE.value.find((e) => re.test(e.title))
const PAGE = 'https://www.playattheworkz.com/music-events'

const BEFORE      = new Date('2026-06-01T12:00:00Z') // before every 2026 show in the fixture
const BEFORE_2024 = new Date('2024-01-01T12:00:00Z') // before the all-day Prohibition Party
const BEFORE_2023 = new Date('2023-01-01T12:00:00Z') // before the linked Audiophile show

// ── Scope filter ─────────────────────────────────────────────────────────────

describe('workz: isNonEvent (specials, promos, closures)', () => {
  const DROP = [
    'ALL YOU CAN EAT WINGS & QUEEN OF HEARTS DRAWING',
    'Kids Eat & Play FREE', 'KIDZ EAT & PLAY FREE',
    'Wing Wednesday!', 'Wing Night', 'Happy Hour',
    'Strikes-N-Slices', 'Family Fun Fridays',
    'CLOSED-4TH OF JULY', 'CLOSED-FULL FACILITY RENTAL',
  ]
  const KEEP = [
    'DANNY CHRISTIAN (SPEAKEAZY)', 'COUNTRY LINE DANCING', 'URBAN LINE DANCING',
    'WHISKEY LOCO', 'GLOW PARTY (21+ OVER)', 'BOARD GAME NIGHT', 'SALSA',
    'PAINT AND SIP', 'DT & THE SHAKES', 'OFF THE RECORD (LIVE MUSIC)',
  ]
  for (const t of DROP) it(`drops: ${t}`, () => assert.equal(isNonEvent(t), true))
  for (const t of KEEP) it(`keeps: ${t}`, () => assert.equal(isNonEvent(t), false))
  it('drops empty/blank titles', () => {
    assert.equal(isNonEvent(''), true)
    assert.equal(isNonEvent(null), true)
  })

  // T3 — every one of these survived the old position-anchored closure arm and
  // published as a real event. They are verbatim live titles.
  it('T3: drops the trailing-form closures and the hours/deal notices', () => {
    for (const t of [
      'Thanksgiving - Closed', 'Christmas Eve - Closed', 'Christmas Day - Closed',
      'Extended Hours!', 'DEAL FOR DAD', 'SUPER BOWL DEAL (OPEN LATE)',
      'SPEAKEAZY CLOSED UNTIL 10PM', 'CLOSED: JULY 4TH', 'CLOSED-(EASTER SUNDAY)',
    ]) {
      assert.equal(isNonEvent(t), true, `should drop: ${t}`)
    }
  })

  // T4 — the arms are SHAPES, not a list of titles, so they must not swallow a
  // real event whose name merely contains the same words.
  it('T4: keeps real events that only look like a promo', () => {
    for (const t of [
      'Big Deal', 'BIG DEAL BAND (LIVE MUSIC)', 'Deal or No Deal Trivia',
      'The Enclosed Garden Tour', 'Undisclosed Location Party',
      'Open Mic Night', 'CLOSE HARMONY QUARTET',
    ]) {
      assert.equal(isNonEvent(t), false, `should keep: ${t}`)
    }
  })
})

// ── Dates ────────────────────────────────────────────────────────────────────

describe('workz: start/end time construction (America/New_York)', () => {
  it('timed band → 7:00pm EDT (clock time from startHour, not the date-only ms)', () => {
    const iso = workzStartIso(byTitle(/DANNY CHRISTIAN/))
    assert.equal(iso, easternToIso('2026-08-01', '19:00'))
    assert.ok(iso.startsWith('2026-08-01T23:00'), `expected 23:00Z, got ${iso}`)
  })
  it('timed dance event → 6:00pm EDT', () => {
    const iso = workzStartIso(byTitle(/COUNTRY LINE DANCING/))
    assert.ok(iso.startsWith('2026-08-06T22:00'), `expected 22:00Z, got ${iso}`)
  })

  // T2 — the whole point of the fix: an all-day row carries startHour:0 /
  // startMinutes:0, which the old `hasHour` test read as a real midnight.
  it('T2: an all-day event uses the 7pm default, NOT midnight', () => {
    const ev = byTitle(/Prohibition Party/)
    assert.equal(ev.allday, true)
    assert.equal(ev.startHour, 0)
    assert.equal(ev.startMinutes, 0)
    const iso = workzStartIso(ev)
    assert.equal(iso, easternToIso('2024-04-04', '19:00'))
    assert.ok(iso.startsWith('2024-04-04T23:00'), `expected 23:00Z (7pm EDT), got ${iso}`)
    assert.ok(!iso.startsWith('2024-04-04T04:00'), 'must not be midnight ET')
  })

  it('undated rows are dropped, but a row with only the `start` epoch is kept', () => {
    assert.equal(workzStartIso({}), null)
    // 90 PROOF carries no startDate/endDate/timezone at all — only `start`,
    // which is UTC midnight of 2026-08-15 by construction.
    const ev = byTitle(/90 PROOF/)
    assert.equal(ev.startDate, undefined)
    assert.equal(workzStartDate(ev), '2026-08-15')
    assert.ok(workzStartIso(ev).startsWith('2026-08-16T00:00'), workzStartIso(ev)) // 8pm EDT
  })

  // T6 — end_at mapped when real, omitted otherwise.
  it('T6: end_at is mapped from endDate/endHour/endMinutes', () => {
    const row = normaliseWorkzEvent(byTitle(/DANNY CHRISTIAN/), { now: BEFORE })
    assert.equal(row.end_at, easternToIso('2026-08-01', '22:00'))
    assert.ok(row.end_at > row.start_at)
    assert.equal(workzEndIso(byTitle(/DANNY CHRISTIAN/)), row.end_at)
  })
  it('T6: end_at is OMITTED for all-day rows and for a placeholder 0:00 end', () => {
    assert.equal(workzEndIso(byTitle(/Prohibition Party/)), null)
    const row = normaliseWorkzEvent(byTitle(/Prohibition Party/), { now: BEFORE_2024 })
    assert.ok(row, 'the all-day Prohibition Party is a real event')
    assert.equal('end_at' in row, false, 'end_at must be absent, not null')
    // A same-day midnight end can never invert the row.
    assert.equal(workzEndIso({ startDate: '2026-08-01', endDate: '2026-08-01', endHour: null }), null)
  })

  // T10 — the two-arg easternToIso must survive the DST boundary.
  it('T10: DST round-trip — 2026-11-15 19:00 ET is 2026-11-16T00:00Z (EST)', () => {
    assert.equal(easternToIso('2026-11-15', '19:00'), '2026-11-16T00:00:00.000Z')
    // …and the all-day default lands on exactly that instant.
    const iso = workzStartIso({ startDate: '2026-11-15', startHour: 0, startMinutes: 0, allday: true })
    assert.equal(iso, '2026-11-16T00:00:00.000Z')
    // Same wall clock in EDT is an hour earlier in UTC — proof the offset is
    // resolved per-date rather than hardcoded.
    assert.equal(easternToIso('2026-08-15', '19:00'), '2026-08-15T23:00:00.000Z')
  })
})

// ── Venue + Summit County gate ───────────────────────────────────────────────

describe('workz: per-row venue and the Summit County gate', () => {
  it('an empty or home location resolves to the fixed venue', () => {
    assert.equal(isHomeVenue(null), true)
    assert.equal(isHomeVenue('The Workz'), true)
    assert.equal(isHomeVenue('THE WORKZ on the Riverfront'), true)
    const { venue, locality, home } = resolveWorkzVenue(byTitle(/DANNY CHRISTIAN/))
    assert.equal(home, true)
    assert.equal(locality, 'in')
    // Must match the live venues row EXACTLY so ensureVenue's name lookup hits.
    assert.equal(venue.name, 'THE WORKZ on the Riverfront')
    assert.equal(venue.address, '2220 Front St')
    assert.equal(venue.city, 'Cuyahoga Falls')
  })

  // T5 — the feed is not single-venue; the one off-site row is in Summit.
  it('T5: an off-site Summit location keeps its own venue', () => {
    const ev = byTitle(/Nightmare on Front Street/)
    assert.equal(ev.location, 'Cuyahoga Falls Amphitheater')
    const { venue, locality, home } = resolveWorkzVenue(ev)
    assert.equal(home, false)
    assert.equal(locality, 'in')
    assert.equal(venue.name, 'Cuyahoga Falls Amphitheater')
    assert.match(venue.city, /cuyahoga falls/i)
    assert.ok(normaliseWorkzEvent(ev, { now: BEFORE_2023 }), 'a Summit off-site row still publishes')
  })

  it('T5: an off-site NON-Summit location is dropped', () => {
    const base = byTitle(/Nightmare on Front Street/)
    for (const location of ['Cleveland Agora', 'The Kent Stage', 'Canton Palace Theatre']) {
      const { locality, venue } = resolveWorkzVenue({ ...base, location })
      assert.equal(locality, 'out', `${location} should classify out`)
      assert.equal(venue, null)
      assert.equal(normaliseWorkzEvent({ ...base, location }, { now: BEFORE_2023 }), null)
    }
  })

  it('T5: an unrecognisable off-site location is dropped, never published blind', () => {
    const base = byTitle(/Nightmare on Front Street/)
    const { locality, venue } = resolveWorkzVenue({ ...base, location: 'Somebody’s Back Yard' })
    assert.equal(locality, 'unknown')
    assert.equal(venue, null)
    assert.equal(normaliseWorkzEvent({ ...base, location: 'Somebody’s Back Yard' }, { now: BEFORE_2023 }), null)
  })

  it('city extraction prefers an in-county name over a road named after another city', () => {
    assert.match(workzCityFromLocation('Cuyahoga Falls Amphitheater'), /cuyahoga falls/i)
    assert.match(workzCityFromLocation('The Barn, 3200 Cleveland-Massillon Rd, Akron, OH'), /akron/i)
    assert.match(workzCityFromLocation('Rockne’s on Cleveland-Massillon Road, Bath'), /bath/i)
    assert.match(workzCityFromLocation('Cleveland Agora'), /cleveland/i)
    assert.equal(workzCityFromLocation(''), null)
    assert.equal(workzCityFromLocation('The Blue Room'), null)
  })
})

// ── Row mapping ──────────────────────────────────────────────────────────────

describe('workz: normaliseWorkzEvent mapping + filtering', () => {
  it('keeps a real band and maps the row', () => {
    const row = normaliseWorkzEvent(byTitle(/DANNY CHRISTIAN/), { now: BEFORE })
    assert.ok(row)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source, 'workz')
    assert.equal(row.source_id, 'event_l9BbG3x30929fWC4of112')
    assert.equal(row.title, 'Danny Christian (Speakeazy)')
    assert.equal(row.status, 'published')
    assert.equal(row.featured, false)
    assert.ok(row.start_at.startsWith('2026-08-01T23:00'))
    assert.ok(String(row.image_url).includes('uploadcare.calendar.inffuse.com'))
    assert.equal(row.ticket_url, PAGE)
  })

  // T1 — the DB column is NOT NULL; an explicit null does NOT fall back to the
  // 'not_specified' default, so every non-21+ row failed its upsert.
  it('T1: age_restriction is never null', () => {
    const rows = FIXTURE.value.map((e) => normaliseWorkzEvent(e, { now: BEFORE_2023 })).filter(Boolean)
    assert.ok(rows.length >= 6, `expected several publishable rows, got ${rows.length}`)
    for (const r of rows) {
      assert.notEqual(r.age_restriction, null, `${r.title} has a null age_restriction`)
      assert.ok(['not_specified', '21_plus'].includes(r.age_restriction), r.age_restriction)
    }
    assert.equal(normaliseWorkzEvent(byTitle(/DANNY CHRISTIAN/), { now: BEFORE }).age_restriction, 'not_specified')
    assert.equal(
      normaliseWorkzEvent({ ...byTitle(/DANNY CHRISTIAN/), title: 'GLOW PARTY (21+ OVER)' }, { now: BEFORE }).age_restriction,
      '21_plus',
    )
  })

  it('drops the non-events', () => {
    for (const re of [/ALL YOU CAN EAT/, /Kids Eat & Play/, /CLOSED-FULL/, /DEAL FOR DAD/, /SUPER BOWL/]) {
      assert.equal(normaliseWorkzEvent(byTitle(re), { now: BEFORE_2023 }), null, `${re} should be dropped`)
    }
  })

  it('drops events already in the past', () => {
    const row = normaliseWorkzEvent(byTitle(/COUNTRY LINE DANCING/), { now: new Date('2026-08-20T12:00:00Z') })
    assert.equal(row, null)
  })

  it('keeps every non-skipped upcoming fixture event', () => {
    const rows = FIXTURE.value.map((e) => normaliseWorkzEvent(e, { now: BEFORE })).filter(Boolean)
    assert.deepEqual(rows.map((r) => r.title).sort(), [
      '90 Proof', 'Country Line Dancing', 'Danny Christian (Speakeazy)',
      'SB Music', 'Salsa', 'The Cover Band',
    ])
  })

  // T8 — an external link is the better destination when the venue supplies one.
  it('T8: ticket_url is links[0].url when present, the events page otherwise', () => {
    const linked = normaliseWorkzEvent(byTitle(/Audiophile CLE Band/), { now: BEFORE_2023 })
    assert.equal(linked.ticket_url, 'https://fb.me/e/2yH2M1ryW')
    assert.equal(normaliseWorkzEvent(byTitle(/DANNY CHRISTIAN/), { now: BEFORE }).ticket_url, PAGE)
    // links entries without a url (the feed emits `{ "0": { newtab: true } }`)
    // must fall back rather than produce `undefined`.
    assert.equal(firstLink({ links: { 0: { newtab: true } } }), null)
    assert.equal(firstLink({}), null)
    assert.equal(
      normaliseWorkzEvent({ ...byTitle(/DANNY CHRISTIAN/), links: { 0: { newtab: true } } }, { now: BEFORE }).ticket_url,
      PAGE,
    )
  })
})

// ── Title casing ─────────────────────────────────────────────────────────────

describe('workz: ALL-CAPS titles are de-shouted consistently at every length', () => {
  // T7 — the pipeline's 25-char floor cased exactly ONE of the twelve
  // publishable titles. Four real fixture titles at 5 / 14 / 20 / 27 chars.
  const CASES = [
    ['SALSA',                       'Salsa'],
    ['THE COVER BAND',              'The Cover Band'],
    ['COUNTRY LINE DANCING',        'Country Line Dancing'],
    ['DANNY CHRISTIAN (SPEAKEAZY)', 'Danny Christian (Speakeazy)'],
  ]
  for (const [raw, want] of CASES) {
    it(`${raw.length} chars: ${raw} → ${want}`, () => {
      assert.equal(raw.length, [5, 14, 20, 27].find((n) => n === raw.length), `unexpected length for ${raw}`)
      assert.equal(workzTitle(raw), want)
      const row = normaliseWorkzEvent(byTitle(new RegExp(raw.replace(/[()]/g, '\\$&'))), { now: BEFORE })
      assert.equal(row.title, want)
    })
  }

  it('keeps short vowel-less initialisms uppercase', () => {
    assert.equal(workzTitle('SB MUSIC'), 'SB Music')
    assert.equal(workzTitle('DT & THE SHAKES'), 'DT & the Shakes')
    assert.equal(workzTitle('SMP (SUSAN MARIE PROJECT)'), 'SMP (Susan Marie Project)')
    assert.equal(workzTitle('DJ NIGHT'), 'DJ Night') // shared TITLE_CASE_KEEP_UPPER
  })

  it('leaves already mixed-case titles alone', () => {
    assert.equal(workzTitle('Nightmare on Front Street'), 'Nightmare on Front Street')
    assert.equal(workzTitle('Audiophile CLE Band'), 'Audiophile CLE Band')
  })

  it('is idempotent under the pipeline sanitizer (no double-casing)', () => {
    const row = normaliseWorkzEvent(byTitle(/DANNY CHRISTIAN/), { now: BEFORE })
    assert.equal(sanitizeEventText(row).title, row.title)
  })
})

// ── Fetch ────────────────────────────────────────────────────────────────────

describe('workz: fetchWorkzEvents error handling', () => {
  const withFetch = async (impl, fn) => {
    const real = globalThis.fetch
    globalThis.fetch = impl
    try { return await fn() } finally { globalThis.fetch = real }
  }

  it('T9: a { result: false } body with HTTP 200 throws (never a silent zero-row run)', async () => {
    await withFetch(
      async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ result: false }) }),
      () => assert.rejects(() => fetchWorkzEvents('https://example.test/x'), /result=false/),
    )
  })

  it('T9: an HTTP 400 throws', async () => {
    await withFetch(
      async () => ({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({}) }),
      () => assert.rejects(() => fetchWorkzEvents('https://example.test/x'), /400 Bad Request/),
    )
  })

  it('T9: a well-formed body returns the event list', async () => {
    await withFetch(
      async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => FIXTURE }),
      async () => {
        const list = await fetchWorkzEvents('https://example.test/x')
        assert.equal(list.length, FIXTURE.value.length)
      },
    )
  })
})

// ── 21+ ──────────────────────────────────────────────────────────────────────

describe('workz: 21+ detection', () => {
  it('flags 21+ programming', () => {
    assert.equal(isTwentyOnePlus('GLOW PARTY (21+ OVER)', ''), true)
    assert.equal(isTwentyOnePlus('WHISKEY LOCO', 'Doors at 8, must be 21 & over'), true)
    assert.equal(isTwentyOnePlus('COUNTRY LINE DANCING', 'all ages welcome'), false)
  })
})
