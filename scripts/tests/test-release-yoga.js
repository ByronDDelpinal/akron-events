/**
 * test-release-yoga.js — parsing for the Release Yoga MINDBODY enrollments
 * scraper: enrollment-box extraction, the MINDBODY date line, and row building.
 * The HTTP fetch is an integration concern and isn't unit-tested here.
 *
 * Run:  node --test scripts/tests/test-release-yoga.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseEnrollments, parseEnrollmentDate, buildRow, SOURCE_KEY } =
  await import('../scrape-release-yoga.js')

// Mirrors the live .enrollment_box markup: a paid workshop and a free one.
const HTML = `
<div class="enrollments_title">Workshops &amp; Events</div>
<div class="enrollment_box">
  <div class="enrollment_box_image"><img src="https://clients-content.mindbodyonline.com/studios/release/reservations/762.jpg"></div>
  <div class="enrollment_box_text">
    <span class="not_entire">Reiki Drumming - $35 <span class="instructor"><span class="enrollments_with">with</span>
      <a><span class="mb_le_staff_firstname">Mary</span> <span class="mb_le_staff_lastname">Laske Bell, PhD</span></a></span></span>
    <span class="right bold_date">Fri, Jun 19, 2026 at 6:00 pm - 7:00 pm</span>
    <span class="desc_text more"><span class="description"><div>Reiki Drumming combines sound and energy.<p>Deeply relaxing.</p></div></span><a class="morelink">Learn More</a></span>
  </div>
</div>
<div class="enrollment_box">
  <div class="enrollment_box_image"><img src="https://clients-content.mindbodyonline.com/studios/release/reservations/801.jpg"></div>
  <div class="enrollment_box_text">
    <span class="not_entire">Community Meditation <span class="instructor"><span class="enrollments_with">with</span>
      <a><span class="mb_le_staff_firstname">Dawn</span> <span class="mb_le_staff_lastname">Taylor</span></a></span></span>
    <span class="right bold_date">Sat, Jul 4, 2026 at 10:00 am - 11:00 am</span>
    <span class="desc_text more"><span class="description"><div>All are welcome.</div></span><a class="morelink">Learn More</a></span>
  </div>
</div>
`

describe('Release Yoga parseEnrollments', () => {
  const list = parseEnrollments(HTML)

  it('extracts one entry per .enrollment_box', () => {
    assert.equal(list.length, 2)
  })

  it('parses title, price, instructor, date, description, image', () => {
    const a = list[0]
    assert.equal(a.title, 'Reiki Drumming')          // price stripped off
    assert.equal(a.price, 35)
    assert.equal(a.instructor, 'Mary Laske Bell, PhD')
    assert.equal(a.dateText, 'Fri, Jun 19, 2026 at 6:00 pm - 7:00 pm')
    assert.ok(a.description.startsWith('Reiki Drumming combines'))
    assert.ok(a.imageUrl.endsWith('/762.jpg'))
  })

  it('leaves price null when no $ is present (does not assume free)', () => {
    assert.equal(list[1].title, 'Community Meditation')
    assert.equal(list[1].price, null)
  })

  it('returns [] for empty/invalid input', () => {
    assert.deepEqual(parseEnrollments(''), [])
    assert.deepEqual(parseEnrollments(null), [])
  })
})

describe('Release Yoga parseEnrollmentDate', () => {
  it('parses a single-day date/time line to 24h clock times', () => {
    assert.deepEqual(parseEnrollmentDate('Fri, Jun 19, 2026 at 6:00 pm - 7:00 pm'),
      { dateYmd: '2026-06-19', start: '18:00:00', end: '19:00:00' })
  })
  it('handles am + noon/midnight + missing end time', () => {
    assert.deepEqual(parseEnrollmentDate('Sat, Jul 4, 2026 at 10:00 am - 11:00 am'),
      { dateYmd: '2026-07-04', start: '10:00:00', end: '11:00:00' })
    assert.equal(parseEnrollmentDate('Mon, Dec 1, 2026 at 12:00 pm').start, '12:00:00')
  })
  it('returns null for unparseable / multi-day ranges', () => {
    assert.equal(parseEnrollmentDate('Jun 19 - Jun 22, 2026'), null)
    assert.equal(parseEnrollmentDate(''), null)
  })
})

describe('Release Yoga buildRow', () => {
  it('builds a UTC-anchored row with a stable source_id', () => {
    const row = buildRow(parseEnrollments(HTML)[0])
    assert.equal(row.title, 'Reiki Drumming')
    assert.ok(row.start_at.endsWith('Z'))
    assert.ok(row.end_at.endsWith('Z'))
    assert.equal(row.price_min, 35)
    assert.equal(row.category, null)                 // defer to inference
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'release_yoga-reiki-drumming-2026-06-19')
    assert.equal(row.ticket_url, 'https://releaseyoga.com/apps/mindbody/enrollments')
  })
  it('returns null when the enrollment has no parseable date', () => {
    assert.equal(buildRow({ title: 'Mystery Retreat', dateText: 'Sometime in fall', price: null }), null)
  })
})
