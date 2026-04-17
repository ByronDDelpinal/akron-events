/**Fixture data for University of Akron calendar scraper tests.*/
export const EJ_THOMAS_EVENT = {
  id: 1, title: 'Symphony Orchestra Concert', group_title: 'EJ Thomas Hall', location_title: 'E.J. Thomas Performing Arts Hall',
  date_iso: '2026-05-15T19:00:00-04:00', date2_iso: '2026-05-15T21:30:00-04:00', location_latitude: '41.0756', location_longitude: '-81.5113',
  description: '<p>Annual spring concert</p>', thumbnail: 'https://uakron.edu/concert.jpg', cost: 'Free',
  event_types: [{ name: 'Performance' }], tags: [{ name: 'Music' }],
}

export const GENERAL_UAKRON_EVENT = {
  id: 2, title: 'Student Showcase', group_title: 'Art School', location_title: 'University of Akron',
  date_iso: '2026-06-10T14:00:00-04:00', date2_iso: null, location_latitude: null, location_longitude: null,
  description: '<p>Student art exhibition</p>', thumbnail: null, cost: '$5',
  event_types: [{ name: 'Exhibition' }], tags: [],
}

export const SPORTS_EVENT = {
  id: 3, title: 'Zips Baseball vs Kent', group_title: 'Athletics', location_title: 'Webber Field',
  date_iso: '2026-05-20T18:00:00-04:00', date2_iso: null, location_latitude: '41.088', location_longitude: '-81.516',
  description: '<p>Regular season game</p>', thumbnail: 'https://uakron.edu/baseball.jpg', cost: 'Free',
  event_types: [{ name: 'Athletic Event' }], tags: [{ name: 'Sports' }],
}

export const LECTURE_EVENT = {
  id: 4, title: 'Guest Lecture: Climate Change', group_title: 'Chemistry Department', location_title: 'University of Akron',
  date_iso: '2026-07-08T16:00:00-04:00', date2_iso: null, location_latitude: null, location_longitude: null,
  description: '<p>Dr. Smith discusses climate research</p>', thumbnail: null, cost: 'No charge',
  event_types: [{ name: 'Lecture' }], tags: [{ name: 'Education' }],
}

export const MISSING_TITLE = {
  id: 5, title: '', group_title: 'Student Life', location_title: 'University Center',
  date_iso: '2026-08-01T10:00:00-04:00', date2_iso: null, location_latitude: null, location_longitude: null,
  description: '<p>Details TBD</p>', thumbnail: null, cost: 'Free',
  event_types: [], tags: [],
}

export const MISSING_DATE = {
  id: 6, title: 'Upcoming Event', group_title: 'Student Services', location_title: 'University of Akron',
  date_iso: null, date2_iso: null, location_latitude: null, location_longitude: null,
  description: '<p>Date to be announced</p>', thumbnail: null, cost: 'Free',
  event_types: [], tags: [],
}

export const PAID_EVENT = {
  id: 7, title: 'Summer Music Festival', group_title: 'School of Music', location_title: 'E.J. Thomas Performing Arts Hall',
  date_iso: '2026-07-15T19:00:00-04:00', date2_iso: '2026-07-15T22:00:00-04:00', location_latitude: '41.0756', location_longitude: '-81.5113',
  description: '<p>Three days of musical performances</p>', thumbnail: 'https://uakron.edu/festival.jpg', cost: '$25',
  event_types: [{ name: 'Festival' }], tags: [{ name: 'Music' }, { name: 'Summer' }],
}

export const PERFORMANCE_CONCERT = {
  id: 8, title: 'Chamber Music Recital', group_title: 'School of Music', location_title: 'E.J. Thomas Performing Arts Hall',
  date_iso: '2026-06-20T14:00:00-04:00', date2_iso: '2026-06-20T15:30:00-04:00', location_latitude: '41.0756', location_longitude: '-81.5113',
  description: '<p>Student ensemble performance</p>', thumbnail: 'https://uakron.edu/chamber.jpg', cost: 'Free',
  event_types: [{ name: 'Performance' }, { name: 'Concert' }], tags: [{ name: 'Music' }, { name: 'Student' }],
}

export const MYERS_ART_EVENT = {
  id: 9, title: 'Senior Thesis Exhibition', group_title: 'Myers School of Art', location_title: 'Emily Davis Gallery',
  date_iso: '2026-04-10T17:00:00-04:00', date2_iso: '2026-04-10T20:00:00-04:00', location_latitude: null, location_longitude: null,
  description: '<p>Opening reception for graduating BFA students</p>', thumbnail: 'https://uakron.edu/myers.jpg', cost: 'Free',
  event_types: [{ name: 'Exhibition' }], tags: [{ name: 'Art' }],
}

export const CHP_EVENT = {
  id: 10, title: 'Psychology Collections Tour', group_title: 'Cummings Center for the History of Psychology', location_title: 'Cummings Center',
  date_iso: '2026-05-12T13:00:00-04:00', date2_iso: '2026-05-12T14:00:00-04:00', location_latitude: null, location_longitude: null,
  description: '<p>Guided tour of the archives and museum</p>', thumbnail: null, cost: 'Free',
  event_types: [{ name: 'Tour' }], tags: [{ name: 'Museum' }, { name: 'History' }],
}

// LiveWhale's JSON API serialises the cost field by type. These fixtures
// mirror the shapes observed in production — admins who enter a bare numeric
// value produce cost: 45 (number); tiered pricing (e.g. alumni vs. non-alumni)
// produces cost: [35, 60] (array). Regression guard for the Simonetti Awards
// incident on 2026-04-17 where costStr.trim() crashed on a non-string.
export const NUMERIC_COST_EVENT = {
  id: 11, title: 'The 2026 Dr. Frank L. Simonetti Awards Ceremony', group_title: 'College of Business', location_title: 'Jean Hower Taber Student Union',
  date_iso: '2026-05-01T07:30:00-04:00', date2_iso: '2026-05-01T09:30:00-04:00', location_latitude: null, location_longitude: null,
  description: '<p>Annual alumni awards breakfast</p>', thumbnail: null, cost: 45,
  event_types: [{ name: 'Ceremony' }], tags: [{ name: 'Alumni' }],
}

export const TIERED_COST_EVENT = {
  id: 12, title: 'College Gala — Alumni & Guest Pricing', group_title: 'Alumni Association', location_title: 'University of Akron',
  date_iso: '2026-06-12T18:00:00-04:00', date2_iso: '2026-06-12T22:00:00-04:00', location_latitude: null, location_longitude: null,
  description: '<p>Alumni $35, non-alumni $60</p>', thumbnail: null, cost: [35, 60],
  event_types: [{ name: 'Gala' }], tags: [{ name: 'Alumni' }],
}

export const OBJECT_COST_EVENT = {
  id: 13, title: 'Unknown Structured Cost', group_title: 'Conference Services', location_title: 'University of Akron',
  date_iso: '2026-07-20T09:00:00-04:00', date2_iso: null, location_latitude: null, location_longitude: null,
  description: '<p>Cost returned as an object</p>', thumbnail: null, cost: { amount: 50, tier: 'standard' },
  event_types: [{ name: 'Conference' }], tags: [],
}

export const ALL_FIXTURES = [EJ_THOMAS_EVENT, GENERAL_UAKRON_EVENT, SPORTS_EVENT, LECTURE_EVENT, MISSING_TITLE, MISSING_DATE, PAID_EVENT, PERFORMANCE_CONCERT, MYERS_ART_EVENT, CHP_EVENT, NUMERIC_COST_EVENT, TIERED_COST_EVENT, OBJECT_COST_EVENT]
