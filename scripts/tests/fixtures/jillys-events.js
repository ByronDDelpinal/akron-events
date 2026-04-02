/**
 * Fixture data for Jilly's Music Room scraper tests.
 */

export const COMPLETE_AJAX_EVENT = {
  ID: 100,
  event_title: 'Motown Tribute Band',
  event_start_unix: 1747468800, // 2025-05-15 20:00:00 local ET
  event_start_unix_utc: 1747484400, // UTC equivalent
  event_end_unix: 1747478400, // 4 hours later local
  featured: false,
}

export const COMPLETE_REST_POST = {
  id: 100,
  title: { rendered: 'Motown Tribute Band' },
  content: { rendered: '<p>Classic hits from the Motown era. <a href="https://ticketmaster.com/motown">BUY TICKETS</a></p>' },
  link: 'https://jillysmusicroom.com/event/motown-tribute',
  class_list: ['event_type-music'],
  _embedded: {
    'wp:featuredmedia': [{ source_url: 'https://jillysmusicroom.com/img/motown.jpg' }],
    'wp:term': [[], [{ name: 'Live Music' }, { name: 'Soul' }]],
  },
}

export const FREE_EVENT = {
  ajaxEvent: {
    ID: 101,
    event_title: 'Open Jam Session',
    event_start_unix: 1747552000,
    event_start_unix_utc: 1747567600,
    event_end_unix: 1747559200,
    featured: false,
  },
  restPost: {
    id: 101,
    title: { rendered: 'Open Jam Session' },
    content: { rendered: '<p>All musicians welcome. Free entry.</p>' },
    class_list: ['event_type-music', 'event_type-community'],
    _embedded: {
      'wp:featuredmedia': [{ source_url: 'https://jillysmusicroom.com/img/jam.jpg' }],
      'wp:term': [[], [{ name: 'Jam Session' }]],
    },
  },
}

export const NO_REST_DATA = {
  ajaxEvent: {
    ID: 102,
    event_title: 'Unplugged Night',
    event_start_unix: 1747635200,
    event_start_unix_utc: 1747650800,
    event_end_unix: null,
    featured: false,
  },
  restPost: null, // No REST data available
}

export const FEATURED_EVENT = {
  ajaxEvent: {
    ID: 103,
    event_title: 'Summer Spectacular',
    event_start_unix: 1748000000,
    event_start_unix_utc: 1748015600,
    event_end_unix: 1748008800,
    featured: 'yes',
  },
  restPost: {
    id: 103,
    title: { rendered: 'Summer Spectacular' },
    content: { rendered: '<p>Annual summer event</p>' },
    class_list: ['event_type-music'],
    _embedded: {
      'wp:featuredmedia': [{ source_url: 'https://jillysmusicroom.com/img/summer.jpg' }],
      'wp:term': [[], []],
    },
  },
}

export const HTML_ENTITIES_TITLE = {
  ajaxEvent: {
    ID: 104,
    event_title: 'The &quot;Blues&quot; Brothers &amp; Friends',
    event_start_unix: 1747720000,
    event_start_unix_utc: 1747735600,
    event_end_unix: 1747727200,
    featured: false,
  },
  restPost: {
    id: 104,
    title: { rendered: 'The &quot;Blues&quot; Brothers &amp; Friends' },
    content: { rendered: '<p>Classic blues covers</p>' },
    class_list: ['event_type-music'],
    _embedded: {
      'wp:featuredmedia': [{ source_url: 'https://jillysmusicroom.com/img/blues.jpg' }],
      'wp:term': [[], [{ name: 'Blues' }]],
    },
  },
}

export const FOOD_EVENT = {
  ajaxEvent: {
    ID: 105,
    event_title: 'Jazz & Wine Pairing',
    event_start_unix: 1747804800,
    event_start_unix_utc: 1747820400,
    event_end_unix: 1747812000,
    featured: false,
  },
  restPost: {
    id: 105,
    title: { rendered: 'Jazz & Wine Pairing' },
    content: { rendered: '<p>Live jazz with wine tastings</p>' },
    class_list: ['event_type-food', 'event_type-music'],
    _embedded: {
      'wp:featuredmedia': [{ source_url: 'https://jillysmusicroom.com/img/wine.jpg' }],
      'wp:term': [[], [{ name: 'Wine' }, { name: 'Tasting' }]],
    },
  },
}

export const NO_IMAGE = {
  ajaxEvent: {
    ID: 106,
    event_title: 'Acoustic Set',
    event_start_unix: 1747888000,
    event_start_unix_utc: 1747903600,
    event_end_unix: 1747895200,
    featured: false,
  },
  restPost: {
    id: 106,
    title: { rendered: 'Acoustic Set' },
    content: { rendered: '<p>Intimate acoustic performance</p>' },
    class_list: ['event_type-music'],
    _embedded: {
      'wp:featuredmedia': [],
      'wp:term': [[], []],
    },
  },
}

export const MISSING_START_TIME = {
  ajaxEvent: {
    ID: 107,
    event_title: 'TBD Event',
    event_start_unix: null,
    event_start_unix_utc: null,
    event_end_unix: null,
    featured: false,
  },
  restPost: {
    id: 107,
    title: { rendered: 'TBD Event' },
    content: { rendered: '<p>Details coming soon</p>' },
  },
}

export const WORKSHOP_EVENT = {
  ajaxEvent: {
    ID: 108,
    event_title: 'Music Production Workshop',
    event_start_unix: 1748160000,
    event_start_unix_utc: 1748175600,
    event_end_unix: 1748167200,
    featured: false,
  },
  restPost: {
    id: 108,
    title: { rendered: 'Music Production Workshop' },
    content: { rendered: '<p>Learn music production basics</p>' },
    class_list: ['event_type-workshop'],
    _embedded: {
      'wp:featuredmedia': [{ source_url: 'https://jillysmusicroom.com/img/workshop.jpg' }],
      'wp:term': [[], [{ name: 'Workshop' }, { name: 'Education' }]],
    },
  },
}

export const TICKET_URL_EXTRACTION = {
  ajaxEvent: {
    ID: 109,
    event_title: 'Ticketed Concert',
    event_start_unix: 1748243200,
    event_start_unix_utc: 1748258800,
    event_end_unix: 1748250400,
    featured: false,
  },
  restPost: {
    id: 109,
    title: { rendered: 'Ticketed Concert' },
    content: { rendered: '<p>Get your tickets: <a href="https://eventbrite.com/e/ticketed-concert">GET TICKETS HERE</a></p>' },
    link: 'https://jillysmusicroom.com/event/ticketed',
    class_list: ['event_type-music'],
    _embedded: {
      'wp:featuredmedia': [{ source_url: 'https://jillysmusicroom.com/img/concert.jpg' }],
      'wp:term': [[], [{ name: 'Concert' }]],
    },
  },
}

export const ALL_FIXTURES = [
  { ajax: COMPLETE_AJAX_EVENT, rest: COMPLETE_REST_POST },
  { ajax: FREE_EVENT.ajaxEvent, rest: FREE_EVENT.restPost },
  { ajax: NO_REST_DATA.ajaxEvent, rest: NO_REST_DATA.restPost },
  { ajax: FEATURED_EVENT.ajaxEvent, rest: FEATURED_EVENT.restPost },
  { ajax: HTML_ENTITIES_TITLE.ajaxEvent, rest: HTML_ENTITIES_TITLE.restPost },
  { ajax: FOOD_EVENT.ajaxEvent, rest: FOOD_EVENT.restPost },
  { ajax: NO_IMAGE.ajaxEvent, rest: NO_IMAGE.restPost },
  { ajax: MISSING_START_TIME.ajaxEvent, rest: MISSING_START_TIME.restPost },
  { ajax: WORKSHOP_EVENT.ajaxEvent, rest: WORKSHOP_EVENT.restPost },
  { ajax: TICKET_URL_EXTRACTION.ajaxEvent, rest: TICKET_URL_EXTRACTION.restPost },
]
