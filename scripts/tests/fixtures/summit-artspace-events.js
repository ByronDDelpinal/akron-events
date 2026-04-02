/**
 * Fixture data for Summit Artspace scraper tests.
 *
 * Each fixture represents a distinct permutation of the Tribe Events Calendar
 * API response structure. Named to describe what edge case they exercise.
 */

// ── 1. Complete event with all fields populated ──────────────────────────────
export const COMPLETE_EVENT = {
  id: 5001,
  title: 'Contemporary Art Exhibition Opening',
  description: '<p>Celebrating new works by emerging <strong>local artists</strong>. Reception with refreshments.</p>',
  url: 'https://www.summitartspace.org/events/art-opening',
  website: 'https://www.summitartspace.org/events/art-opening',
  utc_start_date: '2026-05-22 17:00:00',
  utc_end_date: '2026-05-22 20:00:00',
  categories: [
    { id: 1, name: 'Exhibition', slug: 'exhibition' }
  ],
  tags: [
    { id: 50, name: 'Art', slug: 'art' },
    { id: 51, name: 'Opening Reception', slug: 'opening-reception' }
  ],
  cost: 'Free',
  cost_details: { values: [] },
  image: {
    id: 901,
    url: 'https://example.com/images/art-exhibition.jpg',
    alt: 'Contemporary Art Exhibition',
  },
  featured: false,
}

// ── 2. Event with music/concert category ────────────────────────────────────
export const MUSIC_EVENT = {
  id: 5002,
  title: 'Live Music Performance: Akron Symphony',
  description: '<p>Classical music in an intimate gallery setting.</p>',
  url: null,
  website: 'https://www.summitartspace.org/symphony',
  utc_start_date: '2026-06-19 19:00:00',
  utc_end_date: '2026-06-19 20:30:00',
  categories: [
    { name: 'Music', slug: 'music' },
    { name: 'Performance', slug: 'performance' }
  ],
  tags: [
    { name: 'Classical', slug: 'classical' }
  ],
  cost: '$15 - $25',
  cost_details: {
    values: ['15', '25']
  },
  image: {
    url: 'https://example.com/images/symphony.jpg'
  },
  featured: false,
}

// ── 3. Event with food/market category ──────────────────────────────────────
export const FOOD_MARKET_EVENT = {
  id: 5003,
  title: 'Artisan Food & Craft Market',
  description: '<p>Local vendors selling handmade goods and artisan foods.</p>',
  url: 'https://www.summitartspace.org/market',
  website: null,
  utc_start_date: '2026-07-18 10:00:00',
  utc_end_date: '2026-07-18 16:00:00',
  categories: [
    { slug: 'market' },
    { slug: 'food' }
  ],
  tags: [
    { name: 'Market', slug: 'market' },
    { name: 'Artisan', slug: 'artisan' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 4. Event with sports/fitness category ───────────────────────────────────
export const FITNESS_EVENT = {
  id: 5004,
  title: 'Yoga in the Gallery',
  description: '<p>Mindful yoga practice surrounded by art.</p>',
  url: null,
  website: 'https://example.com/yoga',
  utc_start_date: '2026-08-06 09:30:00',
  utc_end_date: '2026-08-06 10:45:00',
  categories: [
    { slug: 'fitness' },
    { slug: 'wellness' }
  ],
  tags: [
    { name: 'Yoga', slug: 'yoga' }
  ],
  cost: '$12',
  cost_details: {
    values: ['12']
  },
  image: {
    url: 'https://example.com/yoga-gallery.jpg'
  },
  featured: false,
}

// ── 5. Event with education/workshop category ───────────────────────────────
export const WORKSHOP_EVENT = {
  id: 5005,
  title: 'Painting Techniques Workshop',
  description: '<p>Learn contemporary painting methods from a professional artist.</p>',
  url: 'https://www.summitartspace.org/workshop',
  website: null,
  utc_start_date: '2026-06-07 13:00:00',
  utc_end_date: '2026-06-07 16:00:00',
  categories: [
    { slug: 'education' },
    { slug: 'workshop' }
  ],
  tags: [
    { name: 'Painting', slug: 'painting' },
    { name: 'Class', slug: 'class' }
  ],
  cost: '$35 - $45',
  cost_details: {
    values: ['35', '45']
  },
  image: null,
  featured: false,
}

// ── 6. Event with nonprofit/fundraiser category ─────────────────────────────
export const FUNDRAISER_EVENT = {
  id: 5006,
  title: 'Gala Benefit Dinner for the Arts',
  description: '<p>An elegant evening supporting arts education in Akron.</p>',
  url: 'https://example.com/gala',
  website: null,
  utc_start_date: '2026-09-12 18:00:00',
  utc_end_date: '2026-09-12 21:00:00',
  categories: [
    { slug: 'benefit' },
    { slug: 'fundraiser' }
  ],
  tags: [
    { name: 'Fundraiser', slug: 'fundraiser' }
  ],
  cost: '$150',
  cost_details: {
    values: ['150']
  },
  image: {
    url: 'https://example.com/gala.jpg'
  },
  featured: true,
}

// ── 7. Event with community/family category ─────────────────────────────────
export const FAMILY_EVENT = {
  id: 5007,
  title: 'Family Art Day',
  description: '<p>Create art with your family in our interactive space.</p>',
  url: 'https://www.summitartspace.org/family',
  website: null,
  utc_start_date: '2026-05-30 11:00:00',
  utc_end_date: '2026-05-30 14:00:00',
  categories: [
    { slug: 'family' }
  ],
  tags: [
    { name: 'Kids', slug: 'kids' }
  ],
  cost: '$8 per child',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 8. Event with missing start date (should skip) ───────────────────────────
export const MISSING_START_DATE = {
  id: 5008,
  title: 'Upcoming Event Details TBD',
  description: 'Date to be announced.',
  url: null,
  website: null,
  utc_start_date: null,
  utc_end_date: null,
  categories: [],
  tags: [],
  cost: 'TBD',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 9. Event with no description ────────────────────────────────────────────
export const NO_DESCRIPTION_EVENT = {
  id: 5009,
  title: 'Gallery Walk & Networking',
  description: null,
  url: 'https://example.com/walk',
  website: null,
  utc_start_date: '2026-05-15 18:00:00',
  utc_end_date: '2026-05-15 19:30:00',
  categories: [
    { slug: 'networking' }
  ],
  tags: [
    { name: 'Networking', slug: 'networking' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 10. Event defaulting to art category (no specific match) ──────────────────
export const DEFAULT_ART_EVENT = {
  id: 5010,
  title: 'Special Presentation: Film & Discussion',
  description: '<p>Documentary screening followed by artist talk.</p>',
  url: null,
  website: 'https://example.com/film-discussion',
  utc_start_date: '2026-07-24 19:00:00',
  utc_end_date: '2026-07-24 21:00:00',
  categories: [
    { slug: 'screening' }
  ],
  tags: [
    { name: 'Film', slug: 'film' }
  ],
  cost: 'Free',
  cost_details: {},
  image: {
    url: 'https://example.com/screening.jpg'
  },
  featured: false,
}

// ── 11. Event with featured flag ────────────────────────────────────────────
export const FEATURED_EVENT = {
  id: 5011,
  title: 'Season Opening: Celebrating Creative Voices',
  description: '<p>Summit Artspace proudly presents our most ambitious season yet.</p>',
  url: 'https://www.summitartspace.org/season-opening',
  website: null,
  utc_start_date: '2026-09-01 17:00:00',
  utc_end_date: '2026-09-01 19:00:00',
  categories: [
    { slug: 'opening' }
  ],
  tags: [
    { name: 'Opening', slug: 'opening' }
  ],
  cost: 'Free',
  cost_details: {},
  image: {
    url: 'https://example.com/season-opening.jpg'
  },
  featured: true,
}

// ── 12. Event with image fallback from description ──────────────────────────
export const IMAGE_IN_DESCRIPTION = {
  id: 5012,
  title: 'Artist Talk Series',
  description: '<p>Meet and engage with featured artists in our gallery.</p><img src="https://example.com/artist-talk.jpg" alt="artist talk">',
  url: null,
  website: 'https://example.com/artist-talk',
  utc_start_date: '2026-06-26 18:00:00',
  utc_end_date: '2026-06-26 19:30:00',
  categories: [
    { slug: 'talk' }
  ],
  tags: [
    { name: 'Artist Talk', slug: 'artist-talk' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

export const ALL_FIXTURES = [
  COMPLETE_EVENT,
  MUSIC_EVENT,
  FOOD_MARKET_EVENT,
  FITNESS_EVENT,
  WORKSHOP_EVENT,
  FUNDRAISER_EVENT,
  FAMILY_EVENT,
  MISSING_START_DATE,
  NO_DESCRIPTION_EVENT,
  DEFAULT_ART_EVENT,
  FEATURED_EVENT,
  IMAGE_IN_DESCRIPTION,
]
