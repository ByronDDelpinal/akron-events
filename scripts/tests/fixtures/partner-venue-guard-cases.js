/**
 * partner-venue-guard-cases.js — THE SHARED CASE TABLE for the partner
 * venue-mint guard (design §3.4, the "duplicate + test, never refactor"
 * discipline).
 *
 * The mint-time law exists in TWO implementations that cannot share code:
 *   • JS: isJunkVenueName / looksLikeStreetAddress in scripts/lib/normalize.js
 *     (ensureVenue's mint guard);
 *   • SQL: partner_venue_name_blocked() in
 *     supabase/migrations/061_partner_accounts.sql (partner_mint_venue's
 *     guard), whose token lists are copied from normalize.js by hand.
 *
 * This table is the drift bound between them:
 *   • scripts/tests/test-partner-venue-guard.js asserts the JS verdicts for
 *     every row, AND greps supabase/tests/partner_accounts_rls.test.sql to
 *     confirm its M13 block carries the same rows (name + family);
 *   • partner_accounts_rls.test.sql block 10 asserts the SQL function's
 *     verdict per row against the live database.
 * Change the guard on either side and one of the two tests goes red until
 * this table (and the other side) moves too.
 *
 * Shape per row:
 *   name    — the venue-name input, verbatim
 *   family  — SQL block family: 'state' | 'virtual' | 'fragment' | 'address',
 *             or null when the name must PASS (may mint)
 *   junk    — expected isJunkVenueName(name)      (families 1-3)
 *   address — expected looksLikeStreetAddress(name) (family 4)
 * Invariant asserted by the node test: family !== null  <=>  junk || address.
 *
 * NOTE on 'Highland Square': the guard verdict is BLOCK (2 tokens, last is a
 * street suffix), and both implementations agree — but the guard is a
 * MINT-time law only. As an EXISTING venue the name resolves before minting
 * and never reaches the guard (normalize.js: "venues already in the DB under
 * such a name keep resolving normally"); M13 asserts that resolve-not-mint
 * behavior separately.
 */
export const GUARD_CASES = [
  // family 1: bare US state names
  { name: 'Ohio',                          family: 'state',    junk: true,  address: false },
  { name: 'New York',                      family: 'state',    junk: true,  address: false },
  // family 2: virtual/placeholder markers
  { name: 'Virtual',                       family: 'virtual',  junk: true,  address: false },
  { name: 'Online Event',                  family: 'virtual',  junk: true,  address: false },
  { name: 'Zoom',                          family: 'virtual',  junk: true,  address: false },
  { name: 'TBD',                           family: 'virtual',  junk: true,  address: false },
  // family 3: house-number-less street fragments
  { name: 'Church Street',                 family: 'fragment', junk: true,  address: false },
  { name: 'Main St',                       family: 'fragment', junk: true,  address: false },
  { name: 'Quarry Trail',                  family: 'fragment', junk: true,  address: false },
  { name: 'W Market Street',               family: 'fragment', junk: true,  address: false },
  { name: 'Highland Square',               family: 'fragment', junk: true,  address: false },
  // family 4: address-shaped names (leading house number + street suffix)
  { name: '123 Main St',                   family: 'address',  junk: false, address: true },
  { name: '943 Kenmore Blvd.',             family: 'address',  junk: false, address: true },
  { name: '1000 Kenmore Boulevard, Akron', family: 'address',  junk: false, address: true },
  { name: '134 East Tallmadge Ave',        family: 'address',  junk: false, address: true },
  // Unicode-whitespace evasion (review finding 2026-08-23): JS \s matches
  // Unicode whitespace, Postgres \s does not, so before
  // partner_fold_whitespace() these names minted through the SQL guard while
  // isJunkVenueName blocked them. These rows pin the JS/SQL parity from both
  // sides. NOTE: the matching rows in partner_accounts_rls.test.sql carry the
  // LITERAL non-ASCII characters (the sync test compares byte-for-byte);
  // here they are written as visible \u escapes.
  { name: 'Ohio\u00a0',                    family: 'state',    junk: true,  address: false }, // trailing NBSP
  { name: 'Zoom\u00a0\u00a0',              family: 'virtual',  junk: true,  address: false }, // double NBSP
  { name: 'Church\u202fStreet',            family: 'fragment', junk: true,  address: false }, // NNBSP separator
  { name: '123\u00a0Main\u00a0St',         family: 'address',  junk: false, address: true },  // NBSP-separated address
  { name: '\ufeffOhio',                    family: 'state',    junk: true,  address: false }, // zero-width no-break space
  // legitimate names that MUST pass (the known false-positive set)
  { name: 'Lock 3',                        family: null,       junk: false, address: false },
  { name: '1865 Brewing',                  family: null,       junk: false, address: false },
  { name: '16-Bit Bar+Arcade',             family: null,       junk: false, address: false },
  { name: 'Front Street Brewing',          family: null,       junk: false, address: false },
  { name: 'Townhall',                      family: null,       junk: false, address: false },
  { name: 'The Rialto Theatre',            family: null,       junk: false, address: false },
  { name: 'Musica',                        family: null,       junk: false, address: false },
]
