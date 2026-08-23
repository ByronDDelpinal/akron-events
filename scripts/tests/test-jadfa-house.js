/**
 * test-jadfa-house.js: pure parsers and recurrence assembly for The JADFA House
 * scraper. The fixture is the REAL raw source of
 * https://www.thejadfahouse.org/meetings/ captured 2026-08-23 from
 * fetch().text() (raw markup, NOT the rendered DOM). It deliberately keeps the
 * retired "Fear of Change Friday Meeting" heading and prose, because that is
 * what pins the block bound that keeps a concluded meeting off the site.
 *
 * Run:  node --test scripts/tests/test-jadfa-house.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  SOURCE_KEY, MIN_EXPECTED_MEETINGS,
  sliceMeetingsBlock, parseMeetings, parseStatedAddress, parseFreeAdmission,
  buildMeetingEvents, cleanItemText,
} = await import('../scrape-jadfa-house.js')

const HTML = readFileSync(new URL('./fixtures/jadfa-house-meetings.html', import.meta.url), 'utf8')

// Monday noon UTC (Monday morning ET). Next Thursday is 2026-08-27.
const NOW = new Date('2026-08-24T12:00:00Z')

/** The schedule the page states today, in document order. */
const EXPECTED = [
  { weekdayName: 'sunday',    weekday: 0, title: 'AA Crossroads',                                        startTime: '19:30', doorsTime: '19:00', access: 'Open' },
  { weekdayName: 'tuesday',   weekday: 2, title: "Men's AA Big Book Study",                              startTime: '19:00', doorsTime: '18:30', access: 'Open – Men Only' },
  { weekdayName: 'wednesday', weekday: 3, title: "Women's AA Big Book Study",                            startTime: '19:30', doorsTime: '19:00', access: 'Open – Women Only' },
  { weekdayName: 'thursday',  weekday: 4, title: 'Recovery Dharm',                                       startTime: '16:00', doorsTime: null,    access: 'Open' },
  { weekdayName: 'thursday',  weekday: 4, title: 'Recovery Dharma Inquiry Circle',                       startTime: '17:00', doorsTime: null,    access: 'Open' },
  { weekdayName: 'thursday',  weekday: 4, title: "Sisterhood of Serenity – Women's All Recovery Meeting", startTime: '19:00', doorsTime: '18:30', access: 'Open – Women Only' },
  { weekdayName: 'friday',    weekday: 5, title: 'Bridge the Gap – All Recovery Jenga',                  startTime: '17:00', doorsTime: null,    access: null },
]

describe('sliceMeetingsBlock', () => {
  const block = sliceMeetingsBlock(HTML)

  it('starts after the Our Meetings heading', () => {
    assert.match(block, /Located at 916 Kenmore Blvd/)
    assert.match(block, /AA Crossroads/)
  })

  it('stops at the NEXT h3, excluding the retired Fear of Change section', () => {
    assert.equal(/Fear of Change/i.test(block), false)
    assert.equal(/After four incredible years/i.test(block), false)
  })

  it('returns empty when the page drops the heading', () => {
    assert.equal(sliceMeetingsBlock('<h2>Our Meetings:</h2><ul><li>x</li></ul>'), '')
  })
})

describe('parseMeetings (captured fixture)', () => {
  const meetings = parseMeetings(HTML)

  it('parses all seven meetings the page states', () => {
    assert.equal(meetings.length, 7)
  })

  for (const [i, want] of EXPECTED.entries()) {
    it(`meeting ${i + 1}: ${want.title}`, () => {
      const got = meetings[i]
      assert.equal(got.title, want.title)
      assert.equal(got.weekdayName, want.weekdayName)
      assert.equal(got.weekday, want.weekday)
      assert.equal(got.startTime, want.startTime)
      assert.equal(got.doorsTime, want.doorsTime)
      assert.equal(got.access, want.access)
    })
  }

  it('publishes the page\'s "Recovery Dharm" typo verbatim (no correction map)', () => {
    const dharm = meetings.find((m) => m.startTime === '16:00')
    assert.equal(dharm.title, 'Recovery Dharm')
    assert.equal(meetings.some((m) => m.title === 'Recovery Dharma'), false)
  })

  it('leaves the Friday Jenga access null rather than fabricating "Open"', () => {
    const jenga = meetings.find((m) => m.weekdayName === 'friday')
    assert.equal(jenga.access, null)
    assert.equal(jenga.doorsTime, null)
    assert.equal(jenga.title, 'Bridge the Gap – All Recovery Jenga')
  })

  it('registers FRIDAY as a day heading even with no trailing colon', () => {
    assert.equal(meetings.filter((m) => m.weekdayName === 'friday').length, 1)
    // and the colon-bearing days still register
    assert.deepEqual(
      [...new Set(meetings.map((m) => m.weekdayName))],
      ['sunday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    )
  })

  it('yields ZERO meetings from the retired Fear of Change section', () => {
    assert.equal(meetings.some((m) => /fear of change/i.test(m.title)), false)
    // even when that section grows its own day heading and list items
    const withRetiredList = HTML.replace(
      '<h3>Fear of Change Friday Meeting</h3>',
      '<h3>Fear of Change Friday Meeting</h3>\n<p><strong>FRIDAY:</strong></p>\n<ul>\n' +
      '<li>Fear of Change (Open) Doors open at 6:30 pm | Meeting Starts at 7 pm</li>\n</ul>',
    )
    const after = parseMeetings(withRetiredList)
    assert.equal(after.length, 7)
    assert.equal(after.some((m) => /fear of change/i.test(m.title)), false)
  })

  it('marks only the meeting whose line says "Available on zoom"', () => {
    assert.deepEqual(meetings.filter((m) => m.zoom).map((m) => m.title), ['Recovery Dharm'])
  })

  it('drops an item with no parseable start time', () => {
    const noTime = HTML.replace('Meeting starts at 5 pm', 'time TBA')
    assert.equal(parseMeetings(noTime).length, 6)
  })

  it('drops a cancelled item', () => {
    const cancelled = HTML.replace('AA Crossroads (Open)', 'AA Crossroads CANCELLED (Open)')
    const got = parseMeetings(cancelled)
    assert.equal(got.length, 6)
    assert.equal(got.some((m) => /crossroads/i.test(m.title)), false)
  })
})

describe('entity decoding', () => {
  it('decodes &#8217; to an apostrophe and &#8211; to an en dash', () => {
    assert.equal(
      cleanItemText('<li>Men&#8217;s AA Big Book Study (Open &#8211; Men Only)</li>'),
      "Men's AA Big Book Study (Open – Men Only)",
    )
  })

  it('carries the decoded forms through into parsed titles and access labels', () => {
    const meetings = parseMeetings(HTML)
    assert.equal(meetings[1].title, "Men's AA Big Book Study")
    assert.equal(meetings[1].access, 'Open – Men Only')
    assert.equal(meetings[5].title, "Sisterhood of Serenity – Women's All Recovery Meeting")
  })
})

describe('parseStatedAddress (drift guard)', () => {
  it('reads the address the page states, minus the abbreviation period', () => {
    assert.deepEqual(parseStatedAddress(HTML), {
      address: '916 Kenmore Blvd', city: 'Akron', state: 'OH', zip: '44314',
    })
  })

  it('returns null when the page states no address', () => {
    assert.equal(parseStatedAddress('<h3>Our Meetings:</h3><ul><li>x</li></ul>'), null)
  })
})

describe('parseFreeAdmission', () => {
  it('is true only because the page says so', () => {
    assert.equal(parseFreeAdmission(HTML), true)
  })

  it('is false when the free-attendance sentence leaves the page', () => {
    const charging = HTML.replaceAll('Attendance is free', 'Attendance is five dollars')
    assert.equal(parseFreeAdmission(charging), false)
  })
})

describe('buildMeetingEvents', () => {
  const events = buildMeetingEvents(HTML, NOW)

  it('expands seven meetings into eight weekly occurrences each', () => {
    assert.equal(events.length, 56)
  })

  it('anchors the first occurrence of each meeting to the right Eastern date', () => {
    const firsts = EXPECTED.map((w) => events.find((e) => e.title === w.title).ymd)
    assert.deepEqual(firsts, [
      '2026-08-30', // sunday
      '2026-08-25', // tuesday
      '2026-08-26', // wednesday
      '2026-08-27', '2026-08-27', '2026-08-27', // thursday
      '2026-08-28', // friday
    ])
  })

  it('converts Eastern wall time to UTC (EDT in August)', () => {
    const dharm = events.find((e) => e.title === 'Recovery Dharm')
    assert.equal(dharm.start_at, '2026-08-27T20:00:00.000Z')  // 4:00 pm EDT
    const crossroads = events.find((e) => e.title === 'AA Crossroads')
    assert.equal(crossroads.start_at, '2026-08-30T23:30:00.000Z') // 7:30 pm EDT
  })

  it('keys source_id on weekday + 24-hour start + date, never on the title', () => {
    const dharm = events.find((e) => e.title === 'Recovery Dharm')
    assert.equal(dharm.source_id, 'meeting-thursday-1600-2026-08-27')
  })

  it('produces a unique source_id for every occurrence', () => {
    const ids = events.map((e) => e.source_id)
    assert.equal(new Set(ids).size, ids.length)
    // and the seven meetings are distinct on their first occurrence too
    const firstIds = EXPECTED.map((w) => events.find((e) => e.title === w.title).source_id)
    assert.equal(new Set(firstIds).size, 7)
  })

  it('is stable across two calls with the same now', () => {
    const again = buildMeetingEvents(HTML, NOW)
    assert.deepEqual(again.map((e) => e.source_id), events.map((e) => e.source_id))
  })

  it('does NOT change a source_id when the page fixes the title typo', () => {
    // the likeliest edit this page will get; a title-keyed id would orphan
    // every future row instead of updating it in place
    const fixed = buildMeetingEvents(HTML.replace('Recovery Dharm (Open)', 'Recovery Dharma (Open)'), NOW)
    const renamed = fixed.find((e) => e.ymd === '2026-08-27' && e.title === 'Recovery Dharma')
    assert.equal(renamed.source_id, 'meeting-thursday-1600-2026-08-27')
    assert.deepEqual(fixed.map((e) => e.source_id), events.map((e) => e.source_id))
  })

  it('DOES change a source_id when the meeting time moves', () => {
    const moved = buildMeetingEvents(HTML.replace('Meeting Starts at 4 pm', 'Meeting Starts at 4:30 pm'), NOW)
    const shifted = moved.find((e) => e.title === 'Recovery Dharm' && e.ymd === '2026-08-27')
    assert.equal(shifted.source_id, 'meeting-thursday-1630-2026-08-27')
    assert.equal(moved.some((e) => e.source_id === 'meeting-thursday-1600-2026-08-27'), false)
  })

  it('builds the description only from parsed parts', () => {
    const sisterhood = events.find((e) => /Sisterhood/.test(e.title))
    assert.equal(
      sisterhood.description,
      "Sisterhood of Serenity – Women's All Recovery Meeting at The JADFA House, a recovery and " +
      "community center at 916 Kenmore Blvd. in Akron's Kenmore neighborhood. Meeting starts at " +
      '7:00 pm; doors open at 6:30 pm. Open meeting. Women only. Attendance is free.',
    )
  })

  it('omits the doors sentence where the page states no doors, and says nothing about access where the page states none', () => {
    const jenga = events.find((e) => /Jenga/.test(e.title))
    assert.equal(/doors/i.test(jenga.description), false)
    assert.equal(/open meeting/i.test(jenga.description), false)
    assert.match(jenga.description, /Meeting starts at 5:00 pm\./)
  })

  it('mentions Zoom only for the meeting whose line says so', () => {
    assert.deepEqual(
      [...new Set(events.filter((e) => /Zoom/.test(e.description)).map((e) => e.title))],
      ['Recovery Dharm'],
    )
  })

  it('never puts the building\'s kid-friendly policy in the description', () => {
    assert.equal(events.some((e) => /kid-friendly|children/i.test(e.description)), false)
  })

  it('sets the row shape the pipeline expects', () => {
    const row = events[0]
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.category, 'civic')
    assert.equal(row.status, 'published')
    assert.equal(row.featured, false)
    assert.equal(row.is_family, false)          // explicit, overrides the kid-friendly inference
    assert.equal(row.age_restriction, 'not_specified')
    assert.equal(row.end_at, null)
    assert.equal(row.image_url, null)
    assert.equal(row.ticket_url, 'https://www.thejadfahouse.org/meetings/')
  })

  it('prices at 0 only because the page states free attendance', () => {
    assert.equal(events[0].price_min, 0)
    assert.equal(events[0].price_max, 0)
    const charging = buildMeetingEvents(HTML.replaceAll('Attendance is free', 'Attendance is five dollars'), NOW)
    assert.equal(charging[0].price_min, null)
    assert.equal(charging[0].price_max, null)
  })

  it('tags the AA meetings and only those', () => {
    const aa = [...new Set(events.filter((e) => e.tags.includes('aa')).map((e) => e.title))]
    assert.deepEqual(aa, ['AA Crossroads', "Men's AA Big Book Study", "Women's AA Big Book Study"])
    assert.deepEqual(events[0].tags.slice(0, 6),
      ['jadfa-house', 'kenmore', 'akron', 'recovery', 'support-group', 'sunday'])
  })

  it('yields nothing when the meetings block leaves the page', () => {
    assert.deepEqual(buildMeetingEvents('<p>closed for renovation</p>', NOW), [])
  })
})

describe('source_id collision (two meetings sharing a weekday AND a start time)', () => {
  // A men's group and a women's group at the same hour in different rooms is a
  // common recovery-center pattern, so this is a plausible future page edit.
  // Without in-run suffixing the twin upserts straight over its sibling on the
  // (source, source_id) unique constraint and one meeting never publishes.
  const TWIN = "<li>Men&#8217;s Step Study (Open &#8211; Men Only) Meeting Starts at 5 pm</li>"
  const ORIGINAL = '<li>Recovery Dharma Inquiry Circle (Open) Meeting Starts at 5 pm</li>'
  const CONFLICT_HTML = HTML.replace(ORIGINAL, `${ORIGINAL}\n${TWIN}`)

  const baseline = buildMeetingEvents(HTML, NOW)
  const events   = buildMeetingEvents(CONFLICT_HTML, NOW)

  it('the base fixture needs no suffixes at all', () => {
    const bare = /^meeting-[a-z]+-\d{4}-\d{4}-\d{2}-\d{2}$/
    assert.deepEqual(baseline.filter((e) => !bare.test(e.source_id)), [])
  })

  it('parses the eighth meeting', () => {
    const meetings = parseMeetings(CONFLICT_HTML)
    assert.equal(meetings.length, 8)
    const twin = meetings.find((m) => m.title === "Men's Step Study")
    assert.equal(twin.weekdayName, 'thursday')
    assert.equal(twin.startTime, '17:00')
  })

  it('produces 64 rows with 64 DISTINCT source_ids', () => {
    assert.equal(events.length, 64)
    assert.equal(new Set(events.map((e) => e.source_id)).size, 64)
  })

  it('leaves every non-colliding meeting byte-identical to the pre-collision run', () => {
    const idsByTitle = (rows) => {
      const out = {}
      for (const r of rows) (out[r.title] ??= []).push(r.source_id)
      return out
    }
    const before = idsByTitle(baseline)
    const after  = idsByTitle(events)
    for (const title of Object.keys(before)) {
      assert.deepEqual(after[title], before[title], `source_ids churned for "${title}"`)
    }
  })

  it('gives the bare id to the first occupant in document order and -2 to the twin', () => {
    const first = events.find((e) => e.title === 'Recovery Dharma Inquiry Circle' && e.ymd === '2026-08-27')
    const twin  = events.find((e) => e.title === "Men's Step Study" && e.ymd === '2026-08-27')
    assert.equal(first.source_id, 'meeting-thursday-1700-2026-08-27')
    assert.equal(twin.source_id,  'meeting-thursday-1700-2026-08-27-2')
  })

  it('suffixes the twin consistently across all eight of its occurrences', () => {
    const twinIds = events.filter((e) => e.title === "Men's Step Study").map((e) => e.source_id)
    assert.equal(twinIds.length, 8)
    assert.deepEqual(twinIds, [
      '2026-08-27', '2026-09-03', '2026-09-10', '2026-09-17',
      '2026-09-24', '2026-10-01', '2026-10-08', '2026-10-15',
    ].map((ymd) => `meeting-thursday-1700-${ymd}-2`))
  })

  it('numbers a third meeting in the same slot -3', () => {
    const third = "<li>Serenity Circle (Open) Meeting Starts at 5 pm</li>"
    const rows = buildMeetingEvents(CONFLICT_HTML.replace(TWIN, `${TWIN}\n${third}`), NOW)
    assert.equal(rows.length, 72)
    assert.equal(new Set(rows.map((e) => e.source_id)).size, 72)
    assert.equal(
      rows.find((e) => e.title === 'Serenity Circle' && e.ymd === '2026-08-27').source_id,
      'meeting-thursday-1700-2026-08-27-3',
    )
  })

  it('still does NOT churn a colliding meeting\'s id when its title is edited', () => {
    const renamed = buildMeetingEvents(
      CONFLICT_HTML.replace("Men&#8217;s Step Study", "Men&#8217;s Step Study Group"), NOW)
    assert.equal(
      renamed.find((e) => e.title === "Men's Step Study Group" && e.ymd === '2026-08-27').source_id,
      'meeting-thursday-1700-2026-08-27-2',
    )
    assert.deepEqual(renamed.map((e) => e.source_id), events.map((e) => e.source_id))
  })
})

describe('MIN_EXPECTED_MEETINGS floor', () => {
  it('is five', () => {
    assert.equal(MIN_EXPECTED_MEETINGS, 5)
  })

  it('the live page clears it', () => {
    assert.ok(parseMeetings(HTML).length >= MIN_EXPECTED_MEETINGS)
  })

  it('a shrunken page trips it (main() then fails the run instead of writing a partial schedule)', () => {
    // drop the Thursday and Friday blocks: three meetings left, under the floor
    const shrunk = HTML.slice(0, HTML.indexOf('<p><strong>THURSDAY:')) +
      HTML.slice(HTML.indexOf('<h3>Fear of Change Friday Meeting</h3>'))
    const meetings = parseMeetings(shrunk)
    assert.equal(meetings.length, 3)
    assert.ok(meetings.length < MIN_EXPECTED_MEETINGS)
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'jadfa_house')
  })
})
