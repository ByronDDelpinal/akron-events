/**Fixture data for Akron Zoo scraper tests.*/

// Date format fixtures — zoo uses abbreviated 3-letter months, no year
export const DATE_FIXTURES = [
  { raw: 'JUN 13',           expectedDate: '2026-06-13' },
  { raw: 'AUG 07',           expectedDate: '2026-08-07' },
  { raw: 'SEP 04',           expectedDate: '2026-09-04' },
  { raw: 'JUL 24 - JUL 26', expectedDate: '2026-07-24' }, // date range — use start
  { raw: 'SEP 1 - 30',       expectedDate: '2026-09-01' }, // day range
  { raw: 'OCT 3 & OCT 4',    expectedDate: '2026-10-03' }, // & separator
  { raw: 'OCT 10-31',        expectedDate: '2026-10-10' }, // hyphen day range
  { raw: 'NOV 7 - 11',       expectedDate: '2026-11-07' }, // short day range
  { raw: 'NOV 20 - DEC 27',  expectedDate: '2026-11-20' }, // cross-month range
]

// HTML card fixture — matches the actual *raw HTTP response* from akronzoo.org/events
// Structure confirmed by fetching the page directly (not via Chrome DOM which adds Slick classes).
export const CARD_HTML = `
<div class="item xxtight">        <a class="wrap" href="/lions-tigers-and-bearsoh-my">
  <div class="text">Lions, Tigers and Bears...OH MY!<br><span class="date">Jun 13</span></div>
  <span class="bg bg-replace"><img loading="lazy" src="/sites/default/files/styles/large/public/2025-12/LTB.png" width="400" height="400" alt="LTB" /></span>
</a></div>
<div class="item xxtight">        <a class="wrap" href="/zoothing-hour">
  <div class="text">Zoothing Hour<br><span class="date">Jun 20</span></div>
  <span class="bg bg-replace"><img loading="lazy" src="/sites/default/files/styles/large/public/2025-12/sensory.png" width="400" height="400" alt="Sensory Inclusion" /></span>
</a></div>
<div class="item xxtight">        <a class="wrap" href="/zoothing-hour">
  <div class="text">Zoothing Hour<br><span class="date">Jul 19</span></div>
  <span class="bg bg-replace"><img loading="lazy" src="/sites/default/files/styles/large/public/2025-12/sensory.png" width="400" height="400" alt="Sensory Inclusion" /></span>
</a></div>
`

// Legacy fixtures kept for backward compatibility
export const FIXTURE_1 = { raw: 'July 15, 2026', expectedDate: '2026-07-15' }
export const FIXTURE_2 = { raw: 'December 25, 2026', expectedDate: '2026-12-25' }
export const ALL_FIXTURES = [FIXTURE_1, FIXTURE_2]

// Detail-page fixture — mirrors the real akronzoo.org event page <head>.
// The time ("10 a.m. - 4 p.m.") and description live ONLY on the detail page,
// not on the listing card, so the scraper must fetch this to fill them in.
export const DETAIL_HTML = `
<!doctype html><html><head>
<meta charset="utf-8">
<meta name="description" content="10 a.m. - 4 p.m. Follow the Yellow Brick Road to a magical day at the zoo! Meet our own &quot;Lions, Tigers and Bears&quot; as you enjoy themed activities, enchanting encounters and a touch of Emerald City fun.&nbsp; General admission rates apply for this event and is FREE for Akron Zoo members.&nbsp;">
<meta property="og:title" content="Lions, Tigers and Bears...OH MY! | Akron Zoo">
<meta property="og:image" content="https://www.akronzoo.org/sites/default/files/2025-12/LTB.png">
<title>Lions, Tigers and Bears...OH MY! | Akron Zoo</title>
</head><body><h1>Lions, Tigers and Bears...OH MY!</h1></body></html>
`

// Detail page with no time in the copy — scraper should fall back to 10 a.m.
export const DETAIL_HTML_NO_TIME = `
<!doctype html><html><head>
<meta name="description" content="Join us for a wild morning of animal encounters and family fun across the zoo.">
</head><body></body></html>
`
