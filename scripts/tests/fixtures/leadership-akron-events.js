/**
 * Fixture data for Leadership Akron (Squarespace Events Collection) scraper tests.
 *
 * Each fixture represents a distinct permutation of the Squarespace events
 * JSON response structure. Shaped to match the real API responses discovered
 * via `?format=json&view=upcoming`.
 */

// ── 1. Complete event with all fields populated ─────────────────────────────
export const COMPLETE_EVENT = {
  id: '693b06ed3254061779677e65',
  collectionId: 'col-001',
  title: 'Leadership on Main: April 2026',
  urlId: 'apr-26',
  fullUrl: '/lom-2026/apr-26',
  startDate: 1776252600311,  // 2026-04-15T11:30:00.311Z
  endDate: 1776258000311,    // 2026-04-15T13:00:00.311Z
  body: '<p>Speaker: <strong>Alicia Robinson</strong>, Founder &amp; Executive Director, Limitless Ambition</p><p>Moderator: Tiffany Roper, Director of Outreach</p>',
  excerpt: 'Speaker: Alicia Robinson, Founder & Executive Director, Limitless Ambition',
  starred: false,
  tags: [],
  categories: [],
  recordType: 12,
  contentType: 'image/png',
  assetUrl: 'https://images.squarespace-cdn.com/content/v1/5ff33de93fe4fe33db91799e/1774276326635-HEADSHOT.png',
  location: {
    mapZoom: 11,
    mapLat: 41.0781584,
    mapLng: -81.5221205,
    markerLat: 40.7207559,
    markerLng: -74.00076130000002,
    addressTitle: 'The Duck Club by Firestone at 7 17 Credit Union Park',
    addressLine1: '300 South Main Street',
    addressLine2: 'Akron, OH, 44308',
    addressCountry: 'United States',
  },
  structuredContent: {
    _type: 'CalendarEvent',
    startDate: 1776252600311,
    endDate: 1776258000311,
  },
}

// ── 2. Event with no body (only excerpt) ────────────────────────────────────
export const NO_BODY = {
  id: '693b06ed3254061779677e66',
  title: 'Leadership on Main: August 2026',
  urlId: 'aug-26',
  fullUrl: '/lom-2026/aug-26',
  startDate: 1786701000819,  // 2026-08-12T11:30:00.819Z
  endDate: 1786706400819,
  body: null,
  excerpt: 'Details TBA!',
  starred: false,
  tags: [],
  categories: [],
  assetUrl: null,
  location: {
    addressTitle: 'The Duck Club by Firestone at 7 17 Credit Union Park',
    addressLine1: '300 South Main Street',
    addressLine2: 'Akron, OH, 44308',
    addressCountry: 'United States',
  },
}

// ── 3. Event with no location ───────────────────────────────────────────────
export const NO_LOCATION = {
  id: '693b06ed3254061779677e67',
  title: 'Virtual Leadership Workshop',
  urlId: 'virtual-workshop',
  fullUrl: '/lom-2026/virtual-workshop',
  startDate: 1790330600000,
  endDate: 1790336000000,
  body: '<p>A virtual event with no physical location.</p>',
  excerpt: 'A virtual event with no physical location.',
  starred: false,
  tags: ['virtual'],
  categories: [],
  assetUrl: null,
  location: null,
}

// ── 4. Event with empty/minimal location ────────────────────────────────────
export const MINIMAL_LOCATION = {
  id: '693b06ed3254061779677e68',
  title: 'Leadership Mixer',
  urlId: 'mixer',
  fullUrl: '/lom-2026/mixer',
  startDate: 1791540200000,
  endDate: 1791545600000,
  body: '<p>Casual networking event.</p>',
  excerpt: 'Casual networking event.',
  starred: false,
  tags: [],
  categories: [],
  assetUrl: 'https://images.squarespace-cdn.com/content/v1/5ff33de93fe4fe33db91799e/mixer.jpg',
  location: {
    addressTitle: 'Akron Civic Theatre',
    addressLine1: '182 S Main St',
    addressLine2: 'Akron, OH, 44308',
    addressCountry: 'United States',
  },
}

// ── 5. Event with no start date ─────────────────────────────────────────────
export const NO_START_DATE = {
  id: '693b06ed3254061779677e69',
  title: 'Placeholder Event',
  urlId: 'placeholder',
  fullUrl: '/lom-2026/placeholder',
  startDate: null,
  endDate: null,
  body: '<p>Date TBD</p>',
  excerpt: 'Date TBD',
  starred: false,
  tags: [],
  categories: [],
  assetUrl: null,
  location: null,
}

// ── 6. Starred / featured event ─────────────────────────────────────────────
export const FEATURED_EVENT = {
  id: '693b06ed3254061779677e70',
  title: 'Leadership on Main: Annual Gala',
  urlId: 'gala-2026',
  fullUrl: '/lom-2026/gala-2026',
  startDate: 1795170600000,
  endDate: 1795181400000,
  body: '<p>Annual celebration of community leadership.</p>',
  excerpt: 'Annual celebration of community leadership.',
  starred: true,
  tags: ['gala', 'annual'],
  categories: ['community'],
  assetUrl: 'https://images.squarespace-cdn.com/content/v1/5ff33de93fe4fe33db91799e/gala.jpg',
  location: {
    addressTitle: 'The Duck Club by Firestone at 7 17 Credit Union Park',
    addressLine1: '300 South Main Street',
    addressLine2: 'Akron, OH, 44308',
    addressCountry: 'United States',
  },
}

// ── 7. Event with HTML entities in title ────────────────────────────────────
export const HTML_ENTITIES_TITLE = {
  id: '693b06ed3254061779677e71',
  title: 'Leadership Akron&#8217;s Annual Review &amp; Town Hall',
  urlId: 'annual-review',
  fullUrl: '/lom-2026/annual-review',
  startDate: 1798800600000,
  endDate: 1798806000000,
  body: '<p>Reviewing the year&#8217;s accomplishments &amp; planning ahead.</p>',
  excerpt: "Reviewing the year's accomplishments & planning ahead.",
  starred: false,
  tags: [],
  categories: [],
  assetUrl: null,
  location: {
    addressTitle: 'The Duck Club by Firestone at 7 17 Credit Union Park',
    addressLine1: '300 South Main Street',
    addressLine2: 'Akron, OH, 44308',
    addressCountry: 'United States',
  },
}

// ── 8. Event with different venue (December event at Akron Art Museum) ──────
export const DIFFERENT_VENUE = {
  id: '693b06ed3254061779677e72',
  title: 'Leadership on Main: December 2026',
  urlId: 'dec-26',
  fullUrl: '/lom-2026/dec-26',
  startDate: 1812844800000,  // different time (4 PM slot)
  endDate: 1812850200000,
  body: '<p>Speaker: Jon Fiume, John S. Knight Executive Director &amp; CEO, Akron Art Museum</p>',
  excerpt: 'Speaker: Jon Fiume',
  starred: false,
  tags: [],
  categories: [],
  assetUrl: 'https://images.squarespace-cdn.com/content/v1/5ff33de93fe4fe33db91799e/dec-speaker.jpg',
  location: {
    addressTitle: 'Akron Art Museum',
    addressLine1: '1 S High St',
    addressLine2: 'Akron, OH, 44308',
    addressCountry: 'United States',
  },
}

// ── 9. Event with addressLine2 missing zip ──────────────────────────────────
export const NO_ZIP_IN_ADDRESS = {
  id: '693b06ed3254061779677e73',
  title: 'Leadership Brunch',
  urlId: 'brunch',
  fullUrl: '/lom-2026/brunch',
  startDate: 1800615000000,
  endDate: 1800620400000,
  body: '<p>A brunch event.</p>',
  excerpt: 'A brunch event.',
  starred: false,
  tags: [],
  categories: [],
  assetUrl: null,
  location: {
    addressTitle: 'Some Venue',
    addressLine1: '123 Main St',
    addressLine2: 'Akron, OH',
    addressCountry: 'United States',
  },
}

// ── 10. Event with addressLine2 in unusual format ───────────────────────────
export const UNUSUAL_ADDRESS_FORMAT = {
  id: '693b06ed3254061779677e74',
  title: 'Community Dialogue',
  urlId: 'dialogue',
  fullUrl: '/lom-2026/dialogue',
  startDate: 1802429400000,
  endDate: 1802434800000,
  body: '<p>Open community discussion.</p>',
  excerpt: 'Open community discussion.',
  starred: false,
  tags: [],
  categories: [],
  assetUrl: null,
  location: {
    addressTitle: 'Downtown Library',
    addressLine1: '60 S High St',
    addressLine2: 'Akron, OH 44326',
    addressCountry: 'United States',
  },
}

// ── All fixtures ────────────────────────────────────────────────────────────
export const ALL_FIXTURES = [
  COMPLETE_EVENT,
  NO_BODY,
  NO_LOCATION,
  MINIMAL_LOCATION,
  NO_START_DATE,
  FEATURED_EVENT,
  HTML_ENTITIES_TITLE,
  DIFFERENT_VENUE,
  NO_ZIP_IN_ADDRESS,
  UNUSUAL_ADDRESS_FORMAT,
]
