/**
 * Fixtures for the Barnes & Noble (Akron, store #2902) scraper.
 *
 * Captured 2026-07-14 from the live endpoint:
 *   GET https://stores.barnesandnoble.com/locator-api/v1/events?lat=41.136137&lng=-81.641904&size=1000
 * Trimmed to the fields the scraper reads; `largeIcon` query strings dropped.
 * Includes an event from a NEIGHBORING store (Strongsville #3577) to exercise
 * the store filter, plus a synthetic past event and a no-time24 event to cover
 * the date-window and time-fallback rules.
 */

// Weekly kids storytime at the Akron store (typeCode ST) → is_family.
export const STORYTIME = {
  eventId: '9780062190695-55',
  name: 'Story Time',
  date: '2026-07-15',
  time: '10:00 AM',
  time24: '10:00',
  weekday: 4,
  descriptionText: "Join us in the Children's Department every Wed. and Sat. at 10am for a fun filled story time!",
  storeId: 2902,
  storeName: 'Akron',
  storeAddress1: '4015 Medina Road',
  city: 'Akron', state: 'OH', zip: '44333',
  timeZone: 'Eastern',
  isStoryTime: true,
  types: [{ typeCode: 'ST', text: 'Storytime', displayOrder: 1 }],
  isNationalEvent: false,
  isVirtualEvent: false,
  isInstoreEvent: true,
}

// Monthly fiction book club (typeCode 56).
export const BOOK_CLUB = {
  eventId: '9780062157887-38',
  name: 'B&N Book Club',
  date: '2026-07-14',
  time: '7:00 PM',
  time24: '19:00',
  weekday: 3,
  descriptionText: "Our Fiction Book Club meets the 2nd Tuesday of every month at 7pm! Call the store or check Facebook for this month's pick!",
  storeId: 2902,
  storeName: 'Akron',
  city: 'Akron', state: 'OH', zip: '44333',
  timeZone: 'Eastern',
  isStoryTime: false,
  types: [{ typeCode: '56', text: 'Book Club', displayOrder: 1 }],
  isNationalEvent: false,
  isVirtualEvent: false,
  isInstoreEvent: true,
}

// Author signing (typeCode SP — "Special Event" at B&N covers author talks).
export const AUTHOR_SIGNING = {
  eventId: '9780062216245-0',
  name: 'Book Signing & Discussion with Linda Castillo',
  date: '2026-07-19',
  time: '1:00 PM',
  time24: '13:00',
  weekday: 1,
  descriptionText: 'We are thrilled to host the New York Bestselling author, Linda Castillo for a talk and signing to celebrate her upcoming release, "A Dark Path".',
  storeId: 2902,
  storeName: 'Akron',
  city: 'Akron', state: 'OH', zip: '44333',
  timeZone: 'Eastern',
  isStoryTime: false,
  types: [{ typeCode: 'SP', text: 'Special Event', displayOrder: 1 }],
  isNationalEvent: false,
  isVirtualEvent: false,
  isInstoreEvent: true,
}

// Time supplied only as a 12-hour string (no time24) — exercises the fallback.
export const NO_TIME24 = {
  eventId: '9780062181053-18',
  name: 'Sci Fi & Fantasy Book Club',
  date: '2026-07-15',
  time: '7:00 PM',
  time24: null,
  storeId: 2902,
  storeName: 'Akron',
  city: 'Akron', state: 'OH', zip: '44333',
  isStoryTime: false,
  types: [{ typeCode: '56', text: 'Book Club', displayOrder: 1 }],
  isNationalEvent: false,
  isVirtualEvent: false,
  isInstoreEvent: true,
}

// Neighboring store — must be filtered out by storeId.
export const OTHER_STORE = {
  eventId: '9780062206018-19',
  name: 'Toddler Tuesday Storytime',
  date: '2026-07-14',
  time24: '11:00',
  storeId: 3577,
  storeName: 'Strongsville',
  city: 'Strongsville', state: 'OH', zip: '44136',
  isStoryTime: true,
  types: [{ typeCode: 'ST', text: 'Storytime', displayOrder: 1 }],
  isNationalEvent: false,
  isVirtualEvent: false,
  isInstoreEvent: true,
}

// Past occurrence at the Akron store — must be dropped by the date window.
export const PAST_EVENT = {
  eventId: '9780062157887-33',
  name: 'B&N Book Club',
  date: '2026-05-13',
  time24: '19:00',
  storeId: 2902,
  storeName: 'Akron',
  city: 'Akron', state: 'OH', zip: '44333',
  isStoryTime: false,
  types: [{ typeCode: '56', text: 'Book Club', displayOrder: 1 }],
  isNationalEvent: false,
  isVirtualEvent: false,
  isInstoreEvent: true,
}

export const ALL_CONTENT = [
  STORYTIME, BOOK_CLUB, AUTHOR_SIGNING, NO_TIME24, OTHER_STORE, PAST_EVENT,
]
