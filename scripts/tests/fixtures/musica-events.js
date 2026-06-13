/**
 * Fixtures for the Musica (DICE) scraper tests.
 *
 * Shape mirrors the real DICE partner API (partners-endpoint.dice.fm/api/v2/events)
 * event objects, verified live: top-level `date`/`date_end`, `event_images`
 * ({landscape,portrait,square,brand}), `description`/`raw_description`,
 * `age_limit`, `genre_tags` (["gig:indierock", …]), `venues[]`.
 */

const MUSICA_VENUE = [{ id: 11682, name: 'Musica', city: { name: 'Akron' } }]

export const MAC_SATURN = {
  id:           'm75971a5058a',
  name:         'Mac Saturn w/ The Sweet Spot',
  type:         'linkout',
  status:       'on-sale',
  date:         '2026-06-14T00:00:00Z',   // 8:00 PM EDT
  date_end:     '2026-06-14T04:00:00Z',
  venues:       MUSICA_VENUE,
  description:  '<p>The pride of Detroit, Mac Saturn, live at Musica.</p>',
  event_images: {
    brand:     null,
    landscape: 'https://dice-media.imgix.net/attachments/mac-saturn-landscape.jpg',
    portrait:  'https://dice-media.imgix.net/attachments/mac-saturn-portrait.jpg',
    square:    'https://dice-media.imgix.net/attachments/mac-saturn-square.jpg',
  },
  images:       { 0: 'https://dice-media.imgix.net/attachments/mac-saturn-0.jpg' },
  age_limit:    'All ages',
  currency:     'USD',
  price:        null,
  genre_tags:   ['gig:indierock', 'gig:rocknroll'],
  url:          'https://link.dice.fm/m75971a5058a',
}

export const COMEDY_NIGHT = {
  id:          'cmdy001',
  name:        'Comedy Night Stand-Up Showcase',
  status:      'on-sale',
  date:        '2026-06-20T20:00:00-04:00',
  venues:      MUSICA_VENUE,
  description: '',
  raw_description: 'A night of stand-up comedy.',
  age_limit:   '18+',
  event_images: { landscape: 'https://dice-media.imgix.net/attachments/comedy.jpg' },
  url:         'https://link.dice.fm/comedy',
}

// Naive (offset-less) timestamp — must be treated as Eastern wall-clock, NOT UTC.
export const NAIVE_TIME = {
  id:          'naive001',
  name:        'Local Bands Showcase',
  status:      'on-sale',
  date:        '2026-06-25 19:30:00',
  venues:      MUSICA_VENUE,
  description: 'Local bands.',
  url:         'https://link.dice.fm/local-bands',
}

export const CANCELLED = {
  id:     'cancel001',
  name:   'Cancelled Show',
  status: 'cancelled',
  date:   '2026-07-01T23:00:00Z',
  venues: MUSICA_VENUE,
  url:    'https://link.dice.fm/cancelled',
}

export const NO_DATE = {
  id:     'nodate001',
  name:   'TBA',
  status: 'announced',
  date:   null,
  venues: MUSICA_VENUE,
  url:    'https://link.dice.fm/tba',
}

export const ALL_FIXTURES = [MAC_SATURN, COMEDY_NIGHT, NAIVE_TIME, CANCELLED, NO_DATE]
