Verbatim WebFetch capture — 2026-08-05 — of the global site footer that appears
on every cvfm.org page (homepage and /summer-market/ both carry it). This is the
"Stay Connected" footer block, the richest structured statement of the standing
schedule: full date ranges with the printed end-year, both venues with street +
ZIP, and the winter holiday closures. The scraper parses these two season blocks
live. Rendered by WebFetch to markdown; the scraper reads the raw page HTML and
flattens it with htmlToText() to the same plain-text lines (link/e-mail wrappers
and heading markers dropped). test-cvfm.js reduces this capture to that
plain-text form before feeding the REAL parseSeasons().

## Stay Connected to the Market

Fresh each week—seasonal produce, vendor stories, events, and market updates.

##### About the market

Located in the heart of the Cuyahoga Valley National Park. Registered as a 501C3 in 2022 to carry on the tradition of Countryside Market.

##### SUMMER MARKET

May 2 - October 31, 2026  
[Howe Meadow 4040 Riverview Rd. Peninsula, OH 44264](https://maps.app.goo.gl/MMgZ2V6kaKmduLNc9)  
<info@cvfm.org>

##### WINTER MARKET

November 7 - April 24, 2027  
*CLOSED: Nov 28, Dec 26, Jan 2*  
[Old Trail School 2315 Ira Rd. Akron, OH 44333](https://maps.app.goo.gl/yd4ePqdL4Af74F9H9)  
<info@cvfm.org>

##### HOURS

Open Rain or Shine  
Every Saturday  
9am - 12pm
