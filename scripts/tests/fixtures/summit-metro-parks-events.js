/**
 * Fixture data for Summit Metro Parks (Tribe Events Calendar) scraper tests.
 *
 * Each fixture represents a distinct permutation of the Tribe REST API
 * response structure. Named to describe what edge case they exercise.
 */

// ── 1. Complete event with all fields populated ──────────────────────────────
export const COMPLETE_EVENT = {
  id: 1001,
  title: 'Spring Trail Cleanup',
  description: '<p>Join us for a <strong>community</strong> trail cleanup.</p>',
  utc_start_date: '2026-05-15 14:00:00',
  utc_end_date: '2026-05-15 16:00:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: [] },
  categories: [
    { id: 1, name: 'Outdoor Activities', slug: 'outdoor-activities' }
  ],
  tags: [
    { id: 10, name: 'Parks', slug: 'parks' }
  ],
  image: {
    id: 100,
    url: 'https://www.summitmetroparks.org/images/trail-cleanup.jpg'
  },
  url: 'https://www.summitmetroparks.org/trail-cleanup',
  website: 'https://www.summitmetroparks.org',
  venue: {
    venue: 'Sand Run Park',
    address: '3500 Sand Run Road',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44313',
    geo_lat: '41.0814',
    geo_lng: '-81.5190',
    website: 'https://www.summitmetroparks.org'
  }
}

// ── 2. Event with free cost (cost as "Free" string) ────────────────────────────
export const FREE_EVENT = {
  id: 1002,
  title: 'Birding for Beginners',
  description: 'Learn to identify local bird species.',
  utc_start_date: '2026-06-01 09:00:00',
  utc_end_date: '2026-06-01 11:00:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: [] },
  categories: [
    { id: 2, name: 'Education', slug: 'education' }
  ],
  tags: [
    { id: 11, name: 'Wildlife', slug: 'wildlife' }
  ],
  image: null,
  url: 'https://www.summitmetroparks.org/birding',
  website: null,
  venue: {
    venue: 'Summit Lake Park',
    address: '975 Treaty Line Rd',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44313',
    geo_lat: '41.1567',
    geo_lng: '-81.5940',
    website: null
  }
}

// ── 3. Event with paid cost range ──────────────────────────────────────────────
export const PAID_EVENT_RANGE = {
  id: 1003,
  title: 'Canoe Rental & Guided Tour',
  description: 'Half-day paddling adventure on the Cuyahoga River.',
  utc_start_date: '2026-05-20 10:00:00',
  utc_end_date: '2026-05-20 14:00:00',
  featured: false,
  cost: '$15 - $25',
  cost_details: {
    values: [15, 25]
  },
  categories: [
    { id: 3, name: 'Recreation', slug: 'recreation' },
    { id: 4, name: 'Sports', slug: 'sports' }
  ],
  tags: [
    { id: 12, name: 'Water Sports', slug: 'water-sports' }
  ],
  image: {
    id: 101,
    url: 'https://www.summitmetroparks.org/images/canoe.jpg'
  },
  url: 'https://www.summitmetroparks.org/canoe',
  website: 'https://www.summitmetroparks.org',
  venue: {
    venue: 'Cuyahoga Valley National Park',
    address: '1438 Mill Run Road',
    city: 'Peninsula',
    stateprovince: 'OH',
    zip: '44264',
    geo_lat: '41.2465',
    geo_lng: '-81.5629',
    website: 'https://www.summitmetroparks.org'
  }
}

// ── 4. Event with single paid cost ──────────────────────────────────────────────
export const PAID_EVENT_SINGLE = {
  id: 1004,
  title: 'Yoga in the Park',
  description: 'Outdoor yoga session for all levels.',
  utc_start_date: '2026-07-15 18:00:00',
  utc_end_date: '2026-07-15 19:30:00',
  featured: false,
  cost: '$10',
  cost_details: {
    values: [10]
  },
  categories: [],
  tags: [
    { id: 13, name: 'Wellness', slug: 'wellness' }
  ],
  image: null,
  url: 'https://www.summitmetroparks.org/yoga',
  website: null,
  venue: {
    venue: 'Marshwood Park',
    address: null,
    city: 'Akron',
    stateprovince: 'OH',
    zip: null,
    geo_lat: null,
    geo_lng: null,
    website: null
  }
}

// ── 5. Event with no venue ─────────────────────────────────────────────────────
export const NO_VENUE = {
  id: 1005,
  title: 'Virtual Park Tour',
  description: 'Online presentation about park history.',
  utc_start_date: '2026-08-10 19:00:00',
  utc_end_date: '2026-08-10 20:00:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: [] },
  categories: [
    { id: 5, name: 'History', slug: 'history' }
  ],
  tags: [],
  image: null,
  url: 'https://www.summitmetroparks.org/virtual-tour',
  website: 'https://www.summitmetroparks.org',
  venue: null
}

// ── 6. Event with empty venue name ─────────────────────────────────────────────
export const EMPTY_VENUE_NAME = {
  id: 1006,
  title: 'Mystery Hike',
  description: 'Follow us on a surprise nature hike!',
  utc_start_date: '2026-04-25 08:00:00',
  utc_end_date: '2026-04-25 10:00:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: [] },
  categories: [],
  tags: [],
  image: null,
  url: 'https://www.summitmetroparks.org/mystery-hike',
  website: null,
  venue: {
    venue: '',
    address: null,
    city: 'Akron',
    stateprovince: 'OH',
    zip: null,
    geo_lat: null,
    geo_lng: null,
    website: null
  }
}

// ── 7. Event with no categories or tags ────────────────────────────────────────
export const NO_CATEGORIES_OR_TAGS = {
  id: 1007,
  title: 'Spring Festival',
  description: 'Celebrating the season with food, music, and activities.',
  utc_start_date: '2026-06-20 10:00:00',
  utc_end_date: '2026-06-20 18:00:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: [] },
  categories: [],
  tags: [],
  image: null,
  url: 'https://www.summitmetroparks.org/festival',
  website: 'https://www.summitmetroparks.org',
  venue: {
    venue: 'Summit Lake Park',
    address: '975 Treaty Line Rd',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44313',
    geo_lat: '41.1567',
    geo_lng: '-81.5940',
    website: null
  }
}

// ── 8. Event with no image ─────────────────────────────────────────────────────
export const NO_IMAGE = {
  id: 1008,
  title: 'Sunset Picnic',
  description: 'Bring a blanket and enjoy the sunset.',
  utc_start_date: '2026-07-25 19:00:00',
  utc_end_date: '2026-07-25 20:30:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: [] },
  categories: [
    { id: 6, name: 'Social', slug: 'social' }
  ],
  tags: [],
  image: null,
  url: 'https://www.summitmetroparks.org/picnic',
  website: null,
  venue: {
    venue: 'Firestone Park',
    address: '2500 Harrington Road',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44305',
    geo_lat: '41.0657',
    geo_lng: '-81.4829',
    website: null
  }
}

// ── 9. Event with missing utc_start_date (should be skipped) ───────────────────
export const MISSING_START_DATE = {
  id: 1009,
  title: 'TBD Event',
  description: null,
  utc_start_date: null,
  utc_end_date: null,
  featured: false,
  cost: 'Free',
  cost_details: { values: [] },
  categories: [],
  tags: [],
  image: null,
  url: null,
  website: null,
  venue: null
}

// ── 10. Event with featured flag ───────────────────────────────────────────────
export const FEATURED_EVENT = {
  id: 1010,
  title: 'Grand Opening Celebration',
  description: '<strong>Headline event!</strong> Join us for the big celebration.',
  utc_start_date: '2026-09-15 09:00:00',
  utc_end_date: '2026-09-15 17:00:00',
  featured: true,
  cost: 'Free',
  cost_details: { values: [] },
  categories: [
    { id: 7, name: 'Community Event', slug: 'community-event' }
  ],
  tags: [
    { id: 14, name: 'Featured', slug: 'featured' }
  ],
  image: {
    id: 102,
    url: 'https://www.summitmetroparks.org/images/grand-opening.jpg'
  },
  url: 'https://www.summitmetroparks.org/grand-opening',
  website: 'https://www.summitmetroparks.org',
  venue: {
    venue: 'Summit Lake Park',
    address: '975 Treaty Line Rd',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44313',
    geo_lat: '41.1567',
    geo_lng: '-81.5940',
    website: null
  }
}

// ── 11. Event with HTML in description ───────────────────────────────────────
export const HTML_IN_DESCRIPTION = {
  id: 1011,
  title: 'Interpretive Nature Walk',
  description: `
    <h3>Discover Our Local Ecosystems</h3>
    <p>Learn about the <em>unique habitats</em> in our parks:</p>
    <ul>
      <li>Wetlands &amp; marshes</li>
      <li>Forests &amp; meadows</li>
      <li>Waterways</li>
    </ul>
    <p><strong>All ages welcome!</strong></p>
  `,
  utc_start_date: '2026-05-10 10:00:00',
  utc_end_date: '2026-05-10 12:00:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: [] },
  categories: [
    { id: 8, name: 'Education', slug: 'education' }
  ],
  tags: [
    { id: 15, name: 'Nature', slug: 'nature' }
  ],
  image: {
    id: 103,
    url: 'https://www.summitmetroparks.org/images/nature-walk.jpg'
  },
  url: 'https://www.summitmetroparks.org/nature-walk',
  website: 'https://www.summitmetroparks.org',
  venue: {
    venue: 'Cascade Valley Metro Park',
    address: '4238 Everett Road',
    city: 'Richfield',
    stateprovince: 'OH',
    zip: '44286',
    geo_lat: '41.2183',
    geo_lng: '-81.6231',
    website: 'https://www.summitmetroparks.org'
  }
}

// ── 12. Event with multiple categories mapping to different category types ────
export const MULTIPLE_CATEGORIES = {
  id: 1012,
  title: 'Music Festival in the Park',
  description: 'Live music performances from local artists.',
  utc_start_date: '2026-07-30 17:00:00',
  utc_end_date: '2026-07-30 22:00:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: [] },
  categories: [
    { id: 9, name: 'Music', slug: 'music' },
    { id: 10, name: 'Entertainment', slug: 'entertainment' },
    { id: 11, name: 'Community', slug: 'community' }
  ],
  tags: [
    { id: 16, name: 'Live Music', slug: 'live-music' },
    { id: 17, name: 'Family Friendly', slug: 'family-friendly' }
  ],
  image: {
    id: 104,
    url: 'https://www.summitmetroparks.org/images/music-fest.jpg'
  },
  url: 'https://www.summitmetroparks.org/music-fest',
  website: 'https://www.summitmetroparks.org',
  venue: {
    venue: 'Summit Lake Park',
    address: '975 Treaty Line Rd',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44313',
    geo_lat: '41.1567',
    geo_lng: '-81.5940',
    website: null
  }
}

// ── 13. Sports-themed event to test category mapping ──────────────────────────
export const SPORTS_EVENT = {
  id: 1013,
  title: 'Trail Running 5K',
  description: 'Join us for a scenic trail run through the park.',
  utc_start_date: '2026-05-05 07:00:00',
  utc_end_date: '2026-05-05 09:00:00',
  featured: false,
  cost: '$20',
  cost_details: { values: [20] },
  categories: [
    { id: 12, name: 'Fitness', slug: 'fitness' },
    { id: 13, name: 'Sports', slug: 'sports' },
    { id: 14, name: 'Running', slug: 'running' }
  ],
  tags: [
    { id: 18, name: 'Trail', slug: 'trail' },
    { id: 19, name: 'Fitness', slug: 'fitness' }
  ],
  image: {
    id: 105,
    url: 'https://www.summitmetroparks.org/images/trail-5k.jpg'
  },
  url: 'https://www.summitmetroparks.org/trail-5k',
  website: 'https://www.summitmetroparks.org',
  venue: {
    venue: 'Towpath Trail - Lock 3 Area',
    address: '101 S Main St',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44308',
    geo_lat: '41.0814',
    geo_lng: '-81.5190',
    website: null
  }
}

// ── 14. Educational program event ──────────────────────────────────────────────
export const EDUCATION_EVENT = {
  id: 1014,
  title: 'Environmental Science Workshop',
  description: 'Learn about water quality testing and ecosystem monitoring.',
  utc_start_date: '2026-06-12 14:00:00',
  utc_end_date: '2026-06-12 16:00:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: [] },
  categories: [
    { id: 15, name: 'Class', slug: 'class' },
    { id: 16, name: 'Workshop', slug: 'workshop' }
  ],
  tags: [
    { id: 20, name: 'Education', slug: 'education' },
    { id: 21, name: 'Science', slug: 'science' }
  ],
  image: null,
  url: 'https://www.summitmetroparks.org/workshop',
  website: 'https://www.summitmetroparks.org',
  venue: {
    venue: 'Visitor Center',
    address: '975 Treaty Line Rd',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44313',
    geo_lat: '41.1567',
    geo_lng: '-81.5940',
    website: null
  }
}

// Array of all fixtures for batch testing
export const ALL_FIXTURES = [
  COMPLETE_EVENT,
  FREE_EVENT,
  PAID_EVENT_RANGE,
  PAID_EVENT_SINGLE,
  NO_VENUE,
  EMPTY_VENUE_NAME,
  NO_CATEGORIES_OR_TAGS,
  NO_IMAGE,
  MISSING_START_DATE,
  FEATURED_EVENT,
  HTML_IN_DESCRIPTION,
  MULTIPLE_CATEGORIES,
  SPORTS_EVENT,
  EDUCATION_EVENT,
]
