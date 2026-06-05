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
