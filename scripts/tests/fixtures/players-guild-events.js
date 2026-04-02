/**
 * Fixture data for Players Guild Theatre scraper tests.
 *
 * Each fixture represents a distinct permutation of the Tribe Events Calendar
 * API response structure. Named to describe what edge case they exercise.
 */

// ── 1. Complete event with all fields populated ──────────────────────────────
export const COMPLETE_EVENT = {
  id: 4001,
  title: 'A Midsummer Night\'s Dream',
  description: '<p>Shakespeare\'s beloved comedy of love and magic. <strong>Four-week run.</strong></p>',
  url: 'https://playersguildtheatre.com/midsummer',
  website: 'https://playersguildtheatre.com/midsummer',
  utc_start_date: '2026-06-05 19:30:00',
  utc_end_date: '2026-06-05 21:45:00',
  categories: [
    { id: 1, name: 'Theatre', slug: 'theatre' }
  ],
  tags: [
    { id: 40, name: 'Shakespeare', slug: 'shakespeare' },
    { id: 41, name: 'Comedy', slug: 'comedy' }
  ],
  cost: '$18',
  cost_details: { values: ['18'] },
  image: {
    id: 801,
    url: 'https://example.com/images/midsummer.jpg',
    alt: 'A Midsummer Night\'s Dream Poster',
  },
  featured: false,
}

// ── 2. Event with matinee performance ───────────────────────────────────────
export const MATINEE_EVENT = {
  id: 4002,
  title: 'The Phantom of the Opera',
  description: '<p>The classic musical sensation. <em>Matinee performance.</em></p>',
  url: null,
  website: 'https://playersguildtheatre.com/phantom',
  utc_start_date: '2026-07-12 14:00:00',
  utc_end_date: '2026-07-12 16:30:00',
  categories: [
    { name: 'Musical', slug: 'musical' }
  ],
  tags: [
    { name: 'Musical Theatre', slug: 'musical-theatre' },
    { name: 'Matinee', slug: 'matinee' }
  ],
  cost: '$15 - $20',
  cost_details: {
    values: ['15', '20']
  },
  image: {
    url: 'https://example.com/images/phantom.jpg'
  },
  featured: false,
}

// ── 3. Event with student/young ticket prices ───────────────────────────────
export const STUDENT_PRICING_EVENT = {
  id: 4003,
  title: 'Romeo and Juliet',
  description: '<p>Classic tragedy. Student discounts available.</p>',
  url: 'https://playersguildtheatre.com/romeo-juliet',
  website: null,
  utc_start_date: '2026-08-21 19:00:00',
  utc_end_date: '2026-08-21 21:30:00',
  categories: [
    { slug: 'theatre' }
  ],
  tags: [
    { name: 'Shakespeare', slug: 'shakespeare' },
    { name: 'Drama', slug: 'drama' }
  ],
  cost: '$12 - $18',
  cost_details: {
    values: ['12', '18']
  },
  image: null,
  featured: false,
}

// ── 4. Event with contemporary play ─────────────────────────────────────────
export const CONTEMPORARY_PLAY = {
  id: 4004,
  title: 'August: Osage County',
  description: '<p>A powerful modern family drama set in Oklahoma.</p>',
  url: null,
  website: 'https://example.com/august',
  utc_start_date: '2026-09-10 19:30:00',
  utc_end_date: '2026-09-10 22:00:00',
  categories: [
    { slug: 'theatre' },
    { slug: 'drama' }
  ],
  tags: [
    { name: 'Contemporary', slug: 'contemporary' },
    { name: 'Drama', slug: 'drama' }
  ],
  cost: '$20',
  cost_details: {
    values: ['20']
  },
  image: {
    url: 'https://example.com/august-osage.jpg'
  },
  featured: false,
}

// ── 5. Event with children's theatre ────────────────────────────────────────
export const CHILDRENS_SHOW = {
  id: 4005,
  title: 'The Lion King',
  description: '<p>Family-friendly theatrical spectacle!</p>',
  url: 'https://playersguildtheatre.com/lion-king',
  website: null,
  utc_start_date: '2026-05-16 14:00:00',
  utc_end_date: '2026-05-16 15:45:00',
  categories: [
    { slug: 'children\'s-theatre' }
  ],
  tags: [
    { name: 'Family', slug: 'family' },
    { name: 'Children', slug: 'children' }
  ],
  cost: '$12',
  cost_details: {
    values: ['12']
  },
  image: null,
  featured: false,
}

// ── 6. Event with missing start date (should skip) ───────────────────────────
export const MISSING_START_DATE = {
  id: 4006,
  title: 'TBD Upcoming Production',
  description: 'To be announced.',
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

// ── 7. Event with HTML in description ───────────────────────────────────────
export const RICH_HTML_DESCRIPTION = {
  id: 4007,
  title: 'Carousel',
  description: '<h2>The Classic Musical</h2><p><strong>Rodgers and Hammerstein\'s</strong> masterpiece. Features unforgettable music and dance numbers. <em>A must-see production.</em></p><ul><li>Beautiful choreography</li><li>Timeless songs</li></ul>',
  url: 'https://playersguildtheatre.com/carousel',
  website: null,
  utc_start_date: '2026-10-09 19:30:00',
  utc_end_date: '2026-10-09 21:45:00',
  categories: [
    { slug: 'musical' }
  ],
  tags: [
    { name: 'Musical', slug: 'musical' }
  ],
  cost: '$18 - $22',
  cost_details: {
    values: ['18', '22']
  },
  image: {
    url: 'https://example.com/carousel.jpg'
  },
  featured: false,
}

// ── 8. Event with no categories/tags ────────────────────────────────────────
export const MINIMAL_EVENT = {
  id: 4008,
  title: 'Opening Night Gala',
  description: 'Season opening celebration.',
  url: null,
  website: null,
  utc_start_date: '2026-05-01 18:00:00',
  utc_end_date: '2026-05-01 20:00:00',
  categories: [],
  tags: [],
  cost: '$25',
  cost_details: {
    values: ['25']
  },
  image: null,
  featured: false,
}

// ── 9. Event with featured flag ─────────────────────────────────────────────
export const FEATURED_EVENT = {
  id: 4009,
  title: 'The Crucible',
  description: '<p>Arthur Miller\'s gripping drama about the Salem witch trials. <strong>Limited run!</strong></p>',
  url: 'https://playersguildtheatre.com/crucible',
  website: null,
  utc_start_date: '2026-11-13 19:30:00',
  utc_end_date: '2026-11-13 21:45:00',
  categories: [
    { slug: 'drama' }
  ],
  tags: [
    { name: 'Drama', slug: 'drama' },
    { name: 'American Classics', slug: 'american-classics' }
  ],
  cost: '$18',
  cost_details: {
    values: ['18']
  },
  image: {
    url: 'https://example.com/crucible.jpg'
  },
  featured: true,
}

// ── 10. Event with long run (multiple dates in description) ──────────────────
export const LONG_RUN_EVENT = {
  id: 4010,
  title: 'Hamilton: An American Musical',
  description: '<p>The revolutionary hip-hop musical. <strong>Eight-week engagement.</strong> Experience the phenomenon.</p>',
  url: 'https://playersguildtheatre.com/hamilton',
  website: null,
  utc_start_date: '2026-12-04 19:30:00',
  utc_end_date: '2026-12-04 22:00:00',
  categories: [
    { slug: 'musical' }
  ],
  tags: [
    { name: 'Musical', slug: 'musical' },
    { name: 'Hip-Hop', slug: 'hip-hop' }
  ],
  cost: '$25 - $35',
  cost_details: {
    values: ['25', '35']
  },
  image: {
    url: 'https://example.com/hamilton.jpg'
  },
  featured: true,
}

// ── 11. Event with no image ─────────────────────────────────────────────────
export const NO_IMAGE_EVENT = {
  id: 4011,
  title: 'The Importance of Being Earnest',
  description: '<p>Wilde\'s brilliant comedy of errors and wit.</p>',
  url: null,
  website: 'https://example.com/earnest',
  utc_start_date: '2026-09-25 19:00:00',
  utc_end_date: '2026-09-25 21:00:00',
  categories: [
    { slug: 'comedy' }
  ],
  tags: [
    { name: 'Classic Comedy', slug: 'classic-comedy' }
  ],
  cost: '$15',
  cost_details: {
    values: ['15']
  },
  image: null,
  featured: false,
}

// ── 12. Event with HTML entities in title ───────────────────────────────────
export const HTML_ENTITY_TITLE = {
  id: 4012,
  title: 'Sweeney Todd &mdash; The Demon Barber of Fleet Street',
  description: '<p>Sondheim\'s dark masterpiece.</p>',
  url: 'https://playersguildtheatre.com/sweeney-todd',
  website: null,
  utc_start_date: '2026-07-31 19:30:00',
  utc_end_time: '2026-07-31 21:45:00',
  categories: [
    { slug: 'musical' }
  ],
  tags: [
    { name: 'Musical', slug: 'musical' },
    { name: 'Thriller', slug: 'thriller' }
  ],
  cost: '$20',
  cost_details: {
    values: ['20']
  },
  image: {
    url: 'https://example.com/sweeney-todd.jpg'
  },
  featured: false,
}

export const ALL_FIXTURES = [
  COMPLETE_EVENT,
  MATINEE_EVENT,
  STUDENT_PRICING_EVENT,
  CONTEMPORARY_PLAY,
  CHILDRENS_SHOW,
  MISSING_START_DATE,
  RICH_HTML_DESCRIPTION,
  MINIMAL_EVENT,
  FEATURED_EVENT,
  LONG_RUN_EVENT,
  NO_IMAGE_EVENT,
  HTML_ENTITY_TITLE,
]
