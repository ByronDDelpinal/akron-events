import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEvents,
  extractDetail,
  permalinkSlug,
  deSlugTitle,
  parseDate,
  parseTime,
} from '../scrape-better-kenmore.js'

// ── List page ──────────────────────────────────────────────────────────────
// Mirrors the Events Manager markup: a title link AND a "More Info" button both
// pointing at the same /events/{slug}/ permalink, plus the meta lines. The
// regression this guards: the title link text is unreliable ("More Info"), so
// the scraper must key off the permalink, not the anchor text.
const LIST_HTML = `
<div class="em-event em-item">
  <div class="em-event-title">
    <a href="/events/a-band-named-ashes-doug-kleiner-frida-and-the-mann/">More Info</a>
  </div>
  <a class="em-more-info" href="/events/a-band-named-ashes-doug-kleiner-frida-and-the-mann/">More Info</a>
  <div class="em-item-meta-line em-event-date">Friday June 5, 2026</div>
  <div class="em-item-meta-line em-event-time">7:00 pm - 10:00 pm</div>
  <div class="em-item-meta-line em-event-location">The Rialto</div>
</div>
`

test('parseEvents keys off the permalink, not the "More Info" link text', () => {
  const events = parseEvents(LIST_HTML)
  assert.equal(events.length, 1)
  const ev = events[0]
  assert.equal(ev.sourceId, 'a-band-named-ashes-doug-kleiner-frida-and-the-mann')
  assert.equal(ev.ticketUrl, 'https://www.betterkenmore.org/events/a-band-named-ashes-doug-kleiner-frida-and-the-mann/')
  assert.equal(ev.dateStr, '2026-06-05')
  assert.equal(ev.timeStr, '19:00:00')
  assert.equal(ev.location, 'The Rialto')
})

test('permalinkSlug extracts the final path segment', () => {
  assert.equal(
    permalinkSlug('https://www.betterkenmore.org/events/twin-b-project-old-97/'),
    'twin-b-project-old-97',
  )
  assert.equal(permalinkSlug('/events/chair-yoga-2-2026-06-12/'), 'chair-yoga-2-2026-06-12')
  assert.equal(permalinkSlug(''), null)
})

// ── Detail page (Open Graph) ────────────────────────────────────────────────
// The real og: tags from the live detail page (entities + date prefix + a
// trailing Facebook share URL), which the scraper must clean up.
const DETAIL_HTML = `
<meta property="og:title" content="A Band Named Ashes / Doug Kleiner / Frida and The Mann - Better Kenmore" />
<meta property="og:description" content="Friday June 5, 2026 @ 7:00 pm - 10:00 pm - A Band Named Ashes is a progressive folk band from Akron, OH. Doug Kleiner&#8217;s storytelling is raw. https://www.facebook.com/events/1304698301624473/" />
<meta property="og:image" content="https://www.betterkenmore.org/wp-content/uploads/2026/05/abna.jpg" />
`

test('extractDetail pulls the real title, clean description, and image', () => {
  const { title, description, image } = extractDetail(DETAIL_HTML)

  // Real title, with the " - Better Kenmore" site suffix stripped.
  assert.equal(title, 'A Band Named Ashes / Doug Kleiner / Frida and The Mann')

  // Date/time prefix removed; HTML entity decoded; trailing share URL dropped.
  assert.ok(description.startsWith('A Band Named Ashes is a progressive folk band'))
  assert.ok(description.includes('Doug Kleiner’s storytelling is raw.'))
  assert.ok(!/^Friday June 5/.test(description))
  assert.ok(!description.includes('facebook.com'))

  assert.equal(image, 'https://www.betterkenmore.org/wp-content/uploads/2026/05/abna.jpg')
})

test('extractDetail handles a single (non-range) time prefix', () => {
  const html = `<meta property="og:description" content="Saturday July 4, 2026 @ 11:00 am - Pancake breakfast on the BLVD." />`
  const { description } = extractDetail(html)
  assert.equal(description, 'Pancake breakfast on the BLVD.')
})

// ── Slug fallback (used only when a detail fetch fails) ──────────────────────
test('deSlugTitle title-cases and strips recurrence date chains', () => {
  assert.equal(deSlugTitle('twin-b-project-old-97'), 'Twin B Project Old')
  assert.equal(deSlugTitle('chair-yoga-2-2026-06-12'), 'Chair Yoga')
  assert.equal(
    deSlugTitle('aa-crossroads-meeting-2026-05-31-2026-06-07'),
    'Aa Crossroads Meeting',
  )
  assert.equal(deSlugTitle(''), 'Better Kenmore Event')
})

// ── Date/time sanity ────────────────────────────────────────────────────────
test('parseDate / parseTime', () => {
  assert.equal(parseDate('Friday June 5, 2026'), '2026-06-05')
  assert.equal(parseTime('7:00 pm - 10:00 pm'), '19:00:00')
  assert.equal(parseTime('9:30 am - 10:30 am'), '09:30:00')
  assert.equal(parseTime(''), '00:00:00')
})
