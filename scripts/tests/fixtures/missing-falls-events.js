/**
 * Fixture data for Missing Falls Brewery scraper tests.
 *
 * Each fixture represents a distinct permutation of the Tribe Events Calendar
 * API response structure. Named to describe what edge case they exercise.
 */

// ── 1. Complete event with all fields populated ──────────────────────────────
export const COMPLETE_EVENT = {
  id: 2001,
  title: 'Live Music: The Locals',
  description: '<p>Local indie band performing in our taproom. <strong>No cover charge</strong>.</p>',
  url: 'https://missingfallsbrewery.com/events/live-music',
  website: 'https://missingfallsbrewery.com/events/live-music',
  utc_start_date: '2026-05-23 19:00:00',
  utc_end_date: '2026-05-23 21:00:00',
  categories: [
    { id: 1, name: 'Live Music', slug: 'live-music' }
  ],
  tags: [
    { id: 20, name: 'Brewery', slug: 'brewery' },
    { id: 21, name: 'Music', slug: 'music' }
  ],
  cost: 'Free',
  cost_details: { values: [] },
  image: {
    id: 601,
    url: 'https://example.com/images/live-music.jpg',
    alt: 'Live Music Night',
  },
  featured: false,
}

// ── 2. Event with paid entry ────────────────────────────────────────────────
export const TASTING_EVENT = {
  id: 2002,
  title: 'Beer Tasting Flight',
  description: '<p>Guided tasting of our seasonal selections.</p>',
  url: null,
  website: 'https://missingfallsbrewery.com/tasting',
  utc_start_date: '2026-06-14 15:00:00',
  utc_end_date: '2026-06-14 16:30:00',
  categories: [
    { name: 'Food & Drink', slug: 'food-drink' },
    { name: 'Tasting', slug: 'tasting' }
  ],
  tags: [
    { name: 'Beer', slug: 'beer' },
    { name: 'Tasting', slug: 'tasting' }
  ],
  cost: '$15',
  cost_details: {
    values: ['15']
  },
  image: {
    url: 'https://example.com/images/beer-tasting.jpg'
  },
  featured: false,
}

// ── 3. Event with trivia (community) ─────────────────────────────────────────
export const TRIVIA_EVENT = {
  id: 2003,
  title: 'Brewery Trivia Night',
  description: '<p>Test your brewery and beer knowledge!</p>',
  url: 'https://missingfallsbrewery.com/trivia',
  website: null,
  utc_start_date: '2026-05-29 19:30:00',
  utc_end_date: '2026-05-29 21:00:00',
  categories: [
    { slug: 'games' }
  ],
  tags: [
    { name: 'Trivia', slug: 'trivia' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 4. Event with art category ──────────────────────────────────────────────
export const ART_EVENT = {
  id: 2004,
  title: 'Local Artist Showcase',
  description: '<p>Art display and opening reception.</p>',
  url: null,
  website: 'https://example.com/art',
  utc_start_date: '2026-07-12 17:00:00',
  utc_end_date: '2026-07-12 20:00:00',
  categories: [
    { slug: 'art' }
  ],
  tags: [
    { name: 'Art', slug: 'art' },
    { name: 'Showcase', slug: 'showcase' }
  ],
  cost: 'Free',
  cost_details: {},
  image: {
    url: 'https://example.com/art-showcase.jpg'
  },
  featured: false,
}

// ── 5. Event with sports category ───────────────────────────────────────────
export const SPORTS_EVENT = {
  id: 2005,
  title: 'Watch Party: Championship Game',
  description: '<p>Big game on our screens. Specials on beer!</p>',
  url: null,
  website: null,
  utc_start_date: '2026-06-02 18:00:00',
  utc_end_date: '2026-06-02 21:00:00',
  categories: [
    { slug: 'sports' }
  ],
  tags: [],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 6. Event with food pairing ──────────────────────────────────────────────
export const FOOD_PAIRING_EVENT = {
  id: 2006,
  title: 'Beer & Food Pairing Dinner',
  description: '<p>Five-course dinner paired with our craft beers.</p>',
  url: 'https://missingfallsbrewery.com/pairing',
  website: null,
  utc_start_date: '2026-08-16 18:00:00',
  utc_end_date: '2026-08-16 21:00:00',
  categories: [
    { name: 'Food & Drink', slug: 'food-pairing' }
  ],
  tags: [
    { name: 'Food', slug: 'food' },
    { name: 'Pairing', slug: 'pairing' }
  ],
  cost: '$65 - $85',
  cost_details: {
    values: ['65', '85']
  },
  image: {
    url: 'https://example.com/pairing-dinner.jpg'
  },
  featured: false,
}

// ── 7. Event with missing start date (should skip) ───────────────────────────
export const MISSING_START_DATE = {
  id: 2007,
  title: 'Upcoming Event TBD',
  description: 'Date to be confirmed.',
  url: null,
  website: null,
  utc_start_date: null,
  utc_end_date: null,
  categories: [],
  tags: [],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 8. Event with HTML entities in title ────────────────────────────────────
export const HTML_ENTITY_TITLE = {
  id: 2008,
  title: 'DJ Night &amp; Dancing &#8212; The Vibes',
  description: '<p>High energy DJ night with a dance floor.</p>',
  url: 'https://example.com/dj',
  website: null,
  utc_start_date: '2026-06-21 21:00:00',
  utc_end_date: '2026-06-22 01:00:00',
  categories: [
    { slug: 'music' }
  ],
  tags: [
    { name: 'DJ', slug: 'dj' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 9. Event with image in description (fallback) ──────────────────────────
export const IMAGE_IN_DESCRIPTION = {
  id: 2009,
  title: 'Community Cleanup',
  description: '<p>Help us beautify the brewery area.</p><img src="https://example.com/cleanup.jpg" alt="cleanup">',
  url: null,
  website: 'https://example.com/cleanup',
  utc_start_date: '2026-04-22 10:00:00',
  utc_end_date: '2026-04-22 12:00:00',
  categories: [
    { slug: 'community' }
  ],
  tags: [],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 10. Event with featured flag ────────────────────────────────────────────
export const FEATURED_EVENT = {
  id: 2010,
  title: 'Grand Opening: New Taproom',
  description: '<p>Celebrating our new location!</p>',
  url: 'https://missingfallsbrewery.com/grand-opening',
  website: null,
  utc_start_date: '2026-05-10 17:00:00',
  utc_end_date: '2026-05-10 22:00:00',
  categories: [
    { slug: 'event' }
  ],
  tags: [
    { name: 'Grand Opening', slug: 'grand-opening' }
  ],
  cost: 'Free',
  cost_details: {},
  image: {
    url: 'https://example.com/grand-opening.jpg'
  },
  featured: true,
}

// ── 11. Event with bingo category ──────────────────────────────────────────
export const BINGO_EVENT = {
  id: 2011,
  title: 'Bingo Night & Beer',
  description: '<p>Play bingo with craft beer prizes!</p>',
  url: null,
  website: 'https://example.com/bingo',
  utc_start_date: '2026-07-30 19:00:00',
  utc_end_date: '2026-07-30 21:00:00',
  categories: [
    { slug: 'games' },
    { slug: 'bingo' }
  ],
  tags: [
    { name: 'Bingo', slug: 'bingo' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 12. Event with comedy show ──────────────────────────────────────────────
export const COMEDY_EVENT = {
  id: 2012,
  title: 'Comedy Night',
  description: '<p>Local comedians performing live.</p>',
  url: 'https://example.com/comedy',
  website: null,
  utc_start_date: '2026-08-28 20:00:00',
  utc_end_date: '2026-08-28 22:00:00',
  categories: [
    { slug: 'comedy' },
    { slug: 'show' }
  ],
  tags: [
    { name: 'Comedy', slug: 'comedy' }
  ],
  cost: '$12',
  cost_details: {
    values: ['12']
  },
  image: {
    url: 'https://example.com/comedy-night.jpg'
  },
  featured: false,
}

export const ALL_FIXTURES = [
  COMPLETE_EVENT,
  TASTING_EVENT,
  TRIVIA_EVENT,
  ART_EVENT,
  SPORTS_EVENT,
  FOOD_PAIRING_EVENT,
  MISSING_START_DATE,
  HTML_ENTITY_TITLE,
  IMAGE_IN_DESCRIPTION,
  FEATURED_EVENT,
  BINGO_EVENT,
  COMEDY_EVENT,
]
