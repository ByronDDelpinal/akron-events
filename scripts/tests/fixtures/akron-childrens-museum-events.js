/**
 * Fixture data for Akron Children's Museum (Drupal HTML scrape) tests.
 *
 * Each fixture simulates the parsed output from parseListingHtml(),
 * representing different edge cases in the Drupal Views HTML structure.
 */

// ── 1. Complete special event with date, time, cost, image ──────────────────
export const SPECIAL_EVENT = {
  title: 'Akron Express Rails & Runways!',
  dates: 'April 25, April 26',
  repeat: null,
  times: '10:00am - 3:00pm',
  cost: null,
  body: 'Join us for the Akron Express Rails & Runways! A 2 day train and plane themed event!',
  category: 'Special Events',
  imageUrl: 'https://akronkids.org/sites/default/files/styles/calendar_thumbnail/public/events/akron-express-rails.jpg',
  detailUrl: 'https://akronkids.org/calendar/special-events/allaboardakronexpress2026',
}

// ── 2. Recurring weekly event ───────────────────────────────────────────────
export const RECURRING_EVENT = {
  title: 'Delight Nights - Every Thursday',
  dates: null,
  repeat: 'Every Thursday',
  times: '5:00pm - 8:00pm',
  cost: 'Cost: Free for members! $8 for regular admission.',
  body: 'It is our DELIGHT to bring you a late night of interactive play and fun with full access to 25 exhibits and a couple of featured surprises!',
  category: 'Programs',
  imageUrl: 'https://akronkids.org/sites/default/files/styles/calendar_thumbnail/public/events/delight-nights.jpg',
  detailUrl: 'https://akronkids.org/calendar/programs/delight-nights-every-thursday',
}

// ── 3. Event with no image ──────────────────────────────────────────────────
export const NO_IMAGE = {
  title: 'Summer Splash Party',
  dates: 'June 20',
  repeat: null,
  times: '10:00am - 2:00pm',
  cost: '$10 per person',
  body: 'Cool off this summer with our annual splash party!',
  category: 'Special Events',
  imageUrl: null,
  detailUrl: 'https://akronkids.org/calendar/special-events/summer-splash',
}

// ── 4. Free event ───────────────────────────────────────────────────────────
export const FREE_EVENT = {
  title: 'Museum Open Play',
  dates: 'May 3',
  repeat: null,
  times: '9:30am - 12:00pm',
  cost: 'Free',
  body: 'Free open play day sponsored by a local business.',
  category: 'Programs',
  imageUrl: 'https://akronkids.org/sites/default/files/events/open-play.jpg',
  detailUrl: 'https://akronkids.org/calendar/programs/open-play',
}

// ── 5. Event with no times ──────────────────────────────────────────────────
export const NO_TIMES = {
  title: 'Holiday Closure',
  dates: 'July 4',
  repeat: null,
  times: null,
  cost: null,
  body: 'The museum will be closed for Independence Day.',
  category: null,
  imageUrl: null,
  detailUrl: null,
}

// ── 6. Event with no dates and no repeat ────────────────────────────────────
export const NO_DATE_NO_REPEAT = {
  title: 'Mystery Event',
  dates: null,
  repeat: null,
  times: '1:00pm - 3:00pm',
  cost: null,
  body: 'A surprise event with date TBD.',
  category: null,
  imageUrl: null,
  detailUrl: null,
}

// ── 7. Recurring Saturday event ─────────────────────────────────────────────
export const RECURRING_SATURDAY = {
  title: 'Saturday Story Time',
  dates: null,
  repeat: 'Every Saturday',
  times: '11:00am - 11:30am',
  cost: 'Free with admission',
  body: 'Join us for a story read by one of our friendly museum educators.',
  category: 'Programs',
  imageUrl: 'https://akronkids.org/sites/default/files/events/storytime.jpg',
  detailUrl: 'https://akronkids.org/calendar/programs/saturday-story-time',
}

// ── 8. Event with HTML entities in title ────────────────────────────────────
export const HTML_ENTITIES = {
  title: "Kids' Art &amp; Crafts Day",
  dates: 'August 15',
  repeat: null,
  times: '10:00am - 1:00pm',
  cost: '$5',
  body: 'A hands-on art day for children ages 3-10.',
  category: 'Special Events',
  imageUrl: null,
  detailUrl: 'https://akronkids.org/calendar/special-events/art-crafts-day',
}

// ── 9. Event with cost containing both free and paid ────────────────────────
export const MIXED_COST = {
  title: 'Family Fun Night',
  dates: 'September 12',
  repeat: null,
  times: '5:00pm - 8:00pm',
  cost: 'Free for members! $8 for non-members, $5 for children',
  body: 'Extended hours with special activities for the whole family.',
  category: 'Special Events',
  imageUrl: 'https://akronkids.org/sites/default/files/events/family-fun.jpg',
  detailUrl: 'https://akronkids.org/calendar/special-events/family-fun-night',
}

// ── 10. Event with relative image URL ───────────────────────────────────────
export const RELATIVE_IMAGE = {
  title: 'Teddy Bear Picnic',
  dates: 'October 3',
  repeat: null,
  times: '10:00am - 12:00pm',
  cost: 'Free with admission',
  body: 'Bring your favorite teddy bear for a picnic in the museum!',
  category: 'Programs',
  imageUrl: '/sites/default/files/events/teddy-bear.jpg',
  detailUrl: 'https://akronkids.org/calendar/programs/teddy-bear-picnic',
}

// ── All fixtures ────────────────────────────────────────────────────────────
export const ALL_FIXTURES = [
  SPECIAL_EVENT,
  RECURRING_EVENT,
  NO_IMAGE,
  FREE_EVENT,
  NO_TIMES,
  NO_DATE_NO_REPEAT,
  RECURRING_SATURDAY,
  HTML_ENTITIES,
  MIXED_COST,
  RELATIVE_IMAGE,
]
