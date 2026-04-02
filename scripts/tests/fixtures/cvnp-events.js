/**
 * Fixture data for CVNP Conservancy scraper tests.
 *
 * Each fixture represents a distinct permutation of the Tribe Events Calendar
 * API response structure. Named to describe what edge case they exercise.
 */

// ── 1. Complete event with all fields populated ──────────────────────────────
export const COMPLETE_EVENT = {
  id: 1001,
  title: 'Spring Wildflower Walk',
  description: '<p>Join our naturalists for a guided walk through the park.</p>',
  url: 'https://www.conservancyforcvnp.org/events/wildflower-walk',
  website: 'https://www.conservancyforcvnp.org/events/wildflower-walk',
  utc_start_date: '2026-05-15 14:00:00',
  utc_end_date: '2026-05-15 16:00:00',
  categories: [
    { id: 1, name: 'Nature Program', slug: 'nature-program' }
  ],
  tags: [
    { id: 10, name: 'Outdoors', slug: 'outdoors' }
  ],
  cost: 'Free',
  cost_details: { values: [] },
  image: {
    id: 501,
    url: 'https://example.com/images/wildflower.jpg',
    alt: 'Wildflower',
  },
  featured: false,
  venue: {
    id: 101,
    venue: 'Ledges Trail Head',
    address: '8338 Old Mill Rd',
    city: 'Peninsula',
    stateprovince: 'OH',
    zip: '44264',
    geo_lat: '41.2580',
    geo_lng: '-81.5690',
    website: 'https://www.conservancyforcvnp.org',
  },
}

// ── 2. Event with paid cost range ────────────────────────────────────────────
export const PAID_EVENT = {
  id: 1002,
  title: 'Landscape Painting Workshop',
  description: '<p>Learn landscape painting from a professional artist.</p>',
  url: null,
  website: 'https://www.conservancyforcvnp.org/painting',
  utc_start_date: '2026-06-20 09:00:00',
  utc_end_date: '2026-06-20 12:00:00',
  categories: [
    { name: 'Education', slug: 'education' }
  ],
  tags: [
    { name: 'Workshop', slug: 'workshop' },
    { name: 'Painting', slug: 'painting' }
  ],
  cost: '$25 - $40',
  cost_details: {
    values: ['25', '40']
  },
  image: {
    url: 'https://example.com/images/painting-workshop.jpg'
  },
  featured: false,
  venue: {
    venue: 'Visitor Center',
    address: '15550 Boston Mills Rd',
    city: 'Peninsula',
    stateprovince: 'OH',
    zip: '44264',
    geo_lat: '41.2609',
    geo_lng: '-81.5696',
  },
}

// ── 3. Event with music category ─────────────────────────────────────────────
export const MUSIC_EVENT = {
  id: 1003,
  title: 'Evening Concert Series: Jazz in the Park',
  description: null,
  url: 'https://www.conservancyforcvnp.org/events/jazz',
  website: null,
  utc_start_date: '2026-07-18 18:00:00',
  utc_end_date: '2026-07-18 20:00:00',
  categories: [
    { id: 2, name: 'Music', slug: 'music' }
  ],
  tags: [
    { name: 'Concert', slug: 'concert' },
    { name: 'Performance', slug: 'performance' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: true,
  venue: {
    venue: 'Towpath Trail Amphitheater',
    address: null,
    city: 'Peninsula',
    stateprovince: 'OH',
    zip: null,
    geo_lat: '41.2650',
    geo_lng: '-81.5710',
  },
}

// ── 4. Event with sports category ────────────────────────────────────────────
export const SPORTS_EVENT = {
  id: 1004,
  title: 'Group Bike Ride: Towpath Trail',
  description: '<p>20-mile intermediate ride along the scenic towpath.</p>',
  url: null,
  website: 'https://example.com/bike',
  utc_start_date: '2026-08-09 08:00:00',
  utc_end_date: '2026-08-09 11:30:00',
  categories: [
    { slug: 'sports-fitness' }
  ],
  tags: [
    { name: 'Biking', slug: 'biking' },
    { name: 'Fitness', slug: 'fitness' }
  ],
  cost: 'Free',
  cost_details: {},
  image: { url: 'https://example.com/bike-ride.jpg' },
  featured: false,
  venue: {
    venue: 'Boston Mill Visitor Center',
    address: '6992 Riverview Rd',
    city: 'Brecksville',
    stateprovince: 'OH',
    zip: '44141',
    geo_lat: '41.2620',
    geo_lng: '-81.5440',
  },
}

// ── 5. Event with no venue ───────────────────────────────────────────────────
export const NO_VENUE_EVENT = {
  id: 1005,
  title: 'Cuyahoga Valley National Park Information Session',
  description: 'Learn about visiting the park.',
  url: null,
  website: null,
  utc_start_date: '2026-09-15 13:00:00',
  utc_end_date: '2026-09-15 14:00:00',
  categories: [
    { name: 'Education', slug: 'education' }
  ],
  tags: [],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
  venue: null,
}

// ── 6. Event with no categories/tags ─────────────────────────────────────────
export const MINIMAL_EVENT = {
  id: 1006,
  title: 'Park Cleanup Day',
  description: '',
  url: null,
  website: null,
  utc_start_date: '2026-04-25 09:00:00',
  utc_end_date: '2026-04-25 12:00:00',
  categories: [],
  tags: [],
  cost: '',
  cost_details: {},
  image: null,
  featured: false,
  venue: {
    venue: 'Multiple Park Locations',
    address: null,
    city: 'Peninsula',
    stateprovince: 'OH',
    zip: null,
  },
}

// ── 7. Event with missing utc_start_date (should skip) ──────────────────────
export const MISSING_START_DATE = {
  id: 1007,
  title: 'TBD Future Event',
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
  venue: {
    venue: 'Ledges Trail',
    address: null,
    city: 'Peninsula',
    stateprovince: 'OH',
    zip: '44264',
  },
}

// ── 8. Event with HTML in description ────────────────────────────────────────
export const RICH_HTML_DESCRIPTION = {
  id: 1008,
  title: 'Summer Reading at the Park',
  description: '<h2>Outdoor Reading Sessions</h2><p>Bring a book and <strong>enjoy</strong> nature. <em>All ages</em> welcome.</p><ul><li>Free</li><li>Shaded areas</li></ul>',
  url: 'https://example.com/reading',
  website: null,
  utc_start_date: '2026-06-10 10:00:00',
  utc_end_date: '2026-06-10 11:30:00',
  categories: [
    { name: 'Community Program', slug: 'community' }
  ],
  tags: [
    { name: 'Family Friendly', slug: 'family' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
  venue: {
    venue: 'Meadow Run',
    address: null,
    city: 'Peninsula',
    stateprovince: 'OH',
    zip: null,
  },
}

// ── 9. Event with no image ───────────────────────────────────────────────────
export const NO_IMAGE_EVENT = {
  id: 1009,
  title: 'Bird Watching at Sunrise',
  description: '<p>Early morning bird identification walk.</p>',
  url: null,
  website: 'https://example.com/birds',
  utc_start_date: '2026-05-20 05:30:00',
  utc_end_date: '2026-05-20 07:00:00',
  categories: [
    { name: 'Nature Program', slug: 'nature' }
  ],
  tags: [
    { name: 'Birding', slug: 'birding' }
  ],
  cost: 'Free',
  cost_details: {},
  image: null,
  featured: false,
  venue: {
    venue: 'Canal Visitor Center',
    address: '8172 Old Mill Rd',
    city: 'Peninsula',
    stateprovince: 'OH',
    zip: '44264',
    geo_lat: '41.2500',
    geo_lng: '-81.5700',
  },
}

// ── 10. Event with paddling/kayak category ───────────────────────────────────
export const PADDLING_EVENT = {
  id: 1010,
  title: 'Kayak Tour: Cuyahoga River',
  description: '<p>Scenic paddle down the river.</p>',
  url: 'https://example.com/kayak',
  website: null,
  utc_start_date: '2026-07-05 13:00:00',
  utc_end_date: '2026-07-05 15:30:00',
  categories: [
    { slug: 'sports-recreation' }
  ],
  tags: [
    { name: 'Kayaking', slug: 'kayaking' },
    { name: 'Paddling', slug: 'paddling' }
  ],
  cost: '$35',
  cost_details: { values: ['35'] },
  image: {
    url: 'https://example.com/kayak-tour.jpg'
  },
  featured: false,
  venue: {
    venue: 'Lock 29 Access Point',
    address: 'Canal Rd',
    city: 'Brecksville',
    stateprovince: 'OH',
    zip: '44141',
    geo_lat: '41.2580',
    geo_lng: '-81.5480',
  },
}

// ── 11. Event with featured flag ─────────────────────────────────────────────
export const FEATURED_EVENT = {
  id: 1011,
  title: 'Ledges Trail Dedication Ceremony',
  description: '<p>Celebrate the reopening of the <strong>newly renovated</strong> Ledges Trail.</p>',
  url: 'https://example.com/ledges',
  website: null,
  utc_start_date: '2026-05-01 15:00:00',
  utc_end_date: '2026-05-01 17:00:00',
  categories: [
    { name: 'Event', slug: 'event' }
  ],
  tags: [
    { name: 'Celebration', slug: 'celebration' }
  ],
  cost: 'Free',
  cost_details: {},
  image: {
    url: 'https://example.com/ledges-dedication.jpg'
  },
  featured: true,
  venue: {
    venue: 'Ledges Trail Entrance',
    address: null,
    city: 'Peninsula',
    stateprovince: 'OH',
    zip: '44264',
    geo_lat: '41.2600',
    geo_lng: '-81.5680',
  },
}

// ── 12. Event with running category ──────────────────────────────────────────
export const RUNNING_EVENT = {
  id: 1012,
  title: '5K Trail Run Benefit',
  description: 'Charity 5K run supporting park conservation.',
  url: 'https://example.com/5k',
  website: null,
  utc_start_date: '2026-09-26 07:00:00',
  utc_end_date: '2026-09-26 08:30:00',
  categories: [
    { slug: 'sports' },
    { slug: 'run' }
  ],
  tags: [
    { name: 'Running', slug: 'running' }
  ],
  cost: '$25',
  cost_details: { values: ['25'] },
  image: null,
  featured: false,
  venue: {
    venue: 'Boston Mill Visitor Center',
    address: '6992 Riverview Rd',
    city: 'Brecksville',
    stateprovince: 'OH',
    zip: '44141',
  },
}

export const ALL_FIXTURES = [
  COMPLETE_EVENT,
  PAID_EVENT,
  MUSIC_EVENT,
  SPORTS_EVENT,
  NO_VENUE_EVENT,
  MINIMAL_EVENT,
  MISSING_START_DATE,
  RICH_HTML_DESCRIPTION,
  NO_IMAGE_EVENT,
  PADDLING_EVENT,
  FEATURED_EVENT,
  RUNNING_EVENT,
]
