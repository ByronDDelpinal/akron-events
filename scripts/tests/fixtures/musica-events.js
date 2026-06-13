/**
 * Fixtures for the Musica scraper tests.
 *
 * Shape mirrors real Squarespace Events collection items (?format=json):
 * epoch-ms startDate/endDate, HTML body, location object, fullUrl, assetUrl.
 */

const MUSICA_LOCATION = {
  addressTitle: 'Musica',
  addressLine1: '51 E Market St',
  addressLine2: 'Akron, OH, 44308',
  markerLat:    41.0840,
  markerLng:    -81.5168,
}

// The real Mac Saturn show — authoritative 7:00 PM start straight from the venue
// (vs. the CVB feed's fabricated 9:00 AM placeholder).
export const MAC_SATURN = {
  id:        '69deec5f2423950001a6212b',
  title:     'Mac Saturn w/ The Sweet Spot',
  startDate: Date.parse('2026-06-13T23:00:00.000Z'), // 7:00 PM EDT
  endDate:   Date.parse('2026-06-14T03:00:00.000Z'), // ~11:00 PM EDT
  body:      '<p>The pride of Detroit, Mac Saturn, live at Musica.</p>',
  assetUrl:  'http://static1.squarespace.com/static/5c6c98389b7d153fdee44225/t/mac-saturn.jpg',
  fullUrl:   '/upcoming-events-/2026/6/13/mac-saturn',
  location:  MUSICA_LOCATION,
  starred:   false,
}

export const COMEDY_NIGHT = {
  id:        '6a10comedy0night00000001',
  title:     'Comedy Night at Musica',
  startDate: Date.parse('2026-06-20T00:00:00.000Z'), // 8:00 PM EDT (Jun 19)
  endDate:   Date.parse('2026-06-20T02:00:00.000Z'),
  body:      '<p>Stand-up comedy showcase.</p>',
  fullUrl:   '/upcoming-events-/2026/6/19/comedy-night',
  location:  MUSICA_LOCATION,
  starred:   false,
}

export const NO_START_DATE = {
  id:        'no0start0date0000000001',
  title:     'TBA Show',
  startDate: null,
  body:      '<p>Date to be announced.</p>',
  fullUrl:   '/upcoming-events-/tba',
  location:  MUSICA_LOCATION,
}

export const NO_LOCATION = {
  id:        'no0location000000000001',
  title:     'Local Showcase',
  startDate: Date.parse('2026-07-02T23:30:00.000Z'),
  body:      '<p>A night of local bands.</p>',
  fullUrl:   '/upcoming-events-/2026/7/2/local-showcase',
  location:  null,
}

export const ALL_FIXTURES = [MAC_SATURN, COMEDY_NIGHT, NO_START_DATE, NO_LOCATION]
