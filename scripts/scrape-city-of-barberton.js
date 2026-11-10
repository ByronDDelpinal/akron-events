/**
 * scrape-city-of-barberton.js
 *
 * City of Barberton, Ohio (Summit County) — CivicPlus (CivicEngage) site.
 *
 * The city replaced its WordPress site with CivicPlus on or about 2026-11-06.
 * The old Tribe iCal feed (/?post_type=tribe_events&ical=1) now returns the
 * CivicPlus home page, which is why this source went from 30 events a night
 * to an error overnight. This is the rewrite onto the shared CivicPlus runner.
 *
 * Calendar → catID: the new home page's two "View All Events" links point at
 * /calendar.aspx?CID=14 and ?CID=23, and both iCalendar feeds answer with a
 * valid VCALENDAR.
 *
 * NOT YET VERIFIED AGAINST REAL EVENTS. As of 2026-11-10 the city has not
 * populated the new calendar: both feeds are valid but hold zero VEVENTs, and
 * the calendar page lists no calendars to pick from. Until they post, this
 * source reports "0 public-facing events after filter" like any off-season
 * CivicPlus town. On the first night it finds events, check two things:
 *   • which catID carries community events versus governance (drop the other
 *     if the shared admin filter is not enough);
 *   • start times. The empty feeds declare X-WR-TIMEZONE America/Chicago, the
 *     CivicPlus default for an unconfigured site. If the city never corrects
 *     it, events will land one hour late.
 *
 * What the old feed carried, and what to expect back: the Parks & Rec summer
 * programming (the Friday and Wednesday Summer Concert Series at the Lake Anna
 * Gazebo, the Purple Paw Party at Decker Park, the Labor Day Fireworks), mixed
 * with City Council and committee meetings, which the runner's public-event
 * filter drops. Events with no LOCATION fall back to Lake Anna Park.
 *
 * Usage:   node scripts/scrape-city-of-barberton.js
 */

import { runCivicPlusScraper } from './lib/civicplus.js'

runCivicPlusScraper({
  source:    'city_of_barberton',
  origin:    'https://www.cityofbarberton.com',
  catIDs:    [14, 23],
  cityLabel: 'Barberton',
  emoji:     '🎆',
  organization: {
    name: 'City of Barberton',
    details: {
      website:     'https://www.cityofbarberton.com',
      description: 'City of Barberton (Summit County, OH) Parks & Recreation community events — the Summer Concert Series at Lake Anna Gazebo, the Purple Paw Party, and the Labor Day Fireworks.',
    },
  },
  defaultVenue: {
    name:    'Lake Anna Park',
    address: '615 W. Park Ave',
    zip:     '44203',
    website: 'https://www.cityofbarberton.com',
  },
  baseTags: ['city-of-barberton', 'barberton-ohio', 'summit-county'],
})
