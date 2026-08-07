/**
 * test-stewarts-partner-events.js - pure parsers for the Stewart's Caring
 * Place Community Partner Events scraper. The fixture is a trimmed-but-real
 * capture of stewartscaringplace.org/community-partner-events/ (2026-08-07):
 * see scripts/tests/fixtures/stewarts-partner-events.html.
 *
 * Run:  node --test scripts/tests/test-stewarts-partner-events.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseSections, parseStructuredLines, parseProseDate, parseDateSpan,
  parseTimeRange, buildSourceId, parseCity, parseTicketUrl, parseEvents,
  SOURCE_KEY,
} = await import('../scrape-stewarts-partner-events.js')
const { isSelfCredit, isAggregatorSelfOrgName } = await import('../lib/source-tiers.js')
const { collectLinkDonations } = await import('../dedupe-cross-source.js')

const FIXTURE = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/stewarts-partner-events.html'),
  'utf8')

// The Eastern date the fixture was captured; all year-less dates on the page
// resolve against it in these tests.
const TODAY = '2026-08-07'

describe('parseSections', () => {
  const sections = parseSections(FIXTURE)
  it('finds all six classic-content sections (CTA + 5 event blocks)', () => {
    assert.equal(sections.length, 6)
  })
  it('titles come from headings, with a prose fallback for the heading-less exhibition block', () => {
    const titles = sections.map((s) => s.title)
    assert.ok(titles.some((t) => t.startsWith('Holding Light')))
    assert.ok(titles.some((t) => t.includes('Stampin\' Out Cancer Challenge')))
    assert.ok(titles.some((t) => t.includes('Stuff The Bus')))
    assert.ok(titles.some((t) => t.startsWith('Fighting Cancer')))
    assert.ok(titles.some((t) => t.includes('Cars & Coffee')))
  })
})

describe('parseStructuredLines', () => {
  const sections = parseSections(FIXTURE)
  it('reads labelled Date:/Time:/Location: lines (Fighting Cancer block)', () => {
    const s = sections.find((x) => x.title.startsWith('Fighting Cancer'))
    const lines = parseStructuredLines(s.html)
    assert.equal(lines.dateText, 'Saturday, September 12')
    assert.match(lines.timeText, /7pm/)
    assert.equal(lines.locationText, 'The Rialto Theatre')
  })
  it('reads the unlabelled h5 stack (Stuff the Bus block)', () => {
    const s = sections.find((x) => x.title.includes('Stuff The Bus'))
    const lines = parseStructuredLines(s.html)
    assert.equal(lines.dateText, 'Thursday, September 10, 2026')
    assert.equal(lines.timeText, '3:00-7:00pm')
    assert.match(lines.locationText, /Stewart's Caring Place/)
  })
  it('organizer ONLY from explicit presented-by/hosted-by language', () => {
    const stampin = sections.find((x) => x.title.includes('Stampin'))
    assert.equal(parseStructuredLines(stampin.html).organizer, 'Bikers for Boobs')
    const concert = sections.find((x) => x.title.startsWith('Fighting Cancer'))
    assert.equal(parseStructuredLines(concert.html).organizer, null)
  })
})

describe('parseProseDate', () => {
  it('full date with year: "Thursday, September 10, 2026"', () => {
    assert.equal(parseProseDate('Thursday, September 10, 2026', TODAY), '2026-09-10')
  })
  it('year-less date resolves against todayIso\'s Eastern year when the weekday validates', () => {
    // 2026-09-12 IS a Saturday.
    assert.equal(parseProseDate('Saturday, September 12', TODAY), '2026-09-12')
  })
  it('year-less past date rolls forward a year', () => {
    assert.equal(parseProseDate('May 30th', TODAY), '2027-05-30')
  })
  it('December date in a January todayIso stays in the current year (still ahead)', () => {
    assert.equal(parseProseDate('December 12', '2027-01-05'), '2027-12-12')
  })
  it('a stated weekday matching neither candidate year returns null (bad page data)', () => {
    // 2026-09-12 is a Saturday and 2027-09-12 is a Sunday - never a Friday.
    assert.equal(parseProseDate('Friday, September 12', TODAY), null)
  })
  it('a stated weekday can pick the NEXT year when this year mismatches', () => {
    // 2026-09-12 = Saturday, 2027-09-12 = Sunday.
    assert.equal(parseProseDate('Sunday, September 12', TODAY), '2027-09-12')
  })
  it('no month-name date -> null', () => {
    assert.equal(parseProseDate('coming soon', TODAY), null)
  })
  it('"February 29" resolving into non-leap candidate years -> null, never a rolled date', () => {
    // From TODAY the candidates are 2027 (preferred, Feb 29 already past in
    // 2026) and 2026 - neither is a leap year, so the date does not exist.
    // Pre-fix this rolled to March 1.
    assert.equal(parseProseDate('February 29', TODAY), null)
  })
  it('"February 29" with an explicit leap year stated is valid', () => {
    assert.equal(parseProseDate('February 29, 2028', TODAY), '2028-02-29')
  })
  it('"February 29" with an explicit NON-leap year stated -> null', () => {
    assert.equal(parseProseDate('February 29, 2026', TODAY), null)
  })
  it('"September 31" -> null in every year (never rolls to October 1)', () => {
    assert.equal(parseProseDate('September 31', TODAY), null)
    assert.equal(parseProseDate('September 31, 2026', TODAY), null)
  })
  it('a year-less Feb 29 can still resolve when a candidate year IS a leap year', () => {
    // TODAY in 2027: Feb 29 2027 is "past" (and invalid anyway), preferred
    // rolls to 2028 which is a leap year.
    assert.equal(parseProseDate('February 29', '2027-08-07'), '2028-02-29')
  })
})

describe('parseDateSpan (multi-week campaign detection)', () => {
  it('"May 30th - August 29th" spans 91 days', () => {
    const span = parseDateSpan('May 30th – August 29th', TODAY)
    assert.equal(span.startIso, '2026-05-30')
    assert.equal(span.endIso, '2026-08-29')
    assert.equal(span.days, 91)
  })
  it('month-only range "July through September, 2026" widens to whole months', () => {
    const span = parseDateSpan('from July through September, 2026', TODAY)
    assert.equal(span.startIso, '2026-07-01')
    assert.equal(span.endIso, '2026-09-30')
    assert.ok(span.days > 14)
  })
  it('a single date is not a span', () => {
    assert.equal(parseDateSpan('Saturday, September 12', TODAY), null)
  })
})

describe('parseTimeRange', () => {
  it('"3:00-7:00pm": start inherits the end meridiem', () => {
    assert.deepEqual(parseTimeRange('3:00-7:00pm'), { start: '15:00', end: '19:00' })
  })
  it('"7pm - 10pm"', () => {
    assert.deepEqual(parseTimeRange('7pm – 10pm'), { start: '19:00', end: '22:00' })
  })
  it('"9am - 12pm": noon end, morning start', () => {
    assert.deepEqual(parseTimeRange('9am – 12pm'), { start: '09:00', end: '12:00' })
  })
  it('no time -> null (the scraper then applies the sanctioned noon default)', () => {
    assert.equal(parseTimeRange('Join us for a fun day!'), null)
  })
  it('"10pm - 1am" crosses midnight: stated start kept, end flagged next-day', () => {
    // Pre-fix this returned null and silently downgraded a STATED start to
    // the noon default.
    assert.deepEqual(parseTimeRange('10pm - 1am'), { start: '22:00', end: '01:00', endNextDay: true })
  })
  it('"7pm - 12am" ends at midnight next day', () => {
    assert.deepEqual(parseTimeRange('7pm - 12am'), { start: '19:00', end: '00:00', endNextDay: true })
  })
})

describe('buildSourceId', () => {
  it('slugified title + date', () => {
    assert.equal(buildSourceId('Cars & Coffee', '2026-09-20'), 'cars-and-coffee-2026-09-20')
  })
  it('stable across description edits (title + date only)', () => {
    assert.equal(buildSourceId('Cars & Coffee', '2026-09-20'), buildSourceId('Cars & Coffee', '2026-09-20'))
  })
})

describe('parseCity (Summit gate input)', () => {
  it('finds a known city inside a location line', () => {
    assert.equal(parseCity("Stewart's Caring Place Fairlawn"), 'fairlawn')
    assert.equal(parseCity('Aunt Susie\'s Cancer Wellness Center, Canton'), 'canton')
  })
  it('venue names with no known city stay null (city-less blocks pass the gate)', () => {
    assert.equal(parseCity('The Rialto Theatre'), null)
    assert.equal(parseCity(null), null)
  })
})

describe('parseEvents (full pure parse over the real fixture)', () => {
  const { events, skipped } = parseEvents(FIXTURE, TODAY)

  it('ingests the three dated events and skips the three non-events', () => {
    assert.equal(events.length, 3)
    assert.equal(skipped.length, 3)
  })

  it('skips the >14-day campaigns with a span reason', () => {
    const reasons = Object.fromEntries(skipped.map((s) => [s.title, s.reason]))
    const stampin = skipped.find((s) => s.title.includes('Stampin'))
    assert.match(stampin.reason, /span 91 days exceeds 14/)
    const exhibition = skipped.find((s) => s.title.startsWith('Holding Light'))
    assert.match(exhibition.reason, /exceeds 14/)
    assert.equal(Object.keys(reasons).length, 3) // + the dateless mailto CTA block
  })

  it('structured Sep 10 block: 3pm ET start (19:00Z), SCP venue, qgiv ticket', () => {
    const ev = events.find((e) => e.title.includes('Stuff The Bus'))
    assert.equal(ev.dateIso, '2026-09-10')
    assert.equal(ev.startIso, '2026-09-10T19:00:00.000Z')
    assert.equal(ev.endIso, '2026-09-10T23:00:00.000Z')
    assert.equal(ev.timeStated, true)
    assert.match(ev.locationText, /Stewart's Caring Place/)
    assert.equal(ev.ticketUrl, 'https://secure.qgiv.com/for/compareve/event/stbblackjack_bbq/')
  })

  it('year-less "Saturday, September 12" concert resolves to 2026-09-12 at The Rialto Theatre, organizer null', () => {
    const ev = events.find((e) => e.title.startsWith('Fighting Cancer'))
    assert.equal(ev.dateIso, '2026-09-12')
    assert.equal(ev.startIso, '2026-09-12T23:00:00.000Z') // 7pm EDT
    assert.equal(ev.locationText, 'The Rialto Theatre')
    assert.equal(ev.organizer, null) // no hosted-by/presented-by language: never SCP
    assert.equal(ev.category, 'music')
    assert.equal(ev.isFundraiser, true) // "Benefit Concert"
    assert.equal(ev.ticketUrl, 'https://secure.qgiv.com/for/compareve/event/fightingcancerbenefitconcert/')
  })

  it('"9am - 12pm" Cars & Coffee: morning range, explicit organizer, proceeds -> fundraiser', () => {
    const ev = events.find((e) => e.title.includes('Cars & Coffee'))
    assert.equal(ev.dateIso, '2026-09-20')
    assert.equal(ev.startIso, '2026-09-20T13:00:00.000Z') // 9am EDT
    assert.equal(ev.endIso, '2026-09-20T16:00:00.000Z')   // noon EDT
    assert.equal(ev.organizer, 'Bologna Insurance Agency, Inc.')
    assert.equal(ev.isFundraiser, true) // "100% of proceeds"
  })

  it('source ids are slug+date, stable when descriptions change', () => {
    const ev = events.find((e) => e.title.includes('Cars & Coffee'))
    assert.equal(ev.sourceId, 'cars-and-coffee-2026-09-20')
    const reworded = FIXTURE.replace('annual family-friendly car cruise-in', 'yearly car show for the whole family')
    const again = parseEvents(reworded, TODAY).events.find((e) => e.title.includes('Cars & Coffee'))
    assert.equal(again.sourceId, ev.sourceId)
  })

  it('a dated block with no stated time takes the sanctioned noon ET default', () => {
    const block = `
      <section class="section classic-content alignfull" id="x">
        <div class="container"><div class="content-cell">
          <h4>Pancake Morning</h4>
          <p><strong>Date: Saturday, September 12</strong></p>
          <p>Join us for a community morning.</p>
        </div></div>
      </section>`
    const { events: evs } = parseEvents(block, TODAY)
    assert.equal(evs.length, 1)
    assert.equal(evs[0].timeStated, false)
    assert.equal(evs[0].startIso, '2026-09-12T16:00:00.000Z') // noon EDT
    assert.equal(evs[0].endIso, null)
    assert.equal(evs[0].ticketUrl, 'https://stewartscaringplace.org/community-partner-events/')
  })

  it('a cross-midnight time keeps its stated start; the end lands next day', () => {
    const block = `
      <section class="section classic-content alignfull" id="x">
        <div class="container"><div class="content-cell">
          <h4>Late Night Benefit</h4>
          <p><strong>Date: Saturday, September 12<br/>Time: 10pm - 1am</strong></p>
        </div></div>
      </section>`
    const { events: evs } = parseEvents(block, TODAY)
    assert.equal(evs.length, 1)
    assert.equal(evs[0].timeStated, true) // NOT the noon default
    assert.equal(evs[0].startIso, '2026-09-13T02:00:00.000Z') // 10pm EDT Sep 12
    assert.equal(evs[0].endIso,   '2026-09-13T05:00:00.000Z') // 1am EDT Sep 13
  })

  it('a calendar-invalid date (September 31) is skipped, not rolled into October', () => {
    const block = `
      <section class="section classic-content alignfull" id="x">
        <div class="container"><div class="content-cell">
          <h4>Ghost Gala</h4>
          <p><strong>Date: September 31</strong></p>
        </div></div>
      </section>`
    const { events: evs, skipped: sk } = parseEvents(block, TODAY)
    assert.equal(evs.length, 0)
    assert.equal(sk.length, 1)
    assert.match(sk[0].reason, /no parseable date/)
  })

  it('a weekday-mismatch date is skipped, not guessed', () => {
    const block = `
      <section class="section classic-content alignfull" id="x">
        <div class="container"><div class="content-cell">
          <h4>Phantom Event</h4>
          <p><strong>Date: Friday, September 12</strong></p>
        </div></div>
      </section>`
    const { events: evs, skipped: sk } = parseEvents(block, TODAY)
    assert.equal(evs.length, 0)
    assert.equal(sk.length, 1)
    assert.match(sk[0].reason, /no parseable date/)
  })

  it('an out-of-county location is gated', () => {
    const block = `
      <section class="section classic-content alignfull" id="x">
        <div class="container"><div class="content-cell">
          <h4>Satellite Benefit</h4>
          <p><strong>Date: Saturday, September 12<br/>Time: 7pm - 10pm<br/>Location: Canton Palace Theatre, Canton</strong></p>
        </div></div>
      </section>`
    const { events: evs, skipped: sk } = parseEvents(block, TODAY)
    assert.equal(evs.length, 0)
    assert.match(sk[0].reason, /outside Summit County \(canton\)/)
  })
})

describe('parseTicketUrl', () => {
  it('qgiv href wins; non-qgiv register buttons still count; else null', () => {
    assert.equal(
      parseTicketUrl('<a class="button" href="https://secure.qgiv.com/for/x/">Register Now!</a>'),
      'https://secure.qgiv.com/for/x/')
    assert.equal(
      parseTicketUrl('<a class="button button--medium-blue" href="http://bit.ly/StampinOutCancer2026">Register Now!</a>'),
      'http://bit.ly/StampinOutCancer2026')
    assert.equal(parseTicketUrl('<a href="mailto:info@example.org">Contact us</a>'), null)
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'stewarts_partner_events')
  })
})

describe('attribution: SCP self-credit guard (aggregator may never credit itself)', () => {
  // A partner block whose "Hosted by:" line names Stewart's Caring Place
  // itself. SCP is the BENEFICIARY, not the host - no organizer link path may
  // credit it on this source's rows. These assertions run the REAL guard
  // functions the choke points call: linkEventOrganization (normalize.js)
  // gates on isAggregatorSelfOrgName then isSelfCredit, and the dedupe merge
  // path runs collectLinkDonations (dedupe-cross-source.js).
  const block = `
    <section class="section classic-content alignfull" id="x">
      <div class="container"><div class="content-cell">
        <h4>Wellness Walk</h4>
        <p><strong>Date: Saturday, September 12<br/>Time: 9am - 12pm<br/>Location: Stewart's Caring Place, Fairlawn</strong></p>
        <p><strong>Hosted by: Stewart's Caring Place</strong></p>
        <p>A community walk.</p>
      </div></div>
    </section>`
  const ev = parseEvents(block, TODAY).events[0]

  it('the parser still surfaces the page\'s stated organizer verbatim', () => {
    // The guard lives at the link choke points, not in the parser - parsing
    // must stay honest so the guard is what gets exercised.
    assert.equal(ev.organizer, "Stewart's Caring Place")
  })

  it('scraper path: linkEventOrganization\'s guard pair fires for this source+org', () => {
    // linkEventOrganization (scripts/lib/normalize.js) returns without
    // linking exactly when both of these are true and no selfHostVerified
    // opt-in is passed.
    assert.equal(isAggregatorSelfOrgName(ev.organizer), true)
    assert.equal(isSelfCredit(SOURCE_KEY, ev.organizer), true)
  })

  it('merge path: collectLinkDonations never launders the self-credit onto another row', () => {
    const ORG_SCP = '44444444-4444-4444-4444-444444444444'
    const canonical = { source: 'stewarts_caring_place', event_venues: [], event_organizations: [] }
    const donors = [{
      source: SOURCE_KEY,
      event_venues: [],
      event_organizations: [
        { organization_id: ORG_SCP, organizations: { name: ev.organizer } },
      ],
    }]
    assert.deepEqual(collectLinkDonations(canonical, donors).orgIds, [])
  })

  it('the Tier-1 stewarts_caring_place scraper\'s legitimate self-attribution is unaffected', () => {
    // isSelfCredit is keyed on the (source, org) PAIR: only the aggregator
    // source key has an AGGREGATOR_SELF_ORG entry.
    assert.equal(isSelfCredit('stewarts_caring_place', "Stewart's Caring Place"), false)
  })

  it('a REAL partner host on this source still passes the guard', () => {
    // The policy is "real organizer or none", not "no organizer".
    assert.equal(isSelfCredit(SOURCE_KEY, 'Bologna Insurance Agency, Inc.'), false)
    assert.equal(isAggregatorSelfOrgName('Bologna Insurance Agency, Inc.'), false)
  })
})
