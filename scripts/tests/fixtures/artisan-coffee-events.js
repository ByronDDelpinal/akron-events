/**
 * Fixtures for the Artisan Coffee scraper tests.
 *
 * Shape mirrors real Squarespace Events collection items (?format=json):
 * epoch-ms startDate/endDate, HTML body, location object, fullUrl, assetUrl.
 * Values reflect the live artisancoffee.us/events feed (all at 662 Canton Rd).
 */

const ARTISAN_LOCATION = {
  addressTitle: 'Artisan Coffee',
  addressLine1: '662 Canton Rd',
  addressLine2: 'Akron, OH, 44312',
  markerLat:    41.0427,
  markerLng:    -81.4453,
}

export const LIVE_MUSIC = {
  id:        '59a5d32c4c0dbf3c03f71f6a',
  title:     'Live Music, Ed Amann',
  startDate: Date.parse('2026-06-13T22:00:00.000Z'), // 6:00 PM EDT
  endDate:   Date.parse('2026-06-13T23:30:00.000Z'), // 7:30 PM EDT
  body:      '<p>Ed started playing guitar in 1963. He toured with The Elmore Brothers Band &amp; played around Akron.</p>',
  excerpt:   'An evening of acoustic music.',
  assetUrl:  'http://static1.squarespace.com/static/53a3a5b7e4b03c23b7dbee94/t/ed-amann.jpg',
  fullUrl:   '/events/2025/8/29/live-music-ed-amann-2tblw-xawx3-bs6jy',
  location:  ARTISAN_LOCATION,
  starred:   false,
}

export const OPEN_MIC = {
  id:        '5b21open0mic0night000001',
  title:     'Open Mic Night',
  startDate: Date.parse('2026-06-19T22:30:00.000Z'), // 6:30 PM EDT
  endDate:   Date.parse('2026-06-20T00:30:00.000Z'), // 8:30 PM EDT
  body:      '<p>Artist sign up starts at 6:00 pm.</p>',
  assetUrl:  null,
  fullUrl:   '/events/2025/11/21/open-mic-night-ejfml-fyf6y-7r7gf-x5b9x',
  location:  ARTISAN_LOCATION,
  starred:   false,
}

export const AUTHOR_TALK = {
  id:        '6a27meet0the0author00001',
  title:     'Meet the Author: Vella Karman',
  startDate: Date.parse('2026-06-27T22:00:00.000Z'),
  endDate:   Date.parse('2026-06-27T23:30:00.000Z'),
  body:      '<p>Her debut novel, Beyond the Mirage, releases from The Pearl in May 2026.</p>',
  assetUrl:  'http://static1.squarespace.com/static/53a3a5b7e4b03c23b7dbee94/t/vella.jpg',
  fullUrl:   '/events/2026/6/27/meet-the-author-vella-karman',
  location:  ARTISAN_LOCATION,
  starred:   true,
}

// Edge case: a feed item with no startDate (should be skipped by the scraper).
export const NO_START_DATE = {
  id:       'no0start0date0000000001',
  title:    'Live Music, TBA',
  startDate: null,
  body:     '<p>Date to be announced.</p>',
  fullUrl:  '/events/tba',
  location: ARTISAN_LOCATION,
}

// Edge case: location omitted on the item (scraper falls back to the shop).
export const NO_LOCATION = {
  id:        'no0location000000000001',
  title:     'Poetry Reading',
  startDate: Date.parse('2026-07-02T23:00:00.000Z'),
  endDate:   Date.parse('2026-07-03T00:00:00.000Z'),
  body:      '<p>An open evening of poetry.</p>',
  fullUrl:   '/events/poetry-reading',
  location:  null,
}

export const ALL_FIXTURES = [LIVE_MUSIC, OPEN_MIC, AUTHOR_TALK, NO_START_DATE, NO_LOCATION]
