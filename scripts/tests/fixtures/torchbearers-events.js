/**
 * Fixture data for Torchbearers (Tribe Events Calendar) scraper tests.
 *
 * Each fixture represents a distinct permutation of the Tribe REST API
 * response structure. Shaped to match the real API responses.
 */

// ── 1. Complete event with venue, image, organizers ─────────────────────────
export const COMPLETE_EVENT = {
  id: 25876,
  title: 'Membership Committee Meeting',
  description: '<p>The Membership Committee will discuss upcoming projects and GMMs.</p>',
  excerpt: '<p>The Membership Committee will discuss upcoming projects and GMMs.</p>',
  utc_start_date: '2026-04-01 22:00:00',
  utc_end_date: '2026-04-01 23:00:00',
  featured: false,
  cost: 'Free',
  cost_details: { currency_symbol: '', values: ['0'] },
  categories: [
    { id: 198, name: 'Committee Meetings', slug: 'committee-meetings' },
  ],
  tags: [],
  image: false,
  url: 'https://torchbearersakron.com/event/membership-committee-meeting/',
  website: '',
  venue: [],
  is_virtual: true,
}

// ── 2. Event with venue and image ───────────────────────────────────────────
export const EVENT_WITH_VENUE = {
  id: 26112,
  title: 'Marcomm Committee Meeting',
  description: '<p>Please RSVP.</p>',
  excerpt: '',
  utc_start_date: '2026-04-02 22:00:00',
  utc_end_date: '2026-04-02 23:00:00',
  featured: false,
  cost: 'Free',
  cost_details: { currency_symbol: '$', currency_position: 'prefix', values: ['0'] },
  categories: [
    { id: 198, name: 'Committee Meetings', slug: 'committee-meetings' },
  ],
  tags: [],
  image: {
    url: 'https://torchbearersakron.com/wp-content/uploads/2021/12/TB-Website-Events-Headers_MarComm.png',
    id: 8330,
    extension: 'png',
    width: 5000,
    height: 1042,
  },
  url: 'https://torchbearersakron.com/event/marcomm-committee-meeting/',
  website: '',
  venue: {
    id: 26328,
    venue: 'Macaroni Grill',
    address: '41 Springside Drive',
    city: 'Akron',
    country: 'United States',
    state: 'OH',
    stateprovince: 'OH',
    zip: '44333',
    geo_lat: null,
    geo_lng: null,
  },
  is_virtual: false,
}

// ── 3. Social/happy hour event ──────────────────────────────────────────────
export const SOCIAL_EVENT = {
  id: 26200,
  title: 'April Happy Hour',
  description: '<p>Join us for networking and drinks at a local spot in Highland Square!</p>',
  excerpt: '<p>Join us for networking and drinks.</p>',
  utc_start_date: '2026-04-10 23:00:00',
  utc_end_date: '2026-04-11 01:00:00',
  featured: false,
  cost: '',
  cost_details: { values: [] },
  categories: [
    { id: 201, name: 'Social Events', slug: 'social-events' },
  ],
  tags: [
    { id: 301, name: 'Happy Hour', slug: 'happy-hour' },
  ],
  image: {
    url: 'https://torchbearersakron.com/wp-content/uploads/2024/01/happy-hour.jpg',
    id: 9001,
  },
  url: 'https://torchbearersakron.com/event/april-happy-hour/',
  website: '',
  venue: {
    venue: 'The Barrel Room',
    address: '834 W Market St',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44303',
    geo_lat: '41.0782',
    geo_lng: '-81.5365',
  },
  is_virtual: false,
}

// ── 4. Volunteer/service event ──────────────────────────────────────────────
export const VOLUNTEER_EVENT = {
  id: 26250,
  title: 'Habitat for Humanity Build Day',
  description: '<p>Join Torchbearers for a <strong>volunteer</strong> build day with Habitat for Humanity of Summit County.</p>',
  excerpt: '',
  utc_start_date: '2026-05-09 13:00:00',
  utc_end_date: '2026-05-09 21:00:00',
  featured: true,
  cost: 'Free',
  cost_details: { values: ['0'] },
  categories: [
    { id: 205, name: 'Volunteer', slug: 'volunteer' },
  ],
  tags: [
    { id: 310, name: 'Service', slug: 'service' },
    { id: 311, name: 'Habitat', slug: 'habitat' },
  ],
  image: {
    url: 'https://torchbearersakron.com/wp-content/uploads/2025/03/habitat-build.jpg',
    id: 9100,
  },
  url: 'https://torchbearersakron.com/event/habitat-build-day/',
  website: 'https://habitatsummitcounty.org',
  venue: {
    venue: 'Habitat for Humanity Build Site',
    address: '500 Grant St',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44311',
  },
  is_virtual: false,
}

// ── 5. GMM (General Membership Meeting) ─────────────────────────────────────
export const GMM_EVENT = {
  id: 26300,
  title: 'April General Membership Meeting',
  description: '<p>Monthly GMM with guest speaker and updates from committees.</p>',
  utc_start_date: '2026-04-15 23:30:00',
  utc_end_date: '2026-04-16 01:30:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: ['0'] },
  categories: [
    { id: 210, name: 'General Membership Meeting', slug: 'gmm' },
  ],
  tags: [],
  image: false,
  url: 'https://torchbearersakron.com/event/april-gmm/',
  website: '',
  venue: {
    venue: 'Barley House Akron',
    address: '222 S Main St',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44308',
    geo_lat: '41.0798',
    geo_lng: '-81.5195',
  },
  is_virtual: false,
}

// ── 6. Event with no venue (empty array) ────────────────────────────────────
export const NO_VENUE = {
  id: 26350,
  title: 'Virtual Leadership Workshop',
  description: '<p>Online leadership development session via Zoom.</p>',
  utc_start_date: '2026-04-20 17:00:00',
  utc_end_date: '2026-04-20 18:30:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: ['0'] },
  categories: [
    { id: 215, name: 'Workshops', slug: 'workshops' },
  ],
  tags: [],
  image: false,
  url: 'https://torchbearersakron.com/event/virtual-leadership/',
  website: '',
  venue: [],
  is_virtual: true,
}

// ── 7. Paid event ───────────────────────────────────────────────────────────
export const PAID_EVENT = {
  id: 26400,
  title: 'Annual Gala: Ignite the Future',
  description: '<p>Torchbearers annual fundraising gala featuring dinner, awards, and dancing.</p>',
  utc_start_date: '2026-06-20 23:00:00',
  utc_end_date: '2026-06-21 03:00:00',
  featured: true,
  cost: '$50 - $75',
  cost_details: { values: ['50', '75'] },
  categories: [
    { id: 220, name: 'Fundraisers', slug: 'fundraisers' },
  ],
  tags: [
    { id: 320, name: 'Annual', slug: 'annual' },
    { id: 321, name: 'Gala', slug: 'gala' },
  ],
  image: {
    url: 'https://torchbearersakron.com/wp-content/uploads/2026/01/gala-2026.jpg',
    id: 9200,
  },
  url: 'https://torchbearersakron.com/event/annual-gala-2026/',
  website: 'https://torchbearersakron.com/gala',
  venue: {
    venue: 'Greystone Hall',
    address: '103 S High St',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44308',
    geo_lat: '41.0804',
    geo_lng: '-81.5185',
  },
  is_virtual: false,
}

// ── 8. Event with HTML entities ─────────────────────────────────────────────
export const HTML_ENTITIES_EVENT = {
  id: 26450,
  title: 'Torchbearers&#8217; Summer Kick-Off &amp; BBQ',
  description: '<p>It&#8217;s time to celebrate summer! Join us for burgers &amp; fun.</p>',
  utc_start_date: '2026-06-05 22:00:00',
  utc_end_date: '2026-06-06 00:00:00',
  featured: false,
  cost: 'Free',
  cost_details: { values: ['0'] },
  categories: [
    { id: 201, name: 'Social Events', slug: 'social-events' },
  ],
  tags: [],
  image: false,
  url: 'https://torchbearersakron.com/event/summer-kickoff/',
  website: '',
  venue: {
    venue: 'Lock 3 Park',
    address: '200 S Main St',
    city: 'Akron',
    stateprovince: 'OH',
    zip: '44308',
  },
  is_virtual: false,
}

// ── 9. Event with no start date ─────────────────────────────────────────────
export const NO_START_DATE = {
  id: 26500,
  title: 'TBD Event',
  description: '<p>Details forthcoming.</p>',
  utc_start_date: null,
  utc_end_date: null,
  featured: false,
  cost: '',
  cost_details: { values: [] },
  categories: [],
  tags: [],
  image: false,
  url: 'https://torchbearersakron.com/event/tbd/',
  website: '',
  venue: [],
  is_virtual: false,
}

// ── All fixtures ────────────────────────────────────────────────────────────
export const ALL_FIXTURES = [
  COMPLETE_EVENT,
  EVENT_WITH_VENUE,
  SOCIAL_EVENT,
  VOLUNTEER_EVENT,
  GMM_EVENT,
  NO_VENUE,
  PAID_EVENT,
  HTML_ENTITIES_EVENT,
  NO_START_DATE,
]
