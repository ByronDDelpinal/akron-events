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
-- EVENTS
-- ─────────────────────────────────────────
-- Placeholder events have been removed. Real events are ingested via:
--   npm run ingest:ticketmaster       — Ticketmaster Discovery API (25-mile radius)
--   npm run scrape:summit-artspace    — Summit Artspace Tribe Events REST API
-- Re-run those scripts after applying this migration to populate the events table.
