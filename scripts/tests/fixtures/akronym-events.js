/**
 * Fixture data for Akronym Brewing scraper tests.
 * WordPress REST API with meta field date parsing.
 */

export const COMPLETE_POST = {
  id: 1,
  title: { rendered: 'Live Music Friday Night' },
  content: { rendered: '<p>Join us for great live music</p>' },
  date: '2026-05-15T20:00:00',
  meta: {
    '_event_start_date': '2026-05-15',
    '_event_start_time': '8:00 pm',
    '_event_end_date': '2026-05-15',
    '_event_end_time': '11:00 pm',
  },
  _embedded: {
    'wp:term': [[{ name: 'Music', slug: 'music' }], [{ name: 'Live Music' }]],
    'wp:featuredmedia': [{ source_url: 'https://akronymbrewing.com/img/music.jpg' }],
  },
  link: 'https://akronymbrewing.com/event/live-music',
}

export const META_DATE_FALLBACKS = {
  id: 2,
  title: { rendered: 'Trivia Night' },
  content: { rendered: '<p>Weekly trivia</p>' },
  date: '2026-06-10T19:00:00',
  meta: {
    'event_start_date': '2026-06-10', // Different key
    'event_start_time': '7:00 pm',
  },
  _embedded: {
    'wp:term': [[{ name: 'Trivia', slug: 'trivia' }], []],
    'wp:featuredmedia': [],
  },
}

export const NO_END_TIME = {
  id: 3,
  title: { rendered: 'Comedy Show' },
  content: { rendered: '<p>Local comedy</p>' },
  date: '2026-07-20T20:00:00',
  meta: {
    '_event_start_date': '2026-07-20',
    '_event_start_time': '8:00 pm',
  },
  _embedded: {
    'wp:term': [[{ name: 'Comedy', slug: 'comedy' }], []],
    'wp:featuredmedia': [{ source_url: 'https://akronymbrewing.com/img/comedy.jpg' }],
  },
}

export const NO_META_FIELDS = {
  id: 4,
  title: { rendered: 'Art Display' },
  content: { rendered: '<p>Local artist showcase</p>' },
  date: '2026-08-15T18:00:00',
  meta: {},
  _embedded: {
    'wp:term': [[{ name: 'Art', slug: 'art' }], []],
    'wp:featuredmedia': [{ source_url: 'https://akronymbrewing.com/img/art.jpg' }],
  },
}

export const FOOD_TASTING_EVENT = {
  id: 5,
  title: { rendered: 'Beer & Food Pairing' },
  content: { rendered: '<p>Brewery and food pairing event</p>' },
  date: '2026-09-05T19:00:00',
  meta: {
    '_event_start_date': '2026-09-05',
    '_event_start_time': '7:00 pm',
    '_event_end_date': '2026-09-05',
    '_event_end_time': '10:00 pm',
  },
  _embedded: {
    'wp:term': [[{ name: 'Food', slug: 'food' }, { name: 'Tasting', slug: 'tasting' }], []],
    'wp:featuredmedia': [{ source_url: 'https://akronymbrewing.com/img/pairing.jpg' }],
  },
}

export const HTML_ENTITIES = {
  id: 6,
  title: { rendered: 'The &quot;Hoppy&quot; Experience &amp; Tasting' },
  content: { rendered: '<p>Special hoppy IPA tasting &amp; food</p>' },
  date: '2026-10-10T19:00:00',
  meta: {
    '_event_start_date': '2026-10-10',
    '_event_start_time': '7:00 pm',
  },
  _embedded: {
    'wp:term': [[{ name: 'Beer', slug: 'beer' }], []],
    'wp:featuredmedia': [{ source_url: 'https://akronymbrewing.com/img/hoppy.jpg' }],
  },
}

export const NO_IMAGE = {
  id: 7,
  title: { rendered: 'Open House' },
  content: { rendered: '<p>Brewery open house</p>' },
  date: '2026-11-01T18:00:00',
  meta: {
    '_event_start_date': '2026-11-01',
    '_event_start_time': '6:00 pm',
  },
  _embedded: {
    'wp:term': [[{ name: 'Community', slug: 'community' }], []],
    'wp:featuredmedia': [],
  },
}

export const MISSING_TITLE = {
  id: 8,
  title: { rendered: '' },
  content: { rendered: '<p>No title provided</p>' },
  date: '2026-12-05T19:00:00',
  meta: {
    '_event_start_date': '2026-12-05',
    '_event_start_time': '7:00 pm',
  },
  _embedded: {
    'wp:term': [[], []],
    'wp:featuredmedia': [],
  },
}

export const NO_START_DATE_META = {
  id: 9,
  title: { rendered: 'Event TBD' },
  content: { rendered: '<p>Details pending</p>' },
  date: null, // No date anywhere
  meta: {}, // No date meta fields
  _embedded: {
    'wp:term': [[], []],
    'wp:featuredmedia': [],
  },
}

export const MULTIPLE_CATEGORIES = {
  id: 10,
  title: { rendered: 'Music & Art Fusion' },
  content: { rendered: '<p>Live music with art installation</p>' },
  date: '2026-11-20T20:00:00',
  meta: {
    '_event_start_date': '2026-11-20',
    '_event_start_time': '8:00 pm',
    '_event_end_date': '2026-11-20',
    '_event_end_time': '11:00 pm',
  },
  _embedded: {
    'wp:term': [[{ name: 'Music', slug: 'music' }, { name: 'Art', slug: 'art' }], [{ name: 'Local', slug: 'local' }]],
    'wp:featuredmedia': [{ source_url: 'https://akronymbrewing.com/img/fusion.jpg' }],
  },
}

export const ALL_FIXTURES = [
  COMPLETE_POST,
  META_DATE_FALLBACKS,
  NO_END_TIME,
  NO_META_FIELDS,
  FOOD_TASTING_EVENT,
  HTML_ENTITIES,
  NO_IMAGE,
  MISSING_TITLE,
  NO_START_DATE_META,
  MULTIPLE_CATEGORIES,
]
