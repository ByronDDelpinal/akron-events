/**
 * Fixture data for Akron Library scraper tests.
 *
 * Each fixture represents a distinct permutation of the data structure
 * that the Communico/Libnet API could return. Named to describe what
 * edge case they exercise.
 */

// ── 1. Complete event with all fields populated ──────────────────────────────
export const COMPLETE_EVENT = {
  id: 10001,
  title: 'Maker Monday: 3D Printing Intro',
  description: 'Short description of the event.',
  long_description: '<p>Join us for a <strong>hands-on</strong> introduction to 3D printing.</p>',
  raw_start_time: '2026-05-15 14:00:00',
  raw_end_time:   '2026-05-15 16:00:00',
  location_id:    1,
  location:       'Main Library',
  tags:           'technology,stem',
  age:            'Adults,Teens',
  image:          'maker-monday.jpg',
  url:            'https://akronlibrary.libnet.info/event/10001',
}

// ── 2. Event with HTML entities in title ─────────────────────────────────────
export const HTML_ENTITY_TITLE = {
  id: 10002,
  title: 'Books &amp; Beyond: Author&#8217;s Talk',
  description: 'An evening with the author.',
  long_description: null,
  raw_start_time: '2026-06-01 18:30:00',
  raw_end_time:   '2026-06-01 20:00:00',
  location_id:    2,
  location:       'Highland Square Branch Library',
  tags:           'book',
  age:            'Adults',
  image:          null,
  url:            'https://akronlibrary.libnet.info/event/10002',
}

// ── 3. Event with no description at all ──────────────────────────────────────
export const NO_DESCRIPTION = {
  id: 10003,
  title: 'Drop-In Storytime',
  description: null,
  long_description: null,
  raw_start_time: '2026-04-20 10:30:00',
  raw_end_time:   '2026-04-20 11:00:00',
  location_id:    3,
  location:       'Kenmore Branch Library',
  tags:           'storytime',
  age:            'Baby & Toddler,Preschool',
  image:          'storytime.jpg',
  url:            'https://akronlibrary.libnet.info/event/10003',
}

// ── 4. Event with no start time (should be skipped) ──────────────────────────
export const MISSING_START_TIME = {
  id: 10004,
  title: 'TBD Event',
  description: 'To be announced.',
  long_description: null,
  raw_start_time: null,
  raw_end_time:   null,
  location_id:    1,
  location:       'Main Library',
  tags:           '',
  age:            '',
  image:          null,
  url:            null,
}

// ── 5. Event with empty strings for all optional fields ──────────────────────
export const EMPTY_STRINGS = {
  id: 10005,
  title: 'Mystery Book Club',
  description: '',
  long_description: '',
  raw_start_time: '2026-07-10 19:00:00',
  raw_end_time:   '',
  location_id:    4,
  location:       'Firestone Park Branch Library',
  tags:           '',
  age:            '',
  image:          '',
  url:            '',
}

// ── 6. Event at an UNKNOWN venue (not in BRANCH_INFO) ────────────────────────
export const UNKNOWN_VENUE = {
  id: 10006,
  title: 'Outdoor Yoga in the Park',
  description: 'Bring a mat!',
  long_description: null,
  raw_start_time: '2026-08-05 09:00:00',
  raw_end_time:   '2026-08-05 10:00:00',
  location_id:    99,
  location:       'Hardesty Park',
  tags:           'wellness,yoga',
  age:            'Adults',
  image:          null,
  url:            'https://akronlibrary.libnet.info/event/10006',
}

// ── 7. Event with duplicate URL slashes ──────────────────────────────────────
export const DUPLICATE_SLASHES_URL = {
  id: 10007,
  title: 'Resume Writing Workshop',
  description: 'Get help with your resume.',
  long_description: '<p>Professional resume help.</p>',
  raw_start_time: '2026-05-20 13:00:00',
  raw_end_time:   '2026-05-20 15:00:00',
  location_id:    1,
  location:       'Main Library',
  tags:           'job,career',
  age:            'Adults',
  image:          null,
  url:            'https://akronlibrary.libnet.info//event/10007',
}

// ── 8. Event with rich HTML in long_description ──────────────────────────────
export const RICH_HTML_DESCRIPTION = {
  id: 10008,
  title: 'Summer Reading Kickoff',
  description: 'Join the summer fun!',
  long_description: `
    <h2>Summer Reading 2026</h2>
    <p>It&rsquo;s time for our annual <em>Summer Reading Challenge</em>!</p>
    <ul>
      <li>Read 20 books</li>
      <li>Win prizes &amp; badges</li>
    </ul>
    <p>Open to <strong>all ages</strong>. Register at the front desk.</p>
  `,
  raw_start_time: '2026-06-15 10:00:00',
  raw_end_time:   '2026-06-15 12:00:00',
  location_id:    1,
  location:       'Main Library',
  tags:           'family,community',
  age:            'Baby & Toddler,Preschool,Kids,Tweens,Teens,Adults,Seniors',
  image:          'summer-reading.jpg',
  url:            'https://akronlibrary.libnet.info/event/10008',
}

// ── 9. Event with only short description (no long_description) ───────────────
export const SHORT_DESCRIPTION_ONLY = {
  id: 10009,
  title: 'Teen Gaming Night',
  description: 'Play video games at the library! Snacks provided.',
  long_description: null,
  raw_start_time: '2026-04-25 17:00:00',
  raw_end_time:   '2026-04-25 19:30:00',
  location_id:    5,
  location:       'Ellet Branch Library',
  tags:           'gaming,games & gaming',
  age:            'Teens,Tweens',
  image:          null,
  url:            'https://akronlibrary.libnet.info/event/10009',
}

// ── 10. Event with DST-boundary start time (March 8, 2026 is near DST) ──────
export const DST_BOUNDARY_EVENT = {
  id: 10010,
  title: 'Daylight Saving Time Craft',
  description: 'Make a clock craft!',
  long_description: null,
  raw_start_time: '2026-03-08 01:30:00',
  raw_end_time:   '2026-03-08 03:00:00',
  location_id:    1,
  location:       'Main Library',
  tags:           'arts & crafts',
  age:            'Kids',
  image:          null,
  url:            'https://akronlibrary.libnet.info/event/10010',
}

// ── 11. Event with all age groups ────────────────────────────────────────────
export const ALL_AGE_GROUPS = {
  id: 10011,
  title: 'Community Town Hall',
  description: 'Open forum with city officials.',
  long_description: null,
  raw_start_time: '2026-09-10 18:00:00',
  raw_end_time:   '2026-09-10 20:00:00',
  location_id:    1,
  location:       'Main Library',
  tags:           'community',
  age:            'Baby & Toddler,Preschool,Kids,Tweens,Teens,Adults,Older Adults',
  image:          null,
  url:            'https://akronlibrary.libnet.info/event/10011',
}

// ── 12. Event at a location with null/missing name ───────────────────────────
export const NULL_LOCATION_NAME = {
  id: 10012,
  title: 'Pop-Up Library',
  description: null,
  long_description: null,
  raw_start_time: '2026-05-01 11:00:00',
  raw_end_time:   '2026-05-01 13:00:00',
  location_id:    null,
  location:       null,
  tags:           '',
  age:            '',
  image:          null,
  url:            null,
}

// ── 13. Event with food/cooking category ─────────────────────────────────────
export const FOOD_EVENT = {
  id: 10013,
  title: 'Cooking with Chef Marcus',
  description: 'Learn to cook healthy meals.',
  long_description: '<p>A hands-on cooking class.</p>',
  raw_start_time: '2026-07-20 12:00:00',
  raw_end_time:   '2026-07-20 14:00:00',
  location_id:    1,
  location:       'Main Library',
  tags:           'cooking,food',
  age:            'Adults',
  image:          'chef-marcus.jpg',
  url:            'https://akronlibrary.libnet.info/event/10013',
}

// ── Complete test suite of all fixtures ───────────────────────────────────────
export const ALL_FIXTURES = [
  COMPLETE_EVENT,
  HTML_ENTITY_TITLE,
  NO_DESCRIPTION,
  MISSING_START_TIME,
  EMPTY_STRINGS,
  UNKNOWN_VENUE,
  DUPLICATE_SLASHES_URL,
  RICH_HTML_DESCRIPTION,
  SHORT_DESCRIPTION_ONLY,
  DST_BOUNDARY_EVENT,
  ALL_AGE_GROUPS,
  NULL_LOCATION_NAME,
  FOOD_EVENT,
]
