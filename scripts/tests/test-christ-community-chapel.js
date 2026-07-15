/**
 * test-christ-community-chapel.js
 *
 * Pure-parser + faith-allowlist tests for the Christ Community Chapel scraper.
 * All HTML fixtures are REAL snippets captured from ccchapel.com on 2026-07-14.
 *
 * Run:  node --test scripts/tests/test-christ-community-chapel.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  SOURCE_KEY, parseListItems, parseDescription, parseOccurrences,
  parseHumanDate, parseTimeRange, isPublicEvent, resolveCampus, buildSourceId,
} = await import('../scrape-christ-community-chapel.js')

// ── Real fixtures ───────────────────────────────────────────────────────────

const LIST_ITEM = `<a href="https://ccchapel.com/events/reimagine-class-3"
           class="event-item"
           data-event-id="event_20899793"
           data-date-full-start="2026-07-16 18:30"
           data-tags="facilities,no,tier 2,guest experience,featured"
           data-day="Thu"
           data-time-period="time3"
           data-featured="true">
            <div class="event-image">
                <div>
                    <img src="https://images.planningcenterusercontent.com/v1/transform?bucket=resources-production&amp;disposition=inline&amp;expires_at=1785560399&amp;key=uploads%2F10085%2Fbkbobltsqecwvqzdccml2hehi68y&amp;thumb=960x540%23&amp;signature=abc123" alt="Reimagine Class  ">
                </div>
            </div>
            <div class="event-content">
                <div class="event-main-info">
                    <h3 class="event-title">Reimagine Class  </h3>
                </div>
            </div>
        </a>`

const FM_DESC = `<div class="description-content">
                                    <div>
  <div>Join us at the Legacy Park Fall Market for a fun and family-friendly community experience! Shop&nbsp; local produce, homemade baked goods, handcrafted items, flowers, jams, honey, and more from amazing local vendors. Enjoy live music, delicious food, and a welcoming atmosphere while supporting small businesses in our community.</div><div><br><br></div>
</div>
                                </div>`

const FM_INSTANCES = `<div class="content-section event-instances">
  <h6 class="h4 mb-4 fs_">Upcoming Event Dates</h6>
  <p class="text-muted mb-4">This event occurs 4 times.</p>
  <div class="instance-item">
    <div class="instance-date">
        Thursday, September 03, 2026
    </div>
    <div class="instance-time">
            4:00 PM
            - 7:00 PM
    </div>
  </div>
  <div class="instance-item">
    <div class="instance-date">
        Thursday, September 10, 2026
    </div>
    <div class="instance-time">
            4:00 PM
            - 7:00 PM
    </div>
  </div>
</div>`

// Single-occurrence event: the "Event Information" sidebar card (Cruisin').
const SINGLE_SIDEBAR = `<div class="event-sidebar">
  <div class="card_block_img_text bg-white p-4 mb-4">
    <h6 class="card-title fs_ mb-4">Event Information</h6>
    <div class="info-item mb-3">
      <div class="info-label">Date</div>
      <div class="info-value">
        Saturday, August 22, 2026
      </div>
    </div>
    <div class="info-item mb-3">
      <div class="info-label">Time</div>
      <div class="info-value">
        10:00 AM
        - 3:00 PM
      </div>
    </div>
  </div>
  <div class="card_block_img_text bg-white p-4">
    <h6 class="card-title fs_ mb-4">Event Details</h6>
  </div>
</div>`

// ── List parsing ────────────────────────────────────────────────────────────

describe('parseListItems', () => {
  it('extracts the core fields from an event-item anchor', () => {
    const [ev] = parseListItems(LIST_ITEM)
    assert.equal(ev.href, 'https://ccchapel.com/events/reimagine-class-3')
    assert.equal(ev.id, 'event_20899793')
    assert.equal(ev.title, 'Reimagine Class')
    assert.equal(ev.listStart, '2026-07-16 18:30')
    assert.equal(ev.tags, 'facilities,no,tier 2,guest experience,featured')
    assert.match(ev.image, /^https:\/\/images\.planningcenterusercontent\.com/)
    assert.ok(!ev.image.includes('&amp;'), 'image url entity-decoded')
  })
})

// ── Description + occurrences ───────────────────────────────────────────────

describe('parseDescription', () => {
  it('flattens the description-content HTML to text', () => {
    const d = parseDescription(FM_DESC)
    assert.match(d, /Join us at the Legacy Park Fall Market/)
    assert.match(d, /local vendors/)
    assert.ok(!/</.test(d), 'no tags remain')
  })
  it('returns empty string when there is no description block', () => {
    assert.equal(parseDescription('<div>nope</div>'), '')
  })
})

describe('parseOccurrences (recurring)', () => {
  it('returns one occurrence per instance-item with start+end', () => {
    const occ = parseOccurrences(FM_INSTANCES)
    assert.equal(occ.length, 2)
    assert.deepEqual(occ[0], { date: '2026-09-03', start: '4:00 PM', end: '7:00 PM', allDay: false })
    assert.equal(occ[1].date, '2026-09-10')
  })
})

describe('parseOccurrences (single sidebar)', () => {
  it('reads Date + Time from the Event Information card', () => {
    const occ = parseOccurrences(SINGLE_SIDEBAR)
    assert.equal(occ.length, 1)
    assert.deepEqual(occ[0], { date: '2026-08-22', start: '10:00 AM', end: '3:00 PM', allDay: false })
  })
})

// ── Date / time primitives ──────────────────────────────────────────────────

describe('parseHumanDate', () => {
  it('parses full weekday dates with leading zeros', () => {
    assert.equal(parseHumanDate('Thursday, September 03, 2026'), '2026-09-03')
  })
  it('parses dates without a leading zero', () => {
    assert.equal(parseHumanDate('Friday, August 7, 2026'), '2026-08-07')
  })
  it('returns null on junk', () => {
    assert.equal(parseHumanDate('coming soon'), null)
  })
})

describe('parseTimeRange', () => {
  it('parses a start–end range', () => {
    assert.deepEqual(parseTimeRange('4:00 PM - 7:00 PM'), { start: '4:00 PM', end: '7:00 PM', allDay: false })
  })
  it('parses a single start time (no end)', () => {
    assert.deepEqual(parseTimeRange('6:30 PM'), { start: '6:30 PM', end: null, allDay: false })
  })
  it('flags All Day / empty as all-day', () => {
    assert.equal(parseTimeRange('All Day').allDay, true)
    assert.equal(parseTimeRange('').allDay, true)
  })
})

// ── Faith allowlist gate ────────────────────────────────────────────────────

describe('isPublicEvent — keeps genuinely public community events', () => {
  it('keeps a farmers market (apostrophe folded so shared list matches)', () => {
    assert.equal(isPublicEvent("Fall Farmer's Market", 'Join us at the Legacy Park Fall Market with local vendors and live music.'), true)
  })
  it('keeps an outdoor car show via the local supplement', () => {
    assert.equal(isPublicEvent("Cruisin' The Chapel", 'Come and enjoy a show of 400+ great cars! Free ice cream and fun for the entire family!'), true)
  })
  it('keeps an outdoor movie night via the local supplement', () => {
    assert.equal(isPublicEvent('Pixar in the Park', 'Join us for an outdoor movie night for the whole family under the stars.'), true)
  })
  it('still keeps a real fundraiser "benefit" (guard only strips the verb)', () => {
    assert.equal(isPublicEvent('Benefit Concert for Missions', 'An evening of music to support our missions fund.'), true)
  })
})

describe('isPublicEvent — skips internal congregational activity', () => {
  const internal = [
    ['Reimagine Class', 'A membership class for those exploring CCC.'],
    ['Baptism Class', 'Preparing for baptism.'],
    ["Women's Summer Study", 'A summer bible study for women.'],
    ['Men of the Word', 'Weekly small group for men.'],
    ['Ability Inclusion Bible Study', ''],
    ['Member Meeting', 'Quarterly membership meeting.'],
    ["Young Adults' Dinner", 'Dinner and connection for young adults.'],
    ['Widows Sisterhood', 'Member care gathering.'],
    // Real leak fixed by the incidental-"benefit" guard: the shared list's
    // fundraiser signal matched "…would benefit from a volunteer pairing…".
    ['Ability Inclusion Kids Class', 'Every Thursday we offer a class for kids with disabilities. If your child would benefit from a volunteer pairing while attending class with typical peers, please email us.'],
    ['Ability Inclusion Kids Sunday 10:30 Service', 'Every Sunday we offer a class for kids with disabilities who would benefit from an environment tailored to their needs.'],
  ]
  for (const [title, desc] of internal) {
    it(`skips "${title}"`, () => {
      assert.equal(isPublicEvent(title, desc), false)
    })
  }
})

// ── Summit County campus resolution ─────────────────────────────────────────

describe('resolveCampus', () => {
  it('maps Legacy Park mentions to the Legacy Park venue in Hudson', () => {
    const r = resolveCampus("Fall Farmer's Market", 'Join us at Legacy Park for the market.', 'legacy park')
    assert.equal(r.venueName, 'Legacy Park')
    assert.equal(r.city, 'Hudson')
  })
  it('defaults to the Hudson campus when no location is named', () => {
    const r = resolveCampus('Community Concert', 'An evening of music.', '')
    assert.equal(r.venueName, 'Christ Community Chapel')
    assert.equal(r.city, 'Hudson')
  })
  it('flags an out-of-county community named in a locative frame', () => {
    const r = resolveCampus('Aurora Campus Serve Day', 'Serving our neighbors in Aurora.', '')
    assert.equal(r.city, 'aurora')
  })

  // Adversarial regressions: bare city WORDS in free text (not a locative
  // frame) must NOT be read as geo signals, or common English phrasing that
  // collides with a non-Summit place name silently drops legit Hudson events.
  it('does NOT treat "Independence Day" as Independence, OH (defaults Hudson)', () => {
    const r = resolveCampus('Independence Day Celebration', 'Fireworks and food trucks on the lawn.', '')
    assert.equal(r.city, 'Hudson')
  })
  it('does NOT treat "mentor kids" as Mentor, OH', () => {
    const r = resolveCampus('Mentor Appreciation Night', 'Honoring volunteers who mentor kids.', '')
    assert.equal(r.city, 'Hudson')
  })
  it('does NOT treat "Orange you glad" as Orange, OH', () => {
    const r = resolveCampus('Orange You Glad Fall Fest', 'A fun fall festival for the family.', '')
    assert.equal(r.city, 'Hudson')
  })
  it('does NOT treat a "Warren"/"Canton" name-drop as a location', () => {
    const r = resolveCampus('Warren Coleman Memorial 5K', 'In memory of Warren; run through Canton Park loop.', '')
    assert.equal(r.city, 'Hudson')
  })
  it('still gates a real "in <City>" mention (Streetsboro = Portage)', () => {
    const r = resolveCampus('Serve Day', 'Meet us in Streetsboro to serve.', '')
    assert.equal(r.city, 'streetsboro')
  })
})

// ── Misc contract ───────────────────────────────────────────────────────────

describe('module contract', () => {
  it('exposes the source key', () => {
    assert.equal(SOURCE_KEY, 'christ_community_chapel')
  })
  it('builds a stable per-occurrence source_id', () => {
    assert.equal(buildSourceId('event_20899793', '2026-09-03'), 'event_20899793-2026-09-03')
  })
})
