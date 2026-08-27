-- ════════════════════════════════════════════════════════════════════════════
-- submission_publish_gates.test.sql
--
-- Behavioral tests for the deterministic gate predicates used by the
-- `nightly-submission-publish` scheduled task (.agents/nightly-submission-publish.md).
--
-- ⚠️  THIS TEST HAS NOT BEEN RUN. It was authored in an environment with no
--     local Postgres and no way to execute it — the only database reachable
--     from that session was production, over a read-only MCP channel that
--     cannot open a transaction, create a function, or roll back.
--
--     Every EXPECTED VALUE in the assertions below was nonetheless measured
--     against production with read-only SELECTs (`similarity()`, `unaccent()`
--     and the regexp chain, evaluated on literals) -- first on 2026-08-26, then
--     re-verified in full on 2026-08-27 after code review, when the gate C
--     coordinate ladder was rewritten. Two assertions were WRONG on that pass
--     and were corrected against measured behaviour rather than the reverse:
--     the 'Boston Twp.' verdict (section 5) and the in-bbox venue fixture
--     (section 6). The numbers are real. What is unverified is whether this
--     FILE, as a file, executes top to bottom without a syntax error. Run it
--     once before trusting it:
--
--       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/submission_publish_gates.test.sql
--       # or against a local stack:
--       supabase db start && psql "$(supabase status -o env | grep DB_URL | cut -d= -f2)" \
--         -f supabase/tests/submission_publish_gates.test.sql
--
-- Self-contained and side-effect-free: it creates three helper functions,
-- asserts against literals, and ROLLS BACK. It reads no application table and
-- writes nothing. Matches the shape of content_moderation.test.sql.
--
-- Requires: pg_trgm and unaccent (both installed in production, both in the
-- `public` schema — verified 2026-08-26).
--
-- WHAT IS NOT TESTED HERE, deliberately:
--   • Gate A. It is `moderation_severity()`, which content_moderation.test.sql
--     already covers, and its term list must never be committed.
--   • Gate B. It is in-session LLM judgment, not a SQL predicate.
--   • The venue polygon check itself. classifySummitLocation() ray-casts
--     against public/summit-county-boundary.geojson, which is not in the
--     database. The nightly task stands in TWO verified constants for it --
--     the polygon's exact bounding box (a strict superset, so outside it means
--     outside the county) and a rectangle verified to be inscribed INSIDE the
--     polygon (so inside it means inside the county). Section 6 asserts the
--     behaviour of both, including three coordinates that lie in the bbox but
--     outside the polygon, which is the case that must never resolve to `in`.
--     The polygon itself is not asserted; it is not reachable from SQL.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── Helpers: the exact predicates the nightly task inlines ───────────────────
-- Kept byte-identical in behavior to .agents/nightly-submission-publish.md.
-- If you change one, change both — there is no shared implementation, because
-- the scheduled task runs in a fresh cloud session that cannot reach this repo
-- or call a function that may not be applied.

-- Name normalization: lower -> unaccent -> punctuation to space -> strip
-- the/inc/llc/ltd/corp/co -> collapse whitespace.
create or replace function _spg_norm(x text) returns text
-- STABLE, not IMMUTABLE: the single-argument public.unaccent(text) is STABLE
-- (it reads the unaccent dictionary), so anything built on it is too.
language sql stable as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(
    lower(public.unaccent(coalesce(x,''))),
    '[^a-z0-9]+',' ','g'),
    '\y(the|inc|llc|ltd|corp|co)\y',' ','g'),
    '\s+',' ','g'))
$$;

-- Gate C for organizations (city-only: organizations carry no lat/lng).
create or replace function _spg_gate_c_org(city text, state text, address text, zip text)
returns text language sql immutable as $$
  with n as (
    select lower(btrim(coalesce(city,''))) as c_raw,
           regexp_replace(lower(btrim(coalesce(city,''))), '\s+(township|twp\.?)$','') as c_base
  )
  select case
    -- A missing state is NOT evidence of being out of county. `out` routes to
    -- Byron as "recommend cancel", and classifySummitLocation() ignores the
    -- state column entirely, so an empty field must hold, never recommend a
    -- cancellation.
    when state is null or btrim(state) = '' then 'unknown'
    when upper(btrim(state)) <> 'OH' then 'out'
    -- Akron-default downgrade: the submit forms write `city: form.city || 'Akron'`,
    -- so a bare 'Akron' with no address and no zip may mean the submitter typed
    -- nothing at all.
    when n.c_raw = 'akron' and (address is null or btrim(address) = '') and zip is null
      then 'unknown'
    when n.c_raw = '' then 'unknown'
    when n.c_raw = any (array['akron','barberton','cuyahoga falls','fairlawn','green','hudson','macedonia','munroe falls','new franklin','norton','stow','tallmadge','twinsburg','boston heights','clinton','lakemore','mogadore','northfield','northfield center','peninsula','reminderville','richfield','silver lake','sagamore hills','bath','copley','coventry township','boston township','uniontown'])
      or n.c_base = any (array['akron','barberton','cuyahoga falls','fairlawn','green','hudson','macedonia','munroe falls','new franklin','norton','stow','tallmadge','twinsburg','boston heights','clinton','lakemore','mogadore','northfield','northfield center','peninsula','reminderville','richfield','silver lake','sagamore hills','bath','copley','coventry township','boston township','uniontown'])
      then 'in'
    when n.c_raw = any (array['cleveland','east cleveland','cleveland heights','shaker heights','university heights','south euclid','lyndhurst','mayfield','mayfield heights','gates mills','pepper pike','beachwood','orange','moreland hills','hunting valley','chagrin falls','solon','bedford','bedford heights','oakwood village','walton hills','glenwillow','maple heights','garfield heights','newburgh heights','cuyahoga heights','valley view','independence','brecksville','broadview heights','north royalton','seven hills','parma','parma heights','strongsville','brooklyn','brook park','middleburg heights','berea','olmsted falls','north olmsted','fairview park','rocky river','lakewood','bay village','westlake','avon','avon lake','north ridgeville','euclid','richmond heights','highland heights','willowick','kent','aurora','streetsboro','ravenna','mantua','garrettsville','hiram','rootstown','windham','medina','wadsworth','brunswick','lodi','seville','sharon center','rittman','spencer','canton','north canton','massillon','alliance','louisville','east canton','minerva','hartville','magnolia','navarre','brewster','mentor','painesville','willoughby','eastlake','wickliffe','kirtland','lorain','elyria','amherst','wooster','orrville','niles','warren','youngstown','boardman','austintown','canfield','girard','hubbard','struthers','campbell','poland','cortland','newton falls','mcdonald','mineral ridge','howland','vienna'])
      or n.c_base = any (array['cleveland','east cleveland','cleveland heights','shaker heights','university heights','south euclid','lyndhurst','mayfield','mayfield heights','gates mills','pepper pike','beachwood','orange','moreland hills','hunting valley','chagrin falls','solon','bedford','bedford heights','oakwood village','walton hills','glenwillow','maple heights','garfield heights','newburgh heights','cuyahoga heights','valley view','independence','brecksville','broadview heights','north royalton','seven hills','parma','parma heights','strongsville','brooklyn','brook park','middleburg heights','berea','olmsted falls','north olmsted','fairview park','rocky river','lakewood','bay village','westlake','avon','avon lake','north ridgeville','euclid','richmond heights','highland heights','willowick','kent','aurora','streetsboro','ravenna','mantua','garrettsville','hiram','rootstown','windham','medina','wadsworth','brunswick','lodi','seville','sharon center','rittman','spencer','canton','north canton','massillon','alliance','louisville','east canton','minerva','hartville','magnolia','navarre','brewster','mentor','painesville','willoughby','eastlake','wickliffe','kirtland','lorain','elyria','amherst','wooster','orrville','niles','warren','youngstown','boardman','austintown','canfield','girard','hubbard','struthers','campbell','poland','cortland','newton falls','mcdonald','mineral ridge','howland','vienna'])
      then 'out'
    else 'unknown'
  end
  from n
$$;

-- Gate C for venues. COORDINATES ARE AUTHORITATIVE AND TERMINAL: when a venue
-- has usable coordinates this resolves on them alone and NEVER consults the
-- city lists, exactly like classifySummitLocation(), which ray-casts and
-- returns without reading SUMMIT_COUNTY_CITIES.
--
--   outside the bounding box      -> out      (bbox is a superset of the polygon)
--   inside the inscribed rectangle-> in       (rectangle is a subset of the polygon)
--   in the bbox, not the rectangle-> unknown  (only the real polygon could decide)
--
-- The coord-less path delegates wholesale to _spg_gate_c_org, so there is
-- exactly ONE implementation of the city ladder and the two tables cannot drift
-- in list-evaluation order.
create or replace function _spg_gate_c_venue(city text, state text, address text, zip text,
                                             lat numeric, lng numeric)
returns text language sql stable as $$
  with n as (
    select (lat is not null and lng is not null and (lat <> 0 or lng <> 0)) as has_coords
  )
  select case
    when state is null or btrim(state) = '' then 'unknown'
    when upper(btrim(state)) <> 'OH' then 'out'
    when n.has_coords and not (lat between 40.906502 and 41.351168
                           and lng between -81.688491 and -81.391671) then 'out'
    when n.has_coords and lat between 40.918 and 41.273
                      and lng between -81.643 and -81.425 then 'in'
    when n.has_coords then 'unknown'
    else _spg_gate_c_org(city, state, address, zip)
  end
  from n
$$;

-- Gate D, organizations flavour (no city restriction on the trigram rule).
-- Returns the rule that fired, or 'clear'. HOLD-ONLY: this predicate never
-- authorizes a merge or a delete.
create or replace function _spg_gate_d(a text, b text) returns text
language sql stable as $$
  select case
    when _spg_norm(a) = '' or _spg_norm(b) = ''            then 'blank_name'
    when _spg_norm(a) = _spg_norm(b)                        then 'dup_exact'
    when _spg_norm(b) like _spg_norm(a) || ' %'
      or _spg_norm(a) like _spg_norm(b) || ' %'             then 'dup_prefix'
    when similarity(_spg_norm(a), _spg_norm(b)) >= 0.55     then 'dup_trigram'
    else 'clear'
  end
$$;

-- ── 1. Normalization ─────────────────────────────────────────────────────────
do $$
begin
  assert _spg_norm('The Akron Urban League, Inc.') = 'akron urban league',
    'norm: leading "the" and trailing "inc" both stripped, punctuation folded';
  assert _spg_norm('Café Momus LLC') is not null, 'norm: accepts accented input';
  assert _spg_norm('Café Momus LLC') = 'cafe momus', 'norm: unaccent + llc strip';
  assert _spg_norm('Akron  Art   Museum') = 'akron art museum', 'norm: whitespace collapsed';
  assert _spg_norm('CO2 Lounge') = 'co2 lounge',
    'norm: the co/corp strip is word-bounded and must NOT eat the "co" inside "co2"';
  assert _spg_norm('   ') = '', 'norm: blank in, blank out';
  assert _spg_norm(null) = '', 'norm: null in, blank out (never null)';
  raise notice '  ✓ normalization';
end $$;

-- ── 2. Gate D: the token-prefix rule is load-bearing, not redundant ──────────
-- This is the assertion the whole rule exists for. The trigram similarity of
-- these two names is 0.487 (measured against production 2026-08-26), which is
-- BELOW the 0.55 threshold — rule (iii) alone lets the near-duplicate through
-- and the site ends up with two Urban League organizations. Rule (ii) catches
-- it. Do not delete rule (ii) on the theory that the trigram covers it.
do $$
begin
  assert similarity(_spg_norm('Akron Urban League Young Professionals'),
                    _spg_norm('Akron Urban League')) < 0.55,
    'the premise of this test: these two are BELOW the trigram threshold';

  assert _spg_gate_d('Akron Urban League Young Professionals', 'Akron Urban League') = 'dup_prefix',
    'token-prefix must hold "Akron Urban League Young Professionals" against "Akron Urban League"';

  -- and in the other direction: the existing row may be the longer one.
  assert _spg_gate_d('Akron Urban League', 'Akron Urban League Young Professionals') = 'dup_prefix',
    'token-prefix must be tested in BOTH directions';

  -- exact wins over prefix when both could apply
  assert _spg_gate_d('The Akron Urban League, Inc.', 'Akron Urban League') = 'dup_exact',
    'normalized equality reported as dup_exact';

  -- token boundary: "Akron Zoo" must NOT prefix-match "Akron Zoological Park".
  -- The rule requires a following SPACE, so it matches whole tokens only.
  assert _spg_gate_d('Akron Zoo', 'Akron Zoological Park') = 'clear',
    'prefix rule is token-wise: "zoo" must not swallow "zoological"';

  raise notice '  ✓ gate D token-prefix containment';
end $$;

-- ── 3. Gate D: the 0.55 trigram boundary ─────────────────────────────────────
-- Both pairs were measured against production on 2026-08-26 and straddle the
-- threshold by ~0.01. Neither pair is a token-prefix match, so the trigram rule
-- is the only thing that can fire and the boundary is tested cleanly.
--
--   'lock 3 park'         vs 'lock three park'   -> 0.5556  (>= 0.55, holds)
--   'akron pizza kitchen' vs 'akron pizza oven'  -> 0.5417  (<  0.55, clears)
--
-- DO NOT LOWER 0.55 to make a real-world miss go away. Gate D is HOLD-ONLY and
-- a lower threshold holds legitimate distinct organizations forever — the exact
-- failure mode ("submissions sit invisible") this job was built to end.
do $$
declare hi numeric; lo numeric;
begin
  hi := similarity(_spg_norm('Lock 3 Park'),         _spg_norm('Lock Three Park'));
  lo := similarity(_spg_norm('Akron Pizza Kitchen'), _spg_norm('Akron Pizza Oven'));

  assert hi >= 0.55, format('expected >= 0.55 for the Lock 3 pair, got %s', hi);
  assert lo <  0.55, format('expected < 0.55 for the pizza pair, got %s', lo);
  assert hi - lo < 0.05, 'the two fixtures must straddle the threshold closely to be a boundary test';

  assert _spg_gate_d('Lock 3 Park', 'Lock Three Park')         = 'dup_trigram',
    'at-or-above 0.55 holds via the trigram rule';
  assert _spg_gate_d('Akron Pizza Kitchen', 'Akron Pizza Oven') = 'clear',
    'below 0.55 with no prefix match clears';

  -- comfortably above, non-prefix
  assert _spg_gate_d('West Side Bakery', 'West Side Bakehouse') = 'dup_trigram',
    '0.609 pair holds';
  -- comfortably below, non-prefix
  assert _spg_gate_d('Canal Park Stadium', 'Canal Place Studio') = 'clear',
    '0.310 pair clears';

  raise notice '  ✓ gate D trigram boundary at 0.55';
end $$;

-- ── 4. Gate C: the Akron-default downgrade ───────────────────────────────────
-- OrganizationSubmitPage.tsx and VenueSubmitPage.tsx both write
-- `city: form.city || 'Akron'`, so 'akron' with nothing to corroborate it is
-- not evidence of anything. Measured against production 2026-08-27: 616 of 626
-- published organizations carry city='Akron', and of those 616 only 10 have an
-- address and 12 have a zip (table-wide the figures are 18 and 20). The
-- downgrade therefore fires on 604 of 626, and it is expected to hold nearly
-- every organization submission. That is the design's decision, recorded in the
-- task file's standing note — it is not something to "fix" by weakening this
-- rule.
do $$
begin
  -- the downgrade fires
  assert _spg_gate_c_org('Akron', 'OH', null, null) = 'unknown',
    'city=Akron with null address AND null zip must downgrade to unknown';
  assert _spg_gate_c_org('akron', 'OH', '   ', null) = 'unknown',
    'a blank-but-not-null address is still no address';
  assert _spg_gate_c_org('AKRON', 'OH', null, null) = 'unknown',
    'the downgrade is case-insensitive';

  -- a real Akron organization with an address passes
  assert _spg_gate_c_org('Akron', 'OH', '1 South High Street', null) = 'in',
    'an address corroborates the Akron default';
  assert _spg_gate_c_org('Akron', 'OH', null, '44308') = 'in',
    'a zip corroborates it too';

  -- the downgrade is Akron-specific: no other allowlisted city is second-guessed,
  -- because no other city is the form default.
  assert _spg_gate_c_org('Hudson', 'OH', null, null) = 'in',
    'the downgrade applies to Akron ONLY -- Hudson is never auto-filled';
  assert _spg_gate_c_org('Cuyahoga Falls', 'OH', null, null) = 'in',
    'Cuyahoga Falls with no address still passes';

  raise notice '  ✓ gate C Akron-default downgrade';
end $$;

-- ── 5. Gate C: in / out / unknown ────────────────────────────────────────────
do $$
begin
  -- out-of-county cities hold, and are reported to Byron as recommend-cancel.
  -- The job NEVER writes 'cancelled' itself.
  assert _spg_gate_c_org('Cleveland',  'OH', '123 Euclid Ave', '44114') = 'out', 'Cleveland is out';
  assert _spg_gate_c_org('Kent',       'OH', '1 Main St',      '44240') = 'out', 'Kent (Portage) is out';
  assert _spg_gate_c_org('Canton',     'OH', '1 Market Ave',   '44702') = 'out', 'Canton (Stark) is out';
  assert _spg_gate_c_org('Strongsville','OH','1 Royalton Rd',  '44136') = 'out', 'Strongsville is out';

  -- out-of-state is out regardless of city
  assert _spg_gate_c_org('Akron', 'PA', '1 Main St', '17501') = 'out',
    'state <> OH is out -- there is an Akron, Pennsylvania';
  assert _spg_gate_c_org('Hudson', 'NY', '1 Warren St', '12534') = 'out',
    'state <> OH is out -- there is a Hudson, New York';

  -- township normalization, mirroring normalizeCity()
  assert _spg_gate_c_org('Coventry Township', 'OH', '1 Main St', '44319') = 'in',
    'coventry township is on the allowlist verbatim';
  -- QUIRK, mirrored faithfully from scripts/lib/summit-county.js rather than
  -- "fixed" here. normalizeCity() strips a trailing "Township"/"Twp.", but the
  -- two township entries on SUMMIT_COUNTY_CITIES are spelled out in FULL
  -- ('coventry township', 'boston township'). So the stripping only ever helps
  -- a row that already spells the word out -- and it helps it by matching the
  -- RAW form, not the stripped one:
  --
  --   'Coventry Township' -> raw 'coventry township'  IS on the allowlist -> in
  --   'Boston Twp.'       -> raw 'boston twp.'        not on either list
  --                          base 'boston'            not on either list -> unknown
  --
  -- Verified against production 2026-08-26: the SQL and classifySummitLocation()
  -- agree on both. An abbreviated township therefore HOLDS rather than
  -- publishes, which is the safe direction, so this job is not the place to
  -- change it. If Byron wants 'Boston Twp.' to pass, the fix is to add 'boston'
  -- and 'coventry' to SUMMIT_COUNTY_CITIES in the JS module -- one edit, both
  -- consumers -- and only after checking that no Boston/Coventry outside Summit
  -- County shows up in the feeds.
  assert _spg_gate_c_org('Boston Twp.', 'OH', '1 Main St', '44264') = 'unknown',
    'an ABBREVIATED township matches neither list and holds as unknown -- see the note above';

  -- Uniontown straddles the county line and is deliberately ALLOWED.
  assert _spg_gate_c_org('Uniontown', 'OH', '1 Main St', '44685') = 'in',
    'uniontown is on the allowlist on purpose and must never be blocklisted';

  -- unrecognized and blank cities hold, never publish
  assert _spg_gate_c_org('Zanesville', 'OH', '1 Main St', '43701') = 'unknown',
    'a city on neither list is unknown -- absence from the blocklist is NOT in-county';
  assert _spg_gate_c_org('', 'OH', '1 Main St', '44308') = 'unknown', 'blank city is unknown';
  assert _spg_gate_c_org(null, 'OH', '1 Main St', '44308') = 'unknown', 'null city is unknown';

  raise notice '  ✓ gate C in / out / unknown';
end $$;

-- ── 6. Gate C for venues: the coordinate ladder ──────────────────────────────
-- Both constants come from public/summit-county-boundary.geojson (Polygon,
-- 1,471 vertices), computed 2026-08-27:
--
--   bounding box          lat 40.906502 .. 41.351168   lng -81.688491 .. -81.391671
--                         the polygon's exact extent -- a strict SUPERSET
--   inscribed rectangle   lat 40.918    .. 41.273      lng -81.643     .. -81.425
--                         verified strict SUBSET: all four corners test inside by
--                         ray-cast AND no polygon edge intersects any of its edges,
--                         then rounded INWARD to 3dp (~100m slack) and re-verified
--
-- THE REGRESSION THIS SECTION EXISTS TO CATCH. The first version of the nightly
-- task used the bbox as a hard `out` and let every in-bbox row fall through to
-- the city allowlist. That is not conservative -- it INVERTS the verdict on the
-- county-line rows, turning a JS `out` into a published venue. The three
-- fixtures below are all inside the bounding box and outside the polygon, and
-- all three carry an ALLOWLISTED city, which is precisely what made the old
-- fall-through publish them. Verified by ray-cast against the geojson:
-- classifySummitLocation() returns 'out' for each.
--
-- If any of the three ever asserts 'in' again, the fall-through is back.
do $$
begin
  -- ---- the three regression fixtures: in bbox, outside polygon, allowlisted city
  assert _spg_gate_c_venue('Uniontown', 'OH', null, null, 40.955, -81.410) <> 'in',
    'Stark-side Uniontown is OUT in the JS -- it must never resolve to in';
  assert _spg_gate_c_venue('Uniontown', 'OH', null, null, 40.955, -81.410) = 'unknown',
    'and specifically it holds as unknown, because only the polygon could decide';

  assert _spg_gate_c_venue('Richfield', 'OH', null, null, 41.34, -81.66) <> 'in',
    'Cuyahoga-side Richfield is OUT in the JS -- it must never resolve to in';
  assert _spg_gate_c_venue('Richfield', 'OH', null, null, 41.34, -81.66) = 'unknown',
    'Richfield near the north line holds as unknown';

  -- a LIVE published venue sits at this point today
  assert _spg_gate_c_venue('Norton', 'OH', null, null, 41.047, -81.688) = 'unknown',
    'the live Norton venue at (41.047,-81.688) is in-bbox and outside the polygon';

  -- 'uniontown' and 'mogadore' are on the allowlist BECAUSE they straddle the
  -- county line and the JS only reads that list when coords are ABSENT. Prove
  -- the same city flips verdict purely on whether coordinates are present.
  assert _spg_gate_c_venue('Uniontown', 'OH', '1 Main St', '44685', null, null) = 'in',
    'coord-LESS Uniontown passes on the allowlist -- that is what the entry is for';
  assert _spg_gate_c_venue('Uniontown', 'OH', '1 Main St', '44685', 40.955, -81.410) = 'unknown',
    'the SAME city with county-line coords holds: coords are terminal, the list is not consulted';

  -- ---- the three zones
  -- inside the inscribed rectangle => inside the polygon, certainly
  assert _spg_gate_c_venue('Akron', 'OH', null, null, 41.0814, -81.5190) = 'in',
    'downtown Akron is inside the inscribed rectangle';
  assert _spg_gate_c_venue('Akron', 'OH', null, null, 41.0814, -81.5190) = 'in',
    'coords present => the Akron-default downgrade does not apply';

  -- outside the bounding box => outside the polygon, certainly
  assert _spg_gate_c_venue('Strongsville', 'OH', null, null, 41.3141, -81.8194) = 'out',
    'coords outside the bbox are outside the county, with certainty';

  -- in the annulus with an out-of-county city: still unknown, NOT out. The city
  -- list is not consulted at all once coordinates are present.
  assert _spg_gate_c_venue('Cleveland', 'OH', '1 Euclid Ave', '44114', 41.34, -81.66) = 'unknown',
    'coords beat the city list in BOTH directions -- a blocklisted city with in-bbox coords is unknown';

  -- Coords are terminal in the generous direction too: (41.10,-81.50) is inside
  -- the inscribed rectangle and therefore inside the county by construction
  -- (ray-cast confirms it), so a nonsense city on the row changes nothing.
  assert _spg_gate_c_venue('Zanesville', 'OH', '1 Main St', '43701', 41.10, -81.50) = 'in',
    'coords inside the inscribed rectangle decide the row outright -- the city string is not consulted';

  -- THE ANNULUS, and the cost of not having the polygon. (41.30,-81.50) IS
  -- inside Summit County -- ray-cast against the geojson says so, and the JS
  -- would return 'in'. It sits north of the inscribed rectangle but inside the
  -- bounding box, so this job cannot prove it and holds. A FALSE HOLD is the
  -- price of not shipping the polygon, and it is the right side to be wrong on:
  -- the row waits a day for a human instead of being published on a guess.
  assert _spg_gate_c_venue('Akron', 'OH', '1 Main St', '44333', 41.30, -81.50) = 'unknown',
    'the annulus holds even when the true answer is in-county -- deliberate, and fails closed';

  -- ---- coords absent: the city ladder, delegated to the org helper
  assert _spg_gate_c_venue('Akron', 'OH', null, null, 0, 0) = 'unknown',
    '(0,0) is a placeholder, not a location -- falls back to city, then downgrades';
  assert _spg_gate_c_venue('Akron', 'OH', null, null, null, null) = 'unknown',
    'the Akron-default downgrade applies to venues only when coords are absent';
  assert _spg_gate_c_venue('Akron', 'OH', '1 S High St', null, null, null) = 'in',
    'a coord-less, addressed Akron venue passes on the city ladder';
  assert _spg_gate_c_venue('Cleveland', 'OH', '1 Euclid Ave', '44114', null, null) = 'out',
    'a coord-less blocklisted city is out';

  raise notice '  ✓ gate C venue coordinate ladder (out / in / unknown, no city fall-through)';
end $$;

-- ── 7. A missing state holds; it never recommends cancellation ───────────────
-- `out` routes to Byron as "recommend cancel" (Needs Byron). classifySummitLocation()
-- ignores the state column entirely, so treating an EMPTY state as out-of-county
-- would recommend cancelling a legitimate Akron submission over a blank form
-- field. Production has zero blank states in either table today, so this is a
-- guard rather than a live case -- which is exactly why it needs a test.
do $$
begin
  assert _spg_gate_c_org('Akron', null, '1 S High St', '44308') = 'unknown',
    'null state holds as unknown, never out';
  assert _spg_gate_c_org('Akron', '',   '1 S High St', '44308') = 'unknown',
    'blank state holds as unknown, never out';
  assert _spg_gate_c_org('Akron', '  ', '1 S High St', '44308') = 'unknown',
    'whitespace-only state holds as unknown, never out';
  assert _spg_gate_c_venue('Akron', null, '1 S High St', '44308', null, null) = 'unknown',
    'same rule for venues on the coord-less path';

  -- a state that is present and wrong is still out
  assert _spg_gate_c_org('Akron', 'PA', '1 Main St', '17501') = 'out',
    'a PRESENT, non-OH state is still out';

  raise notice '  ✓ missing state holds rather than recommending cancel';
end $$;

-- ── 8. The publish predicate ─────────────────────────────────────────────────
-- A candidate reaches gate B only when all three deterministic gates agree.
-- Gate A is stubbed with its real expression's contract (NULL = pass) rather
-- than a tautology: moderation_severity() is exercised by
-- content_moderation.test.sql and its term list must not be committed here.
do $$
begin
  -- the happy path: clean text, addressed Akron org, no duplicate
  assert (public.moderation_severity('Akron Symphony free family concert') is null)
     and (_spg_gate_c_org('Akron','OH','1 S High St',null) = 'in')
     and (_spg_gate_d('Akron Pizza Kitchen','Akron Pizza Oven') = 'clear'),
    'a clean, addressed, non-duplicate Akron org reaches gate B';

  -- each gate alone is sufficient to stop it
  assert _spg_gate_c_org('Akron','OH',null,null) <> 'in',
    'gate C alone stops an un-addressed Akron org';
  assert _spg_gate_d('Akron Urban League Young Professionals','Akron Urban League') <> 'clear',
    'gate D alone stops the Urban League near-duplicate';
  assert _spg_gate_c_org('Cleveland','OH','1 Euclid Ave','44114') <> 'in',
    'gate C alone stops an out-of-county org';
  assert _spg_gate_c_venue('Uniontown','OH',null,null,40.955,-81.410) <> 'in',
    'gate C alone stops a county-line venue -- the P0 regression, restated as a publish test';

  raise notice '  ✓ publish predicate';
end $$;

do $$ begin raise notice 'ALL SUBMISSION-PUBLISH GATE TESTS PASSED'; end $$;

rollback;
