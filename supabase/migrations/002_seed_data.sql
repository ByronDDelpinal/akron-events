-- ============================================================
-- The 330 — Seed Data
-- Real Akron / Summit County venues, organizers, and events
-- Run this in Supabase SQL Editor after 001_initial_schema.sql
-- ============================================================

-- ─────────────────────────────────────────
-- VENUES
-- ─────────────────────────────────────────
insert into venues (id, name, address, city, state, zip, lat, lng, parking_type, parking_notes, website) values
  ('a1000000-0000-0000-0000-000000000001', 'Lock 3 Park',                    '200 S Main St',          'Akron',   'OH', '44308', 41.0789, -81.5142, 'lot',     'Free surface lots on S Main St and Cedar St. Street parking also available.',          'https://lock3live.com'),
  ('a1000000-0000-0000-0000-000000000002', 'Akron Civic Theatre',             '182 S Main St',          'Akron',   'OH', '44308', 41.0793, -81.5145, 'garage',  'Parking available in the Main St garage directly across from the theatre.',             'https://akroncivic.com'),
  ('a1000000-0000-0000-0000-000000000003', 'Akron Art Museum',                '1 S High St',            'Akron',   'OH', '44308', 41.0820, -81.5190, 'street',  'Metered street parking on High St and E Market St. Free after 6pm on weekdays.',       'https://akronartmuseum.org'),
  ('a1000000-0000-0000-0000-000000000004', 'Musica',                          '51 E Market St',         'Akron',   'OH', '44308', 41.0830, -81.5162, 'street',  'Street parking on E Market St and surrounding blocks.',                                 'https://musicaakron.com'),
  ('a1000000-0000-0000-0000-000000000005', 'Northside Marketplace',           '56 E Market St',         'Akron',   'OH', '44308', 41.0832, -81.5160, 'street',  'Street parking available throughout the Northside neighborhood.',                        'https://northsidemarketplace.com'),
  ('a1000000-0000-0000-0000-000000000006', 'Bounce Innovation Hub',           '526 S Main St',          'Akron',   'OH', '44311', 41.0673, -81.5148, 'lot',     'Free parking lot adjacent to building.',                                                 'https://bounceinnovation.org'),
  ('a1000000-0000-0000-0000-000000000007', 'Summit Artspace',                 '140 E Market St',        'Akron',   'OH', '44308', 41.0824, -81.5133, 'street',  'Street parking on E Market St. Some metered spots directly in front.',                  'https://summitartspace.org'),
  ('a1000000-0000-0000-0000-000000000008', 'Canal Park Stadium',              '300 S Main St',          'Akron',   'OH', '44308', 41.0758, -81.5150, 'lot',     'Official Canal Park lots open 90 min before first pitch. $5–$10.',                      'https://milb.com/akron'),
  ('a1000000-0000-0000-0000-000000000009', 'Hilton Akron/Fairlawn',           '3180 W Market St',       'Akron',   'OH', '44333', 41.1358, -81.5842, 'lot',     'Free on-site parking for all guests and event attendees.',                              'https://hilton.com'),
  ('a1000000-0000-0000-0000-000000000010', 'Stan Hywet Hall & Gardens',       '714 N Portage Path',     'Akron',   'OH', '44303', 41.1048, -81.5422, 'lot',     'Free on-site parking lot.',                                                              'https://stanhywet.org'),
  ('a1000000-0000-0000-0000-000000000011', 'The Nightlight Cinema',           '30 N High St',           'Akron',   'OH', '44308', 41.0851, -81.5193, 'street',  'Street parking on N High St and Bowery St.',                                             'https://thenightlightcinema.com'),
  ('a1000000-0000-0000-0000-000000000012', 'Akron Farmers Market at Merriman','1300 W Exchange St',     'Akron',   'OH', '44313', 41.1062, -81.5382, 'lot',     'Free on-site parking.',                                                                  null);

-- ─────────────────────────────────────────
-- ORGANIZERS
-- ─────────────────────────────────────────
insert into organizers (id, name, website, description) values
  ('b1000000-0000-0000-0000-000000000001', 'Rubber City Jazz & Blues Society',  'https://rubbercityjazz.com',        'Akron-based nonprofit dedicated to preserving and promoting jazz and blues music in Northeast Ohio.'),
  ('b1000000-0000-0000-0000-000000000002', 'Akron Art Museum',                   'https://akronartmuseum.org',         'Free admission art museum in downtown Akron showcasing modern and contemporary art.'),
  ('b1000000-0000-0000-0000-000000000003', 'Northside Marketplace',              'https://northsidemarketplace.com',   'Akron''s year-round indoor market featuring local vendors, food, and community events.'),
  ('b1000000-0000-0000-0000-000000000004', 'Akron Community Foundation',         'https://akroncommunityfoundation.org','Connecting donors to community needs in Summit County since 1955.'),
  ('b1000000-0000-0000-0000-000000000005', 'Akron Civic Theatre',                'https://akroncivic.com',             'Historic 1929 theater hosting Broadway tours, concerts, comedy, and local performances.'),
  ('b1000000-0000-0000-0000-000000000006', 'Summit Artspace',                    'https://summitartspace.org',         'A multi-use arts complex in downtown Akron supporting local artists and the creative economy.'),
  ('b1000000-0000-0000-0000-000000000007', 'Akron RubberDucks',                  'https://milb.com/akron',             'Akron''s Double-A affiliate of the Cleveland Guardians. Baseball at Canal Park since 1997.'),
  ('b1000000-0000-0000-0000-000000000008', 'Bounce Innovation Hub',              'https://bounceinnovation.org',       'Akron''s entrepreneurship hub, supporting startups and hosting community events in the innovation space.'),
  ('b1000000-0000-0000-0000-000000000009', 'Stan Hywet Hall & Gardens',          'https://stanhywet.org',              'Historic Tudor Revival manor and National Historic Landmark, home to festivals and cultural events year-round.');

-- ─────────────────────────────────────────
-- EVENTS  (dates relative to late March / April 2026)
-- ─────────────────────────────────────────
insert into events (
  title, description, start_at, end_at,
  venue_id, organizer_id,
  category, tags,
  price_min, price_max,
  age_restriction, ticket_url,
  source, featured, status
) values

-- ── TODAY / THIS WEEKEND ──────────────────

(
  'Rubber City Jazz Festival — Spring Edition',
  'The Rubber City Jazz & Blues Society brings the best of regional and national jazz talent to Lock 3 Park for a two-night spring celebration. Expect smooth standards, hard bop, and a few surprises from local luminaries. Food trucks and craft beer on site.',
  '2026-03-21 18:00:00-04', '2026-03-21 23:00:00-04',
  'a1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
  'music', array['jazz','outdoor','food trucks','live music'],
  18, 35,
  'all_ages', null,
  'manual', true, 'published'
),

(
  'Opening Night: "Roots & Routes" Group Exhibition',
  'Summit Artspace presents the opening reception for "Roots & Routes," a group exhibition exploring themes of identity, migration, and belonging through the work of twelve Northeast Ohio artists. Wine and light refreshments provided.',
  '2026-03-21 17:00:00-04', '2026-03-21 21:00:00-04',
  'a1000000-0000-0000-0000-000000000007', 'b1000000-0000-0000-0000-000000000006',
  'art', array['gallery','opening reception','local artists','free'],
  0, 0,
  'all_ages', null,
  'manual', false, 'published'
),

(
  'Northside Farmers Market — Spring Kickoff',
  'The Northside Marketplace opens its outdoor season with the Spring Kickoff market. Local produce, baked goods, handmade crafts, live music, and family activities. Rain or shine.',
  '2026-03-21 09:00:00-04', '2026-03-21 14:00:00-04',
  'a1000000-0000-0000-0000-000000000005', 'b1000000-0000-0000-0000-000000000003',
  'community', array['market','local vendors','family','outdoor','free'],
  0, 0,
  'all_ages', null,
  'manual', false, 'published'
),

-- ── SUNDAY MARCH 22 ──────────────────────

(
  'Akron Community Foundation Spring Gala',
  'Join the Akron Community Foundation for an elegant evening celebrating philanthropic impact across Summit County. Cocktail reception, dinner, live auction, and remarks from community leaders. Black tie optional.',
  '2026-03-22 18:30:00-04', '2026-03-22 22:30:00-04',
  'a1000000-0000-0000-0000-000000000009', 'b1000000-0000-0000-0000-000000000004',
  'nonprofit', array['gala','fundraiser','formal','dinner'],
  75, 75,
  '21_plus', null,
  'manual', false, 'published'
),

(
  'Open Mic Night at Musica',
  'Musica''s weekly open mic is back for its spring run. Sign up at the door starting at 6:30pm for your 5-minute slot. All genres welcome — singer-songwriters, poets, comedians, and first-timers encouraged.',
  '2026-03-22 19:00:00-04', '2026-03-22 23:00:00-04',
  'a1000000-0000-0000-0000-000000000004', null,
  'music', array['open mic','original music','local artists','weekly'],
  10, 10,
  '18_plus', null,
  'manual', false, 'published'
),

-- ── NEXT WEEK ────────────────────────────

(
  'Akron RubberDucks Home Opener',
  'Play ball! The Akron RubberDucks kick off their 2026 home season against the Altoona Curve. First pitch at 6:35pm. Fireworks postgame. Bring the family — this is Akron baseball at its best.',
  '2026-04-04 18:35:00-04', '2026-04-04 22:00:00-04',
  'a1000000-0000-0000-0000-000000000008', 'b1000000-0000-0000-0000-000000000007',
  'sports', array['baseball','family','fireworks','minor league'],
  8, 18,
  'all_ages', null,
  'manual', true, 'published'
),

(
  'Stan Hywet Tulip Festival',
  'Over 10,000 tulips in bloom across the historic Stan Hywet estate gardens. Self-guided tours of the manor and grounds. Perfect for families, photographers, and anyone who needs a little spring in their step.',
  '2026-04-05 10:00:00-04', '2026-04-05 17:00:00-04',
  'a1000000-0000-0000-0000-000000000010', 'b1000000-0000-0000-0000-000000000009',
  'community', array['gardens','family','outdoor','historic','spring'],
  14, 18,
  'all_ages', null,
  'manual', false, 'published'
),

(
  'Summit Artspace: Artists'' Open Studios',
  'Go behind the scenes at Summit Artspace as resident artists open their studios to the public. Meet the artists, see works in progress, and purchase original pieces directly. Free and open to all.',
  '2026-04-05 12:00:00-04', '2026-04-05 16:00:00-04',
  'a1000000-0000-0000-0000-000000000007', 'b1000000-0000-0000-0000-000000000006',
  'art', array['open studios','local artists','free','community'],
  0, 0,
  'all_ages', null,
  'manual', false, 'published'
),

(
  'Akron Civic Theatre: Hadestown (Broadway Tour)',
  'The Tony Award–winning musical Hadestown comes to the Akron Civic for four nights. A love story, a labor dispute, and the music of Anaïs Mitchell make for one of the most celebrated musicals of the decade.',
  '2026-04-08 19:30:00-04', '2026-04-08 22:00:00-04',
  'a1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000005',
  'music', array['broadway','musical','theater','touring production'],
  45, 115,
  'all_ages', null,
  'manual', false, 'published'
),

(
  'Startup Summit Akron',
  'Bounce Innovation Hub hosts its quarterly Startup Summit — a full day of panels, demos, and networking for Northeast Ohio entrepreneurs. Topics this quarter: funding in the Midwest, AI for small business, and building remote-first teams.',
  '2026-04-10 09:00:00-04', '2026-04-10 17:00:00-04',
  'a1000000-0000-0000-0000-000000000006', 'b1000000-0000-0000-0000-000000000008',
  'education', array['entrepreneurship','startup','networking','business'],
  25, 25,
  'all_ages', null,
  'manual', false, 'published'
),

(
  'Akron Art Museum: First Saturday Family Day',
  'Free family programming at the Akron Art Museum every first Saturday. This month''s theme: "Pattern & Play" — drop-in art-making activities inspired by the museum''s current exhibitions. No registration required.',
  '2026-04-04 10:00:00-04', '2026-04-04 13:00:00-04',
  'a1000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000002',
  'art', array['family','kids','free','drop-in','workshop'],
  0, 0,
  'all_ages', null,
  'manual', false, 'published'
),

(
  'Akron Farmers Market at Merriman — Early Season',
  'The Akron Farmers Market at Merriman Valley opens for its early spring run. Seasonal produce, local honey, artisan bread, handmade goods, and live acoustic music every Saturday morning.',
  '2026-04-11 08:00:00-04', '2026-04-11 13:00:00-04',
  'a1000000-0000-0000-0000-000000000012', null,
  'community', array['market','local vendors','outdoor','seasonal','weekly'],
  0, 0,
  'all_ages', null,
  'manual', false, 'published'
);
