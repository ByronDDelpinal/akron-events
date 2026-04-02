/**
 * Fixture data for Nightlight Cinema scraper tests.
 *
 * Each fixture represents a distinct permutation of the Tribe Events Calendar
 * API response structure. Named to describe what edge case they exercise.
 */

// ── 1. Complete event with all fields populated ──────────────────────────────
export const COMPLETE_EVENT = {
  id: 3001,
  title: 'Film Screening: Independent Documentary',
  description: '<p>A powerful <strong>indie documentary</strong> about local history. Followed by discussion.</p>',
  url: 'https://nightlightcinema.com/events/doc-screening',
  website: 'https://nightlightcinema.com/events/doc-screening',
  utc_start_date: '2026-05-17 19:00:00',
  utc_end_date: '2026-05-17 21:15:00',
  categories: [
    { id: 1, name: 'Film', slug: 'film' }
  ],
  tags: [
    { id: 30, name: 'Documentary', slug: 'documentary' },
    { id: 31, name: 'Cinema', slug: 'cinema' }
  ],
  cost: '$8',
  cost_details: { values: ['8'] },
  image: {
    id: 701,
    url: 'https://example.com/images/documentary.jpg',
    alt: 'Documentary Film Poster',
  },
  featured: false,
}

// ── 2. Event with music performance ─────────────────────────────────────────
export const MUSIC_EVENT = {
  id: 3002,
  title: 'Live Jazz Performance',
  description: '<p>Jazz trio performing a one-night-only show.</p>',
  url: null,
  website: 'https://nightlightcinema.com/jazz',
  utc_start_date: '2026-06-13 20:00:00',
  utc_end_date: '2026-06-13 21:30:00',
  categories: [
    { name: 'Music', slug: 'music' },
    { name: 'Concert', slug: 'concert' }
  ],
  tags: [
    { name: 'Jazz', slug: 'jazz' },
    { name: 'Live Performance', slug: 'live' }
  ],
  cost: '$12 - $15',
  cost_details: {
    values: ['12', '15']
  },
  image: {
    url: 'https://example.com/images/jazz-trio.jpg'
  },
  featured: false,
}

// ── 3. Event with food/drink category ───────────────────────────────────────
export const FOOD_EVENT = {
  id: 3003,
  title: 'Wine Tasting & Cheese',
  description: '<p>Curated wine selection paired with local cheeses.</p>',
  url: 'https://nightlightcinema.com/wine-tasting',
  website: null,
  utc_start_date: '2026-07-11 18:00:00',
  utc_end_date: '2026-07-11 19:30:00',
  categories: [
    { slug: 'food' },
    { slug: 'drink' }
  ],
  tags: [
    { name: 'Wine', slug: 'wine' },
    { name: 'Tasting', slug: 'tasting' }
  ],
  cost: '$25',
  cost_details: {
    values: ['25']
  },
  image: null,
  featured: false,
}

// ── 4. Event with education category ────────────────────────────────────────
export const EDUCATION_EVENT = {
  id: 3004,
  title: 'Filmmaking Workshop: Basics of Cinematography',
  description: '<p>Learn the fundamentals from a professional cinematographer.</p>',
  url: null,
  website: 'https://example.com/workshop',
  utc_start_date: '2026-08-02 14:00:00',
  utc_end_date: '2026-08-02 17:00:00',
  categories: [
    { slug: 'education' },
    { slug: 'workshop' }
  ],
  tags: [
    { name: 'Filmmaking', slug: 'filmmaking' },
    { name: 'Class', slug: 'class' }
  ],
  cost: '$40',
  cost_details: {
    values: ['40']
  },
  image: {
    url: 'https://example.com/cinematography-workshop.jpg'
  },
  featured: false,
}

// ── 5. Event with community/family category ─────────────────────────────────
export const FAMILY_EVENT = {
  id: 3005,
  title: 'Family Film Day: Animated Classics',
  description: '<p>Classic animation for the whole family!</p>',
  url: 'https://example.com/family',
  website: null,
  utc_start_date: '2026-06-28 14:00:00',
  utc_end_date: '2026-06-28 15:45:00',
  categories: [
    { slug: 'community' },
    { slug: 'family' }
  ],
  tags: [
    { name: 'Kids', slug: 'kids' },
    { name: 'Family', slug: 'family' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 6. Event with fundraiser/nonprofit tag ──────────────────────────────────
export const BENEFIT_EVENT = {
  id: 3006,
  title: 'Film Screening Benefit Gala',
  description: '<p>An elegant evening of cinema with proceeds supporting arts education.</p>',
  url: 'https://nightlightcinema.com/benefit',
  website: null,
  utc_start_date: '2026-09-19 18:00:00',
  utc_end_date: '2026-09-19 22:00:00',
  categories: [
    { slug: 'film' }
  ],
  tags: [
    { name: 'Fundraiser', slug: 'fundraiser' },
    { name: 'Gala', slug: 'gala' }
  ],
  cost: '$100',
  cost_details: {
    values: ['100']
  },
  image: {
    url: 'https://example.com/benefit-gala.jpg'
  },
  featured: true,
}

// ── 7. Event with missing start date (should skip) ───────────────────────────
export const MISSING_START_DATE = {
  id: 3007,
  title: 'Upcoming Event TBD',
  description: 'Date to be announced.',
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

// ── 8. Event with no description ────────────────────────────────────────────
export const NO_DESCRIPTION_EVENT = {
  id: 3008,
  title: 'Late Night Movie Madness',
  description: null,
  url: 'https://nightlightcinema.com/madness',
  website: null,
  utc_start_date: '2026-05-24 23:00:00',
  utc_end_date: '2026-05-25 01:00:00',
  categories: [
    { slug: 'film' }
  ],
  tags: [
    { name: 'Movies', slug: 'movies' }
  ],
  cost: '$10',
  cost_details: {
    values: ['10']
  },
  image: {
    url: 'https://example.com/movie-night.jpg'
  },
  featured: false,
}

// ── 9. Event defaulting to art category (no match) ──────────────────────────
export const DEFAULT_ART_EVENT = {
  id: 3009,
  title: 'Special Presentation: Visual Art Installation',
  description: '<p>Interactive visual art experience.</p>',
  url: null,
  website: 'https://example.com/art-install',
  utc_start_date: '2026-07-22 17:00:00',
  utc_end_date: '2026-07-22 20:00:00',
  categories: [
    { slug: 'exhibition' }
  ],
  tags: [
    { name: 'Art', slug: 'art' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 10. Event with featured flag ────────────────────────────────────────────
export const FEATURED_EVENT = {
  id: 3010,
  title: 'Premiere: Award-Winning International Film',
  description: '<p>First showing of a critically acclaimed film from festivals worldwide.</p>',
  url: 'https://nightlightcinema.com/premiere',
  website: null,
  utc_start_date: '2026-08-15 19:30:00',
  utc_end_date: '2026-08-15 21:45:00',
  categories: [
    { slug: 'film' }
  ],
  tags: [
    { name: 'International', slug: 'international' },
    { name: 'Premiere', slug: 'premiere' }
  ],
  cost: '$12',
  cost_details: {
    values: ['12']
  },
  image: {
    url: 'https://example.com/premiere.jpg'
  },
  featured: true,
}

// ── 11. Event with image in description (fallback) ──────────────────────────
export const IMAGE_IN_DESCRIPTION = {
  id: 3011,
  title: 'Experimental Shorts Program',
  description: '<p>Collection of experimental and avant-garde short films.</p><img src="https://example.com/shorts.jpg" alt="shorts">',
  url: null,
  website: 'https://example.com/shorts',
  utc_start_date: '2026-09-05 20:00:00',
  utc_end_date: '2026-09-05 21:30:00',
  categories: [
    { slug: 'film' }
  ],
  tags: [
    { name: 'Experimental', slug: 'experimental' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
}

// ── 12. Event with HTML entities in description ─────────────────────────────
export const HTML_ENTITY_EVENT = {
  id: 3012,
  title: 'Comedy Screening Night',
  description: '<p>Laugh-out-loud funny films. &ldquo;Pure joy&rdquo; &mdash; critics. &#169; 2026</p>',
  url: 'https://example.com/comedy',
  website: null,
  utc_start_date: '2026-06-07 19:00:00',
  utc_end_date: '2026-06-07 20:30:00',
  categories: [
    { slug: 'film' }
  ],
  tags: [
    { name: 'Comedy', slug: 'comedy' }
  ],
  cost: '$8',
  cost_details: {
    values: ['8']
  },
  image: null,
  featured: false,
}

export const ALL_FIXTURES = [
  COMPLETE_EVENT,
  MUSIC_EVENT,
  FOOD_EVENT,
  EDUCATION_EVENT,
  FAMILY_EVENT,
  BENEFIT_EVENT,
  MISSING_START_DATE,
  NO_DESCRIPTION_EVENT,
  DEFAULT_ART_EVENT,
  FEATURED_EVENT,
  IMAGE_IN_DESCRIPTION,
  HTML_ENTITY_EVENT,
]
