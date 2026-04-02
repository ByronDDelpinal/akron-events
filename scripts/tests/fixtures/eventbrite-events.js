/**
 * Fixture data for Eventbrite scraper tests.
 *
 * Each fixture represents a distinct permutation of the Eventbrite API
 * response structure, including the critical is_free pricing bug fix.
 * Named to describe what edge case they exercise.
 */

// ── 1. Complete event with all fields (object-based name and dates) ────────────
export const COMPLETE_EVENT = {
  id: '101',
  name: { text: 'Spring Market & Craft Fair' },
  summary: 'Browse local artisan crafts and homemade goods.',
  description: {
    text: '<p>Join us for our <strong>annual spring market</strong> featuring local vendors, handmade crafts, and delicious food.</p>'
  },
  start: { utc: '2026-05-15T14:00:00Z' },
  end: { utc: '2026-05-15T18:00:00Z' },
  is_free: false,
  ticket_availability: {
    is_free: false,
    minimum_ticket_price: { major_value: '10' },
    maximum_ticket_price: { major_value: '20' }
  },
  ticket_classes: [],
  category_id: '110', // food
  image: { url: 'https://cdn.evbstatic.com/spring-market.jpg' },
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/spring-market-101',
  ticket_url: 'https://www.eventbrite.com/e/spring-market-101',
  venue: {
    name: 'Summit Lake Park',
    address: { address_1: '975 Treaty Line Rd', city: 'Akron', region: 'OH', postal_code: '44313' },
    latitude: 41.1567,
    longitude: -81.5940
  },
  primary_venue: null,
  organizer: { name: 'Akron Events Team', website: 'https://akronevents.org' },
  primary_organizer: null
}

// ── 2. Event with is_free=true AND ticket_availability confirming free → FREE ──
export const FREE_EVENT_WITH_CONFIRMATION = {
  id: '102',
  name: { text: 'Community Park Cleanup' },
  summary: 'Help us keep our parks clean.',
  description: { text: 'A volunteer opportunity to clean up Summit Lake Park.' },
  start: { utc: '2026-06-01T09:00:00Z' },
  end: { utc: '2026-06-01T11:00:00Z' },
  is_free: true,
  ticket_availability: {
    is_free: true,
    minimum_ticket_price: { major_value: '0' },
    maximum_ticket_price: null
  },
  ticket_classes: [],
  category_id: '113', // community
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/cleanup-102',
  ticket_url: 'https://www.eventbrite.com/e/cleanup-102',
  venue: null,
  organizer: { name: 'Summit Metro Parks' },
  primary_organizer: null
}

// ── 3. CRITICAL BUG FIX: is_free=true but NO ticket_availability/ticket_classes
//     → Should be UNKNOWN (0/null), NOT asserted as free (0/0)
export const FREE_FLAG_NO_PRICING_DATA = {
  id: '103',
  name: { text: 'Outdoor Fitness Class' },
  summary: 'Morning yoga in the park.',
  description: { text: 'Join us for a relaxing outdoor yoga session.' },
  start: { utc: '2026-06-15T08:00:00Z' },
  end: { utc: '2026-06-15T09:00:00Z' },
  is_free: true,
  // NO ticket_availability
  // NO ticket_classes
  category_id: '107', // sports
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/yoga-103',
  ticket_url: 'https://www.eventbrite.com/e/yoga-103',
  venue: null,
  organizer: { name: 'Fitness Akron' },
  primary_organizer: null
}

// ── 4. Free event - is_free=true AND ticket_availability.is_free=false but has prices
//     → When both is_free flags are true with pricing data, assert free (0/0)
export const FREE_FLAG_BUT_PAID_TICKETS = {
  id: '104',
  name: { text: 'Concert in the Park' },
  summary: 'Live music performance.',
  description: { text: 'Enjoy a free concert featuring local musicians.' },
  start: { utc: '2026-07-20T19:00:00Z' },
  end: { utc: '2026-07-20T21:00:00Z' },
  is_free: true,
  // When is_free=true AND ta has pricing, if ta.is_free is also true → (0/0)
  // If ta.is_free is not set/null and we have pricing data, still (0/0) due to is_free check
  ticket_availability: {
    is_free: true,  // ta also says free
    minimum_ticket_price: { major_value: '0' },
    maximum_ticket_price: { major_value: '0' }
  },
  ticket_classes: [],
  category_id: '103', // music
  image: { url: 'https://cdn.evbstatic.com/concert.jpg' },
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/concert-104',
  ticket_url: 'https://www.eventbrite.com/e/concert-104',
  venue: {
    name: 'Akron Civic Theatre',
    address: { address_1: '182 S Main St', city: 'Akron', region: 'OH', postal_code: '44308' }
  },
  organizer: { name: 'Akron Parks & Rec' },
  primary_organizer: null
}

// ── 5. ticket_classes array with multiple price tiers ────────────────────────
export const MULTIPLE_TICKET_CLASSES = {
  id: '105',
  name: 'Outdoor Adventure Workshop',
  summary: 'Learn outdoor skills.',
  description: 'Interactive workshop on hiking, camping, and outdoor safety.',
  start: { utc: '2026-05-25T10:00:00Z' },
  end: { utc: '2026-05-25T12:00:00Z' },
  is_free: false,
  ticket_availability: null,
  ticket_classes: [
    {
      id: 'tc1',
      name: 'Early Bird',
      free: false,
      cost: { major_value: 15, currency: 'USD' }
    },
    {
      id: 'tc2',
      name: 'Regular',
      free: false,
      cost: { major_value: 25, currency: 'USD' }
    },
    {
      id: 'tc3',
      name: 'VIP',
      free: false,
      cost: { major_value: 50, currency: 'USD' }
    }
  ],
  category_id: '102', // education
  image: null,
  logo: { url: 'https://cdn.evbstatic.com/logo.jpg' },
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/adventure-105',
  ticket_url: 'https://www.eventbrite.com/e/adventure-105',
  venue: null,
  organizer: { name: 'Adventure Outfitters' },
  primary_organizer: null
}

// ── 6. Event with name as plain string (not object) ──────────────────────────
export const NAME_AS_STRING = {
  id: '106',
  name: 'Food Truck Rally',
  summary: 'Multiple food trucks in one place.',
  description: 'Come enjoy delicious food from various local vendors.',
  start: { utc: '2026-06-10T11:00:00Z' },
  end: { utc: '2026-06-10T15:00:00Z' },
  is_free: true,
  ticket_availability: { is_free: true, minimum_ticket_price: null },
  ticket_classes: [],
  category_id: '110', // food
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/foodtrucks-106',
  ticket_url: 'https://www.eventbrite.com/e/foodtrucks-106',
  venue: null,
  organizer: { name: 'Food Truck Collective' },
  primary_organizer: null
}

// ── 7. Event with start_date + start_time format (not start.utc) ───────────────
export const DATE_TIME_SEPARATE = {
  id: '107',
  name: { text: 'Art Gallery Opening' },
  summary: 'Welcome to our new gallery space.',
  description: 'Exhibition of local artists\' work.',
  start_date: '2026-07-05',
  start_time: '18:00:00',
  end_date: '2026-07-05',
  end_time: '20:00:00',
  // no start.utc
  is_free: false,
  ticket_availability: {
    is_free: false,
    minimum_ticket_price: { major_value: '0' },
    maximum_ticket_price: null
  },
  ticket_classes: [],
  category_id: '105', // art
  image: { url: 'https://cdn.evbstatic.com/gallery.jpg' },
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/gallery-107',
  ticket_url: 'https://www.eventbrite.com/e/gallery-107',
  venue: {
    name: 'Akron Art Museum',
    address: { address_1: '1 South High St', city: 'Akron', region: 'OH', postal_code: '44308' }
  },
  organizer: { name: 'Akron Art Museum' },
  primary_organizer: null
}

// ── 8. Event with start_datetime format (ISO-like string) ──────────────────────
export const START_DATETIME_FORMAT = {
  id: '108',
  name: { text: 'Farmers Market' },
  summary: 'Fresh local produce and goods.',
  description: 'Weekly farmers market with seasonal vegetables and crafts.',
  start_datetime: '2026-05-30T09:00:00',
  end_datetime: '2026-05-30T13:00:00',
  // no start.utc
  is_free: true,
  ticket_availability: { is_free: true },
  ticket_classes: [],
  category_id: '110', // food
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/farmersmarket-108',
  ticket_url: 'https://www.eventbrite.com/e/farmersmarket-108',
  venue: null,
  organizer: { name: 'Local Farms Collective' },
  primary_organizer: null
}

// ── 9. Event with no start time (should be skipped) ───────────────────────────
export const NO_START_TIME = {
  id: '109',
  name: { text: 'TBD Event' },
  summary: null,
  description: null,
  // No start, start_date, or start_datetime
  is_free: true,
  ticket_availability: null,
  ticket_classes: [],
  category_id: '113',
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/tbd-109',
  ticket_url: null,
  venue: null,
  organizer: null,
  primary_organizer: null
}

// ── 10. Event with description as object {text: "..."} ───────────────────────
export const DESCRIPTION_AS_OBJECT = {
  id: '110',
  name: { text: 'Tech Meetup' },
  summary: 'Connect with tech professionals.',
  description: {
    text: '<p>Monthly <em>tech meetup</em> for developers, designers, and entrepreneurs.</p>'
  },
  start: { utc: '2026-06-20T18:00:00Z' },
  end: { utc: '2026-06-20T20:00:00Z' },
  is_free: true,
  ticket_availability: { is_free: true },
  ticket_classes: [],
  category_id: '102', // education
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/techmeetup-110',
  ticket_url: 'https://www.eventbrite.com/e/techmeetup-110',
  venue: {
    name: 'Tech Hub Akron',
    address: { address_1: '300 S High St', city: 'Akron', region: 'OH', postal_code: '44308' }
  },
  organizer: { name: 'Akron Tech Community' },
  primary_organizer: null
}

// ── 11. Event with description as plain string ────────────────────────────────
export const DESCRIPTION_AS_STRING = {
  id: '111',
  name: { text: 'Running Club Meetup' },
  summary: null,
  description: 'Join us for a casual 5k run through the park. All fitness levels welcome.',
  start: { utc: '2026-06-05T06:00:00Z' },
  end: { utc: '2026-06-05T07:15:00Z' },
  is_free: true,
  ticket_availability: { is_free: true, minimum_ticket_price: { major_value: '0' } },
  ticket_classes: [],
  category_id: '107', // sports
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/running-111',
  ticket_url: 'https://www.eventbrite.com/e/running-111',
  venue: null,
  organizer: { name: 'Akron Runners Club' },
  primary_organizer: null
}

// ── 12. Event with no description ──────────────────────────────────────────────
export const NO_DESCRIPTION = {
  id: '112',
  name: { text: 'Community Dance' },
  summary: null,
  description: null,
  start: { utc: '2026-07-10T19:00:00Z' },
  end: { utc: '2026-07-10T22:00:00Z' },
  is_free: false,
  ticket_availability: {
    is_free: false,
    minimum_ticket_price: { major_value: '5' },
    maximum_ticket_price: null
  },
  ticket_classes: [],
  category_id: '103', // music
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/dance-112',
  ticket_url: 'https://www.eventbrite.com/e/dance-112',
  venue: {
    name: 'Akron Civic Center',
    address: { address_1: '182 S Main St', city: 'Akron', region: 'OH', postal_code: '44308' }
  },
  organizer: { name: 'Community Arts Akron' },
  primary_organizer: null
}

// ── 13. Event with various category_ids ────────────────────────────────────────
export const CATEGORY_MUSIC = {
  id: '113',
  name: { text: 'Jazz Night at the Park' },
  summary: 'Live jazz performance.',
  description: 'Evening jazz performance by local musicians.',
  start: { utc: '2026-08-15T19:00:00Z' },
  end: { utc: '2026-08-15T21:00:00Z' },
  is_free: false,
  ticket_availability: {
    is_free: false,
    minimum_ticket_price: { major_value: '20' },
    maximum_ticket_price: null
  },
  ticket_classes: [],
  category_id: '103', // music — should map to 'music'
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/jazz-113',
  ticket_url: 'https://www.eventbrite.com/e/jazz-113',
  venue: null,
  organizer: { name: 'Jazz Society' },
  primary_organizer: null
}

// ── 14. Event with category mapping to art ────────────────────────────────────
export const CATEGORY_ART = {
  id: '114',
  name: { text: 'Pottery Workshop' },
  summary: 'Learn pottery basics.',
  description: 'Hands-on pottery class for beginners and intermediate artists.',
  start: { utc: '2026-07-08T10:00:00Z' },
  end: { utc: '2026-07-08T13:00:00Z' },
  is_free: false,
  ticket_availability: {
    is_free: false,
    minimum_ticket_price: { major_value: '35' },
    maximum_ticket_price: null
  },
  ticket_classes: [],
  category_id: '105', // art — should map to 'art'
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/pottery-114',
  ticket_url: 'https://www.eventbrite.com/e/pottery-114',
  venue: null,
  organizer: { name: 'Arts Akron' },
  primary_organizer: null
}

// ── 15. Event with image.url, logo.url, banner_url, hero_image_url
//     (test fallback chain) ───────────────────────────────────────────────────
export const IMAGE_PRIORITY_CHAIN = {
  id: '115',
  name: { text: 'Design Conference' },
  summary: 'Annual design conference.',
  description: 'Networking and talks from design leaders.',
  start: { utc: '2026-08-22T08:00:00Z' },
  end: { utc: '2026-08-22T18:00:00Z' },
  is_free: false,
  ticket_availability: {
    is_free: false,
    minimum_ticket_price: { major_value: '99' },
    maximum_ticket_price: { major_value: '199' }
  },
  ticket_classes: [],
  category_id: '102', // education
  image: { url: 'https://cdn.evbstatic.com/conf-image.jpg' },
  logo: { url: 'https://cdn.evbstatic.com/logo.jpg' },
  banner_url: 'https://cdn.evbstatic.com/banner.jpg',
  hero_image_url: 'https://cdn.evbstatic.com/hero.jpg',
  url: 'https://www.eventbrite.com/e/design-conf-115',
  ticket_url: 'https://www.eventbrite.com/e/design-conf-115',
  venue: null,
  organizer: { name: 'Design Society' },
  primary_organizer: null
}

// ── 16. Event with NO image at all ────────────────────────────────────────────
export const NO_IMAGE = {
  id: '116',
  name: { text: 'Book Club Meeting' },
  summary: 'Monthly book discussion.',
  description: 'We\'re reading "The Shadow of the Wind" this month.',
  start: { utc: '2026-06-28T19:00:00Z' },
  end: { utc: '2026-06-28T20:30:00Z' },
  is_free: true,
  ticket_availability: { is_free: true },
  ticket_classes: [],
  category_id: '102', // education
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/bookclub-116',
  ticket_url: 'https://www.eventbrite.com/e/bookclub-116',
  venue: {
    name: 'Akron Public Library',
    address: { address_1: '60 S High St', city: 'Akron', region: 'OH', postal_code: '44326' }
  },
  organizer: { name: 'Bookworms United' },
  primary_organizer: null
}

// ── 17. Event with venue and organizer objects ────────────────────────────────
export const WITH_VENUE_AND_ORGANIZER = {
  id: '117',
  name: { text: 'Business Networking Breakfast' },
  summary: 'Connect with local entrepreneurs.',
  description: 'Monthly networking breakfast featuring guest speakers.',
  start: { utc: '2026-06-12T07:30:00Z' },
  end: { utc: '2026-06-12T09:00:00Z' },
  is_free: false,
  ticket_availability: {
    is_free: false,
    minimum_ticket_price: { major_value: '25' },
    maximum_ticket_price: null
  },
  ticket_classes: [],
  category_id: '102', // education
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/breakfast-117',
  ticket_url: 'https://www.eventbrite.com/e/breakfast-117',
  primary_venue: {
    name: 'Renaissance Akron',
    address: {
      address_1: '1 Cascade Plaza',
      city: 'Akron',
      region: 'OH',
      postal_code: '44308'
    },
    latitude: 41.0811,
    longitude: -81.5157
  },
  venue: null,
  primary_organizer: {
    name: 'Akron Chamber of Commerce',
    website: 'https://akronchamber.org'
  },
  organizer: null
}

// ── 18. JSON-LD format event (different structure for fallback) ────────────────
export const JSONLD_FORMAT = {
  id: '9876543210',
  name: 'Summer Carnival',
  url: 'https://example.com/carnival',
  start: { utc: '2026-07-12T10:00:00Z' },
  end: { utc: '2026-07-12T20:00:00Z' },
  is_free: true,
  logo: { url: 'https://example.com/carnival.jpg' },
  venue: {
    name: 'City Park',
    address: {
      address_1: '123 Park Ave',
      city: 'Akron',
      region: 'OH',
      postal_code: '44308'
    }
  }
}

// ── 19. Event with min_price / max_price (alternate pricing format) ───────────
export const MIN_MAX_PRICE_FORMAT = {
  id: '118',
  name: { text: 'Cooking Class' },
  summary: 'Learn to cook Italian cuisine.',
  description: 'Professional chef teaches traditional Italian cooking techniques.',
  start: { utc: '2026-06-25T18:00:00Z' },
  end: { utc: '2026-06-25T20:00:00Z' },
  is_free: false,
  ticket_availability: null,
  ticket_classes: [],
  min_price: 45,
  max_price: 65,
  category_id: '110', // food
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/cooking-118',
  ticket_url: 'https://www.eventbrite.com/e/cooking-118',
  venue: {
    name: 'Culinary Arts Center',
    address: { address_1: '400 Wolf Ledges Pkwy', city: 'Akron', region: 'OH', postal_code: '44311' }
  },
  organizer: { name: 'Culinary Institute' },
  primary_organizer: null
}

// ── 20. Event with unknown/unmapped category_id (should default to 'other') ────
export const UNMAPPED_CATEGORY = {
  id: '119',
  name: { text: 'Mystery Event' },
  summary: 'Who knows what this is?',
  description: 'An event with an unmapped category ID.',
  start: { utc: '2026-08-01T12:00:00Z' },
  end: { utc: '2026-08-01T14:00:00Z' },
  is_free: true,
  ticket_availability: { is_free: true },
  ticket_classes: [],
  category_id: '999', // not in EVENTBRITE_CATEGORY_MAP
  image: null,
  logo: null,
  banner_url: null,
  hero_image_url: null,
  url: 'https://www.eventbrite.com/e/mystery-119',
  ticket_url: 'https://www.eventbrite.com/e/mystery-119',
  venue: null,
  organizer: { name: 'Unknown Organizer' },
  primary_organizer: null
}

// Array of all fixtures for batch testing
export const ALL_FIXTURES = [
  COMPLETE_EVENT,
  FREE_EVENT_WITH_CONFIRMATION,
  FREE_FLAG_NO_PRICING_DATA,  // CRITICAL: is_free without backing data
  FREE_FLAG_BUT_PAID_TICKETS,
  MULTIPLE_TICKET_CLASSES,
  NAME_AS_STRING,
  DATE_TIME_SEPARATE,
  START_DATETIME_FORMAT,
  NO_START_TIME,
  DESCRIPTION_AS_OBJECT,
  DESCRIPTION_AS_STRING,
  NO_DESCRIPTION,
  CATEGORY_MUSIC,
  CATEGORY_ART,
  IMAGE_PRIORITY_CHAIN,
  NO_IMAGE,
  WITH_VENUE_AND_ORGANIZER,
  JSONLD_FORMAT,
  MIN_MAX_PRICE_FORMAT,
  UNMAPPED_CATEGORY,
]
