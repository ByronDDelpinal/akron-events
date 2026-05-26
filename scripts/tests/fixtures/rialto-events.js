/**
 * fixtures/rialto-events.js
 *
 * Representative Squarespace event objects for The Rialto Theatre,
 * modelled after the live /calendar?format=json&view=upcoming response.
 *
 * Covers every event type the scraper must handle:
 *   music show, Living Room acoustic set, poetry, improv, Irish session,
 *   trivia, open mic, featured event, image, no body, no start date.
 */

// ── Shared venue location (all Rialto events happen here) ─────────────────

const RIALTO_LOCATION = {
  addressTitle: 'The Rialto Theatre',
  addressLine1: '1000 Kenmore Boulevard',
  addressLine2: 'Akron, OH, 44314',
  markerLat:    41.0534,
  markerLng:    -81.5598,
}

// ── Fixtures ──────────────────────────────────────────────────────────────

/** Standard multi-band music show with image and body. */
export const MUSIC_SHOW = {
  id:        'rialto-001',
  urlId:     'stay-gone-05272026',
  title:     'Stay Gone / STMNTS / Bury The Pines - 05/27/2026',
  startDate: 1779922800083,
  endDate:   1779936000000,
  fullUrl:   '/calendar/2026/5/27/stay-gone-stmnts-bury-the-pines-05272026',
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/58b72f835016e151ebd64e18/1774979434740-Q6OMBN886YA4YUSINL91/thumb.png',
  body:      '<p>Three great bands hit the stage at <strong>The Rialto</strong>. Doors at 7pm, show at 8pm.</p>',
  excerpt:   null,
  sourceUrl: '',
  starred:   false,
  location:  RIALTO_LOCATION,
}

/** Intimate acoustic set in The Rialto Living Room. */
export const LIVING_ROOM_SHOW = {
  id:        'rialto-002',
  urlId:     'colin-john-05292026',
  title:     'Colin John - The Transpacific Bluesman in The Rialto Living Room - 05/29/2026',
  startDate: 1780095600000,
  endDate:   1780108800000,
  fullUrl:   '/calendar/2026/5/29/colin-john-living-room-05292026',
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/58b72f835016e151ebd64e18/colin-thumb.jpg',
  body:      '<p>An intimate evening of blues in the Living Room. Colin John brings the Pacific to Kenmore.</p>',
  excerpt:   null,
  sourceUrl: '',
  starred:   false,
  location:  RIALTO_LOCATION,
}

/** Monthly poetry open mic — should map to category 'art'. */
export const POETRY_EVENT = {
  id:        'rialto-003',
  urlId:     'angry-cow-06032026',
  title:     'Angry Cow Poetry Ft. Raja Belle Freeman - 06/03/2026',
  startDate: 1780614000000,
  endDate:   1780628400000,
  fullUrl:   '/calendar/2026/6/3/angry-cow-poetry-06032026',
  assetUrl:  null,
  body:      '<p>First Wednesday spoken word open mic. Featured poet: Raja Belle Freeman.</p>',
  excerpt:   null,
  sourceUrl: '',
  starred:   false,
  location:  RIALTO_LOCATION,
}

/** Improv comedy show — should map to category 'community'. */
export const IMPROV_EVENT = {
  id:        'rialto-004',
  urlId:     'improv-06042026',
  title:     'Point of No Return Improv - 06/04/2026',
  startDate: 1780700400000,
  endDate:   1780714800000,
  fullUrl:   '/calendar/2026/6/4/point-of-no-return-improv-06042026',
  assetUrl:  null,
  body:      null,
  excerpt:   'Live improv comedy — no two shows are alike.',
  sourceUrl: '',
  starred:   false,
  location:  RIALTO_LOCATION,
}

/** Traditional Irish jam session — music category with irish tags. */
export const IRISH_SESSION = {
  id:        'rialto-005',
  urlId:     'irish-jam-06022026',
  title:     'Irish Jam Session! - 06/02/2026',
  startDate: 1780527600000,
  endDate:   null,
  fullUrl:   '/calendar/2026/6/2/irish-jam-session-06022026',
  assetUrl:  null,
  body:      '<p>Bring your instrument and join the craic every Tuesday evening.</p>',
  excerpt:   null,
  sourceUrl: '',
  starred:   false,
  location:  RIALTO_LOCATION,
}

/** Trivia night — should map to category 'community'. */
export const TRIVIA_EVENT = {
  id:        'rialto-006',
  urlId:     'trivia-06102026',
  title:     'TRIVIA NIGHT - 06/10/2026',
  startDate: 1781218800000,
  endDate:   1781232000000,
  fullUrl:   '/calendar/2026/6/10/trivia-night-06102026',
  assetUrl:  null,
  body:      null,
  excerpt:   'Ohio and Akron trivia. Five categories. One winner.',
  sourceUrl: '',
  starred:   false,
  location:  RIALTO_LOCATION,
}

/** Open mic night — music with open-mic tag. */
export const OPEN_MIC_EVENT = {
  id:        'rialto-007',
  urlId:     'open-mic-06172026',
  title:     'Open Mic Night at the Rialto - 06/17/2026',
  startDate: 1781823600000,
  endDate:   null,
  fullUrl:   '/calendar/2026/6/17/open-mic-06172026',
  assetUrl:  null,
  body:      '<p>Sign up at the door. 3 songs / 10 minutes per performer.</p>',
  excerpt:   null,
  sourceUrl: '',
  starred:   false,
  location:  RIALTO_LOCATION,
}

/** Starred (featured) event. */
export const FEATURED_EVENT = {
  id:        'rialto-008',
  urlId:     'big-show-07042026',
  title:     'Independence Day Blowout w/ Headliner - 07/04/2026',
  startDate: 1783032000000,
  endDate:   1783053600000,
  fullUrl:   '/calendar/2026/7/4/independence-day-blowout-07042026',
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/58b72f835016e151ebd64e18/july4-thumb.jpg',
  body:      '<p>The biggest show of the summer.</p>',
  excerpt:   null,
  sourceUrl: '',
  starred:   true,
  location:  RIALTO_LOCATION,
}

/** Event with no body — should fall back to excerpt. */
export const NO_BODY_EVENT = {
  id:        'rialto-009',
  urlId:     'no-body-06242026',
  title:     'Emerging Sounds: Local Lineup TBA - 06/24/2026',
  startDate: 1782428400000,
  endDate:   null,
  fullUrl:   '/calendar/2026/6/24/emerging-sounds-06242026',
  assetUrl:  null,
  body:      null,
  excerpt:   'Details coming soon.',
  sourceUrl: '',
  starred:   false,
  location:  RIALTO_LOCATION,
}

/** Event missing startDate — scraper should skip it. */
export const NO_START_DATE = {
  id:        'rialto-010',
  urlId:     'no-date',
  title:     'TBA - Date TBD',
  startDate: null,
  endDate:   null,
  fullUrl:   '/calendar/tba',
  assetUrl:  null,
  body:      null,
  excerpt:   'Date to be announced.',
  sourceUrl: '',
  starred:   false,
  location:  RIALTO_LOCATION,
}

/** Event with HTML entities in the title. */
export const HTML_ENTITIES_TITLE = {
  id:        'rialto-011',
  urlId:     'entities-06302026',
  title:     "Bryan&#8217;s Last Waltz &amp; Friends - 06/30/2026",
  startDate: 1783000000000,
  endDate:   null,
  fullUrl:   '/calendar/2026/6/30/bryans-last-waltz-06302026',
  assetUrl:  null,
  body:      '<p>An evening of covers &amp; originals.</p>',
  excerpt:   null,
  sourceUrl: '',
  starred:   false,
  location:  RIALTO_LOCATION,
}

/** All fixtures — used for batch invariant tests. */
export const ALL_FIXTURES = [
  MUSIC_SHOW,
  LIVING_ROOM_SHOW,
  POETRY_EVENT,
  IMPROV_EVENT,
  IRISH_SESSION,
  TRIVIA_EVENT,
  OPEN_MIC_EVENT,
  FEATURED_EVENT,
  NO_BODY_EVENT,
  NO_START_DATE,
  HTML_ENTITIES_TITLE,
]
