/**
 * Fixtures for the Akron Fossils & Science Center scraper tests.
 *
 * Captured from the live Squarespace Events collection
 * (https://www.akronfossils.org/events?format=json&view=upcoming) on
 * 2026-07-14. The `body` fields are trimmed to their meaningful paragraph
 * HTML — the live feed wraps this in Squarespace layout <div>/<style> blocks
 * that stripHtml discards, so the trimmed form produces identical descriptions
 * while keeping the fixture readable. `location` and epoch dates are verbatim.
 */

const MUSEUM_LOCATION = {
  mapZoom:        12,
  mapLat:         41.0814904,
  mapLng:         -81.6433838,
  markerLat:      41.0814904,
  markerLng:      -81.6433838,
  addressTitle:   'Akron Fossils &amp; Science Center',
  addressLine1:   '2080 South Cleveland Massillon Road',
  addressLine2:   'Akron, OH, 44321',
  addressCountry: 'United States',
}

// Kids' day camp — themed art camp, multi-day (Mon–Fri). is_family + learning.
export const CAMP = {
  id:        '6980e02e6bcfd20edbf3d036',
  urlId:     'aspiring-artists-camp-1',
  fullUrl:   '/events/aspiring-artists-camp-1',
  title:     'Aspiring Artists Camp',
  startDate: 1783947600151,
  endDate:   1784322000151,
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/5e41c4ed5ae4ac656412e50f/1770053843910-O5X230NKLYV7AVPBXVXQ/5.png',
  excerpt:   '<p><strong>Aspiring Artists Camp - Art Through the Ages.July 13th - July 17th</strong>. Examine how art has shaped our world throughout history and create your own masterpieces inspired by the past.</p>',
  body:      '<p><strong>Aspiring Artists Camp - Art Through the Ages.July 13th - July 17th</strong>. Examine how art has shaped our world throughout history and create your own masterpieces inspired by the past.</p><p>Akron Fossils and Science Center offers 7 weeks of camps. Each week features a new theme, with fun and educational activities and hands-on learning opportunities. Our summer camps run Monday through Friday, 9:00am to 5:00pm. There are all-day and half-day sessions, and before and after care is available for an additional fee. For more information and to register, <a href="https://www.akronfossils.org/day-camps">Click HERE</a>.</p>',
  location:  MUSEUM_LOCATION,
  starred:   false,
}

// STEM day camp. is_family + learning; note the dotted "S.T.E.A.M." title.
export const STEAM_CAMP = {
  id:        '6980e18010b4b07b667bec4f',
  urlId:     'steam-camp-2',
  fullUrl:   '/events/steam-camp-2',
  title:     'S.T.E.A.M. Camp',
  startDate: 1785157200456,
  endDate:   1785531600456,
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/5e41c4ed5ae4ac656412e50f/1770054503468-GDWNU7F27L6TVWLYWXL0/7.png',
  excerpt:   '<p><strong>S.T.E.A.M. Camp - The S.T.E.A.M. of the Scene. July 27th - July 31st</strong>. Step behind the scenes and explore the S.T.E.A.M. of filmmaking.</p>',
  body:      '<p><strong>S.T.E.A.M. Camp - The S.T.E.A.M. of the Scene.July 27th - July 31st</strong>. Step behind the scenes and explore the S.T.E.A.M. of filmmaking. Learn how science, technology, engineering, art, and mathematics play a role in bringing stories to life.</p>',
  location:  MUSEUM_LOCATION,
  starred:   false,
}

// Drop-in family science day. is_family + learning. Price stated in prose.
export const SUPER_SCIENCE = {
  id:        '694f13d5ca5d1e085c72328f',
  urlId:     'super-science-saturday-wacky-weather',
  fullUrl:   '/events/super-science-saturday-wacky-weather',
  title:     'Super Science Saturday - Wacky Weather',
  startDate: 1784385000484,
  endDate:   1784403000484,
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/5e41c4ed5ae4ac656412e50f/1766790297138-BD988XZ4JNDQNQYSFWBT/7.png',
  excerpt:   '<p>Did you know that there is some wacky science behind our weather? Explore with us on <strong>Saturday, July 18th from 10:30am to 3:30pm</strong>, as we take a look at storms, tornados, hurricanes and more! Cost is $18 per non-member/$12 per member.</p>',
  body:      '<p>Did you know that there is some wacky science behind our weather? Explore with us on <strong>Saturday, July 18th from 10:30am to 3:30pm</strong>, as we take a look at storms, tornados, hurricanes and more! Cost is $18 per non-member/$12 per member. Learn more or sign-up <a href="https://www.akronfossils.org/super-science-saturday">HERE.</a></p>',
  location:  MUSEUM_LOCATION,
  starred:   false,
}

// Adults-only craft night — NOT family. Category left to inference (visual-art).
export const ADULT_CRAFT = {
  id:        '6a3d99857b044e26ad17699b',
  urlId:     'adult-craft-night-nature-art-prints',
  fullUrl:   '/events/adult-craft-night-nature-art-prints',
  title:     'Adult Craft Night - Nature Art Prints',
  startDate: 1786053600651,
  endDate:   1786060800651,
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/5e41c4ed5ae4ac656412e50f/1782422013346-5SUQBOOPRBWEG1B54E75/AdultCraftNight_8%3A26.png',
  excerpt:   '<p>Discover the art of nature! Join us on <strong>Thursday, August 6th from 6:00pm to 8:00pm</strong> for a relaxing, hands-on printmaking craft night. No experience needed. All supplies are provided.</p>',
  body:      '<p>Discover the art of nature! Join us on <strong>Thursday, August 6th from 6:00pm to 8:00pm</strong> for a relaxing, hands-on printmaking craft night where you\'ll gather natural materials and create a one-of-a-kind botanical print. No experience needed. All supplies are provided. Come connect with nature and leave with your own beautiful work of art. Register <a href="/craft-class-registration">HERE</a>.</p>',
  location:  MUSEUM_LOCATION,
  starred:   false,
}

// Annual golf-outing fundraiser. Category left to inference (sports/fundraiser).
export const GOLF = {
  id:        '69f397f3b5af9e4290703584',
  urlId:     '7th-annual-golf-outing-fundraiser',
  fullUrl:   '/events/7th-annual-golf-outing-fundraiser',
  title:     '7th Annual Golf Outing Fundraiser',
  startDate: 1789213500158,
  endDate:   1789236000158,
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/5e41c4ed5ae4ac656412e50f/1777571927495-ZTLODJ1DG4WWL7ODA5ZH/Golf+Outing+2026.png',
  excerpt:   '<p>Save the Date! This year’s 7th annual Golf Outing Fundraiser will be held on <strong>Saturday, September 12th</strong>. Enjoy some fresh air, good food, and amazing company- all while supporting a good cause!</p>',
  body:      '<p>Save the Date! This year’s 7th annual Golf Outing Fundraiser will be held on <strong>Saturday, September 12th</strong>. Enjoy some fresh air, good food, and amazing company- all while supporting a good cause! More details to come, so check back soon.</p>',
  location:  MUSEUM_LOCATION,
  starred:   false,
}

// Multi-day wilderness trip. Category left to inference (outdoors).
export const CANOE = {
  id:        '69de9d31caeeb503539a67b9',
  urlId:     'boundary-waters-canoe-trip-smt4a-yjcn3',
  fullUrl:   '/events/boundary-waters-canoe-trip-smt4a-yjcn3',
  title:     'Boundary Waters Canoe Trip',
  startDate: 1783940400249,
  endDate:   1784581200249,
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/5e41c4ed5ae4ac656412e50f/1776196991472-EUP3S4M2T837O6E5XN34/AFSC+Canoe+Trip+Graphic.png',
  excerpt:   '<p>Five days in the untamed Minnesota-Canadian Boundary Waters. Canoeing, backpacking, hiking, and more.</p>',
  body:      '<p>Five days in the untamed Minnesota-Canadian Boundary Waters…Every year, we take a group of participants to experience this amazing unplugged wilderness for themselves. Canoeing, backpacking, hiking, and more … what could be better?</p><p>This year’s trip will depart <strong>on Monday, July 13th, and return on Monday, July 20th</strong>.</p>',
  location:  MUSEUM_LOCATION,
  starred:   false,
}

// ── Synthetic edge cases ────────────────────────────────────────────────────

// Body missing → description falls back to plain-text excerpt.
export const NO_BODY_EVENT = {
  id:        'no-body-001',
  urlId:     'homeschool-science-day',
  fullUrl:   '/events/homeschool-science-day',
  title:     'Homeschool Science Day',
  startDate: 1784385000000,
  endDate:   1784403000000,
  assetUrl:  null,
  excerpt:   'Details coming soon.',
  body:      null,
  location:  MUSEUM_LOCATION,
  starred:   false,
}

// No start date → row must be skipped (start_at null).
export const NO_START_DATE = {
  id:        'no-start-001',
  urlId:     'save-the-date',
  fullUrl:   '/events/save-the-date',
  title:     'Save the Date',
  startDate: null,
  endDate:   null,
  excerpt:   'Coming soon.',
  body:      null,
  location:  MUSEUM_LOCATION,
  starred:   false,
}

// HTML entities in title → must be decoded by sanitizeEventText.
export const HTML_ENTITIES_TITLE = {
  id:        'entities-001',
  urlId:     'dino-day-kids-explorers',
  fullUrl:   '/events/dino-day-kids-explorers',
  title:     'Dino Day &amp; Kids&#8217; Explorers',
  startDate: 1784385000000,
  endDate:   1784403000000,
  assetUrl:  null,
  excerpt:   '<p>A day for kids to dig &amp; discover.</p>',
  body:      '<p>A day for kids to dig &amp; discover.</p>',
  location:  MUSEUM_LOCATION,
  starred:   false,
}

export const ALL_FIXTURES = [
  CAMP, STEAM_CAMP, SUPER_SCIENCE, ADULT_CRAFT, GOLF, CANOE,
  NO_BODY_EVENT, HTML_ENTITIES_TITLE,
]
