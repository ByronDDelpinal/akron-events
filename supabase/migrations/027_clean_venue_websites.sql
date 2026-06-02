-- Null out venues.website rows whose value isn't a real URL.
--
-- Past versions of the visit_akron_cvb scraper (and a few Tribe-Events-
-- Calendar feeds that pipe user-edited text directly through) wrote
-- rows like `website = 'https://Bath Business Association'`,
-- `'https://All Forward'`, `'https://The Emerald Hive'`, etc. — the
-- partner-listing name stuffed into a URL slot. The frontend renders
-- these as broken external links on every event detail page tied to
-- those venues.
--
-- The scrapers now sanitize-at-write (see sanitizeWebsite() in
-- scripts/lib/normalize.js), so new rows can't enter this state.
-- This migration retroactively cleans the existing rows. Matching
-- criteria, in order:
--
--   1. Contains a whitespace character anywhere — a real URL never does.
--   2. Has no dot at all after stripping the scheme — host must have a TLD.
--   3. Host portion contains characters that aren't valid in a domain
--      label (anything outside [a-z0-9.-], case-insensitive).
--
-- All three are SAFE-NULL operations: organizers can re-supply a real
-- website later, but right now these strings produce 4xx/5xx for end
-- users so nothing is lost by removing them.

update venues
   set website = null
 where website is not null
   and (
        -- whitespace
        website ~ '\s'
        -- missing dot in host
     or website !~ '^https?://[^/]+\.[^/]+'
        -- invalid label chars in host
     or regexp_replace(website, '^https?://([^/]+).*$', '\1') ~ '[^a-zA-Z0-9.\-]'
   );

-- Same problem class also exists for organizations.website (the
-- visit_akron_cvb scraper writes both via ensureVenue / ensureOrganization).
update organizations
   set website = null
 where website is not null
   and (
        website ~ '\s'
     or website !~ '^https?://[^/]+\.[^/]+'
     or regexp_replace(website, '^https?://([^/]+).*$', '\1') ~ '[^a-zA-Z0-9.\-]'
   );
