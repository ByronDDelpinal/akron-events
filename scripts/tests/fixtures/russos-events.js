/**
 * Fixtures for the Russo's Restaurant (Bacchus Patio) scraper tests.
 *
 * Shape mirrors real Squarespace Events collection items from
 * russosbacchus.com/events?format=json&view=upcoming, captured 2026-07-09:
 * epoch-ms startDate/endDate, HTML body, location object, fullUrl, assetUrl.
 *
 * Sanitization note: values (ids, titles, dates, location, fullUrl, assetUrl,
 * body text) are real. The body HTML wrapper was re-assembled from the feed's
 * captured tag structure (div > p/strong/a) plus the captured plain text,
 * because the raw HTML string could not be exported verbatim; the Squarespace
 * layout <div> chrome around the paragraphs was dropped.
 *
 * Real-feed quirks preserved on purpose:
 *  - location.addressLine2 is just "Peninsula" (no state/zip), so
 *    parseSquarespaceLocation cannot derive city/state/zip.
 *  - addressTitle carries an HTML entity: "Russo&#39;s Restaurant".
 *  - excerpt is an empty string; tags/categories are empty arrays.
 *  - Some titles carry a trailing "(Copy)" from duplicated CMS pages.
 *  - Epoch-ms dates have a non-zero ms fraction (e.g. …674).
 */

const RUSSOS_LOCATION = {
  mapZoom:        12,
  mapLat:         41.2022579,
  mapLng:         -81.495774,
  markerLat:      41.2022579,
  markerLng:      -81.495774,
  addressTitle:   'Russo&#39;s Restaurant',
  addressLine1:   '4895 State Rd',
  addressLine2:   'Peninsula',
  addressCountry: 'United States',
}

export const JOSEE_MCGEE = {
  id:        '6a12219e2adf244805b6d381',
  urlId:     'joseemcgee',
  title:     'Josee McGee Live at Russo’s Bacchus Patio',
  startDate: 1784152800674, // 2026-07-15T22:00:00.674Z — Wed 6:00 PM EDT
  endDate:   1784160000674, // 2026-07-16T00:00:00.674Z — Wed 8:00 PM EDT
  body:      '<div><p><strong>No cover</strong> • Reserve your table: <a href="tel:3309232665">(330) 923-2665</a></p><p><strong>Josee McGee</strong> brings an eclectic blend of soulful vocals, acoustic favorites, and heartfelt originals to the Bacchus Bar Patio at Russo’s Restaurant. Enjoy live music, dinner, cocktails, and summer patio atmosphere.</p></div>',
  excerpt:   '',
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/5d03da8bee4baf0001f6dd0c/1779573249422-5TLNGUV7R82KM8BPG025/Josee.webp',
  fullUrl:   '/events/joseemcgee',
  sourceUrl: '',
  location:  RUSSOS_LOCATION,
  tags:      [],
  categories: [],
  starred:   false,
}

export const VINCENT_RUBY = {
  id:        '6a12223e4be6a2244ce489ee',
  urlId:     'vincentruby',
  title:     'Vincent Ruby Live at Russo’s Bacchus Patio',
  startDate: 1784757600554, // 2026-07-22T22:00:00.554Z — Wed 6:00 PM EDT
  endDate:   1784764800554, // 2026-07-23T00:00:00.554Z — Wed 8:00 PM EDT
  body:      '<div><p><strong>No cover</strong> • Reserve your table: <a href="tel:3309232665">(330) 923-2665</a></p><p><strong>Vincent Ruby</strong> brings an engaging mix of acoustic rock, Americana, and familiar favorites to the Bacchus Bar Patio at Russo’s Restaurant. Enjoy live music, dinner, cocktails, and summer patio atmosphere.</p></div>',
  excerpt:   '',
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/5d03da8bee4baf0001f6dd0c/1779573468828-PPPJ5W1LLQFY3TJ6Z7XD/Vincent+ruby.jpg',
  fullUrl:   '/events/vincentruby',
  sourceUrl: '',
  location:  RUSSOS_LOCATION,
  tags:      [],
  categories: [],
  starred:   false,
}

// Real item with the CMS "(Copy)" title artifact (duplicated page, extra
// internal spacing preserved as captured).
export const JEN_MAURER_COPY = {
  id:        '6a1224f7ca5f313c7f9832a0',
  urlId:     'jenmaurer-dbk8z',
  title:     'Jen Maurer Live on the Bacchus Patio  (Copy)',
  startDate: 1787176800341, // 2026-08-19T22:00:00.341Z — Wed 6:00 PM EDT
  endDate:   1787184000341, // 2026-08-20T00:00:00.341Z — Wed 8:00 PM EDT
  body:      '<div><p><strong>No cover</strong> • Reserve your table: <a href="tel:3309232665">(330) 923-2665</a></p><p><strong>Jen Maurer</strong> returns to the Bacchus Bar Patio at Russo’s Restaurant with her soulful blend of Americana, folk, and acoustic favorites. Enjoy live music, dinner, cocktails, and summer patio atmosphere.</p></div>',
  excerpt:   '',
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/5d03da8bee4baf0001f6dd0c/1779572331209-ORG11QQAFR3OR0L5U5JF/Jen+Mauer.jpg',
  fullUrl:   '/events/jenmaurer-dbk8z',
  sourceUrl: '',
  location:  RUSSOS_LOCATION,
  tags:      [],
  categories: [],
  starred:   false,
}

// Edge case: feed item with no startDate (scraper must skip it).
export const NO_START_DATE = {
  id:       'no0start0date0000000001',
  title:    'Live Music, TBA',
  startDate: null,
  body:     '<p>Date to be announced.</p>',
  fullUrl:  '/events/tba',
  location: RUSSOS_LOCATION,
}

// Edge case: a past-dated item (upcoming view should not return these, but
// the scraper keeps a past-start guard). Same shape as the real items.
export const PAST_EVENT = {
  id:        '6a1220000000000000000000',
  urlId:     'pastshow',
  title:     'Past Show Live at Russo’s Bacchus Patio',
  startDate: 1751500800000, // 2025-07-03 — long past
  endDate:   1751508000000,
  body:      '<div><p><strong>No cover</strong></p></div>',
  excerpt:   '',
  fullUrl:   '/events/pastshow',
  location:  RUSSOS_LOCATION,
  starred:   false,
}

export const ALL_FIXTURES = [JOSEE_MCGEE, VINCENT_RUBY, JEN_MAURER_COPY, NO_START_DATE, PAST_EVENT]
