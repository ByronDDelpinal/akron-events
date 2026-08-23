-- ════════════════════════════════════════════════════════════════════════════
-- partner_accounts_rls.test.sql
--
-- Regression tests for migration 061 (partner accounts). Modeled on
-- supabase/tests/admin_boundary_rls.test.sql, including the "role AND claims
-- GUC together" discipline: both `set local role <role>` AND the matching
-- `request.jwt.claims` GUC are required together -- the role selects the RLS
-- policy set, the claim is what auth.uid() / moderation_request_role() read.
-- Setting only one silently tests the wrong principal (day_plan_rls:656-658).
--
-- What this file pins, per the design's test matrix (design §5 / ADR §8.3):
--   blocks 1-4   seed sanity, partner_scope() truth, M11 scope/context
--                agreement, any-of READ scope
--   block  5     the partner_may_write_event() truth table -- the QA-verified
--                table from ADR §6.8, pasted as expected values, not re-derived
--   block  6     N-series negatives (N2-N9, N13): no direct writes anywhere,
--                zero rows from the admin tables, allowlist refusals naming
--                featured / source / source_id / status
--   block  7     M-series RPC behavior (M2-M6, M9): all-of on co-hosts,
--                confused-deputy, most-restrictive-wins publishing
--   block  8     M10: the create path end to end
--   block  9     M12/M12b: override RE-STAMPING through the REAL
--                enforce_manual_overrides trigger, and the 060 reopen-review
--                interaction
--   block 10     M13: the venue-mint guard (the LAW) over the SHARED case
--                table, dedupe/resolve/alias behavior
--   block 11     moderation: partners are on the SCREENED side of the shipped
--                059 gate (deviation D11)
--   block 12     LAST, mutating: M7 partial revocation, tenant deactivation,
--                M8 revoke-everything == the N9 stranger
--
-- ⚠️  ORDER MATTERS (the admin_boundary file's trap, different cap): block 12
--     mutates the membership fixtures, so it comes AFTER everything that
--     depends on the un-revoked state, and block 8's creates come just before
--     it. Do not reorder.
--
-- ⚠️  VELOCITY-CAP RULE (house): new RLS test blocks go ABOVE any velocity-cap
--     block, because a cap block fills its 1-minute window in-transaction and
--     never unwinds it. This file contains NO velocity-cap block and MUST NOT
--     gain one except as the very last section. It seeds feedback_posts not at
--     all, so it cannot trip 043's cap.
--
-- ⚠️  M13's guard cases are one half of a SHARED CASE TABLE. The other half is
--     scripts/tests/fixtures/partner-venue-guard-cases.js, asserted against
--     scripts/lib/normalize.js by scripts/tests/test-partner-venue-guard.js --
--     which ALSO greps THIS file to confirm every shared case appears below.
--     Add/remove a case in both places or the node test goes red (the ADR
--     §6.2.2 "duplicate + test, never refactor" discipline). Keep each case
--     row in the exact form ('Name', ...) on its own line.
--
-- Cross-check: admin_boundary_rls.test.sql continues to pin the Phase-1
-- surface (P1-P6). This file does not duplicate it, but block 6's N3/N4 are
-- the PARTNER-principal analogues of P1-P4 and both files must keep both.
--
-- Self-contained: one transaction, ROLLS BACK, nothing persists. Run against
-- a DB with migrations 059+060+061 applied (the scaffold harness chain, or a
-- branch):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/partner_accounts_rls.test.sql
--
-- A clean run prints "ALL PARTNER RLS TESTS PASSED". Any failure raises.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 0. Fixtures, seeded as the connecting (owner) role ───────────────────────
-- ADR §8.3 fixture, extended (design §5): four orgs, four principals.
--
--   org A   b0..a001  "Partner Org Alpha"    tenant, auto_publish = TRUE
--   org A2  b0..a002  "Exchange Annex"       tenant, auto_publish = FALSE (P's 2nd org)
--   org B   b0..a003  "Partner Org Bravo"    tenant, another partner's org
--   org C   b0..a004  "Partner Org Charlie"  tenant, active = FALSE, P is a member
--
--   P        b0..f001  member of A, A2, C (C inactive -> contributes nothing)
--   PB       b0..f002  member of B
--   stranger b0..f003  no memberships, not an admin
--   E        b0..f004  no memberships (the empty-scope create probe)
--
-- Events: A-only pending, A-only published, A2-only pending, B-only pending,
-- A+B co-host, A+A2 co-host, ORPHAN (zero org links), two SCRAPED-shape rows
-- (source north_hill_cdc, title pinned in manual_overrides), and a multi-venue
-- event. Venues: published, address-collision, a 1-hop alias chain (the 050
-- guard forbids longer), an EXISTING guard-shaped name ("Highland Square"),
-- and a second stage for the multi-venue guard.

insert into moderation_terms (term, severity, kind) values
  ('zzzpartnerterm',        'high',    'word'),
  ('zzzpartnerextremeterm', 'extreme', 'word')
on conflict (term) do update set severity = excluded.severity, kind = excluded.kind;

insert into auth.users (id, email) values
  ('b0000000-0000-4000-8000-00000000f001', 'partner-p@example.com'),
  ('b0000000-0000-4000-8000-00000000f002', 'partner-b@example.com'),
  ('b0000000-0000-4000-8000-00000000f003', 'partner-stranger@example.com'),
  ('b0000000-0000-4000-8000-00000000f004', 'partner-empty@example.com')
on conflict (id) do nothing;

insert into organizations (id, name, status, contact_email) values
  ('b0000000-0000-4000-8000-00000000a001', 'Partner Org Alpha',   'published', 'alpha-secret@example.com'),
  ('b0000000-0000-4000-8000-00000000a002', 'Exchange Annex',      'published', 'annex-secret@example.com'),
  ('b0000000-0000-4000-8000-00000000a003', 'Partner Org Bravo',   'published', null),
  ('b0000000-0000-4000-8000-00000000a004', 'Partner Org Charlie', 'published', null);

insert into partner_orgs (organization_id, slug, active, auto_publish) values
  ('b0000000-0000-4000-8000-00000000a001', 'org-alpha',      true,  true),
  ('b0000000-0000-4000-8000-00000000a002', 'exchange-annex', true,  false),
  ('b0000000-0000-4000-8000-00000000a003', 'org-bravo',      true,  true),
  ('b0000000-0000-4000-8000-00000000a004', 'org-charlie',    false, true);

insert into partner_memberships (user_id, organization_id, email) values
  ('b0000000-0000-4000-8000-00000000f001', 'b0000000-0000-4000-8000-00000000a001', 'partner-p@example.com'),
  ('b0000000-0000-4000-8000-00000000f001', 'b0000000-0000-4000-8000-00000000a002', 'partner-p@example.com'),
  ('b0000000-0000-4000-8000-00000000f001', 'b0000000-0000-4000-8000-00000000a004', 'partner-p@example.com'),
  ('b0000000-0000-4000-8000-00000000f002', 'b0000000-0000-4000-8000-00000000a003', 'partner-b@example.com');

insert into venues (id, name, address, status) values
  ('b0000000-0000-4000-8000-00000000b001', 'Partner Test Venue One', '123 Test Ave',     'published'),
  ('b0000000-0000-4000-8000-00000000b002', 'Collision Hall',         '500 Kenmore Blvd', 'published'),
  ('b0000000-0000-4000-8000-00000000b003', 'Old Duplicate Hall',     null,               'published'),
  ('b0000000-0000-4000-8000-00000000b004', 'Canonical Hall',         '77 Canal Pl',      'published'),
  ('b0000000-0000-4000-8000-00000000b005', 'Highland Square',        null,               'published'),
  ('b0000000-0000-4000-8000-00000000b006', 'Second Stage',           null,               'published');

-- 1-hop alias: Old Duplicate Hall -> Canonical Hall (050 forbids chains).
insert into venue_aliases (alias_venue_id, canonical_venue_id, alias_name, reason) values
  ('b0000000-0000-4000-8000-00000000b003', 'b0000000-0000-4000-8000-00000000b004',
   'Old Duplicate Hall', 'partner test fixture');

insert into events (id, title, description, start_at, source, status, featured) values
  ('b0000000-0000-4000-8000-00000000e001', 'Alpha Pending Event',    'A perfectly ordinary description.', now() + interval '7 days',  'manual', 'pending_review', false),
  ('b0000000-0000-4000-8000-00000000e002', 'Alpha Published Event',  'A perfectly ordinary description.', now() + interval '8 days',  'manual', 'published',      false),
  ('b0000000-0000-4000-8000-00000000e003', 'Annex Pending Event',    'A perfectly ordinary description.', now() + interval '9 days',  'manual', 'pending_review', false),
  ('b0000000-0000-4000-8000-00000000e004', 'Bravo Pending Event',    'A perfectly ordinary description.', now() + interval '10 days', 'manual', 'pending_review', false),
  ('b0000000-0000-4000-8000-00000000e005', 'Alpha Bravo Co-Host',    'A perfectly ordinary description.', now() + interval '11 days', 'manual', 'pending_review', false),
  ('b0000000-0000-4000-8000-00000000e006', 'Alpha Annex Co-Host',    'A perfectly ordinary description.', now() + interval '12 days', 'manual', 'pending_review', false),
  ('b0000000-0000-4000-8000-00000000e007', 'Orphan Pending Event',   'A perfectly ordinary description.', now() + interval '13 days', 'manual', 'pending_review', false),
  ('b0000000-0000-4000-8000-00000000e00a', 'Alpha Multi Venue Fest', 'A perfectly ordinary description.', now() + interval '14 days', 'manual', 'published',      false);

-- The SCRAPED-shape rows (design D10 fixtures): a nightly source owns them and
-- a human pinned the title long ago.
insert into events (id, title, description, start_at, source, source_id, status, featured, manual_overrides, needs_review) values
  ('b0000000-0000-4000-8000-00000000e008', 'Scraped Title',          'A perfectly ordinary description.', now() + interval '15 days',
   'north_hill_cdc', 'partner-test-1', 'published', false,
   '{"title": {"at": "2026-01-01T00:00:00+00:00"}}'::jsonb, false),
  ('b0000000-0000-4000-8000-00000000e009', 'Scraped Flagged Title',  'A perfectly ordinary description.', now() + interval '16 days',
   'north_hill_cdc', 'partner-test-2', 'published', false,
   '{"title": {"at": "2026-01-01T00:00:00+00:00"}}'::jsonb, true);

-- The 060 triage fact for M12b: an admin already adjudicated the flagged row.
update events
   set reviewed_at = now() - interval '3 days',
       reviewed_by = 'c5b809ab-8ad0-4e2e-a985-cc709726c12b'
 where id = 'b0000000-0000-4000-8000-00000000e009';

insert into event_organizations (event_id, organization_id) values
  ('b0000000-0000-4000-8000-00000000e001', 'b0000000-0000-4000-8000-00000000a001'),
  ('b0000000-0000-4000-8000-00000000e002', 'b0000000-0000-4000-8000-00000000a001'),
  ('b0000000-0000-4000-8000-00000000e003', 'b0000000-0000-4000-8000-00000000a002'),
  ('b0000000-0000-4000-8000-00000000e004', 'b0000000-0000-4000-8000-00000000a003'),
  ('b0000000-0000-4000-8000-00000000e005', 'b0000000-0000-4000-8000-00000000a001'),
  ('b0000000-0000-4000-8000-00000000e005', 'b0000000-0000-4000-8000-00000000a003'),
  ('b0000000-0000-4000-8000-00000000e006', 'b0000000-0000-4000-8000-00000000a001'),
  ('b0000000-0000-4000-8000-00000000e006', 'b0000000-0000-4000-8000-00000000a002'),
  ('b0000000-0000-4000-8000-00000000e00a', 'b0000000-0000-4000-8000-00000000a001'),
  ('b0000000-0000-4000-8000-00000000e008', 'b0000000-0000-4000-8000-00000000a001'),
  ('b0000000-0000-4000-8000-00000000e009', 'b0000000-0000-4000-8000-00000000a001');

-- Categories: one on an A pending row (partner reads it via the third 061
-- policy), one on the B pending row (partner must NOT read it).
insert into event_categories (event_id, category) values
  ('b0000000-0000-4000-8000-00000000e001', 'music'),
  ('b0000000-0000-4000-8000-00000000e004', 'music');

-- The multi-venue event (festival-hub furniture; the set-venue guard target).
insert into event_venues (event_id, venue_id) values
  ('b0000000-0000-4000-8000-00000000e00a', 'b0000000-0000-4000-8000-00000000b001'),
  ('b0000000-0000-4000-8000-00000000e00a', 'b0000000-0000-4000-8000-00000000b006');

-- One row in each admin-only table so block 6's zero-row reads are meaningful.
insert into subscribers (id, email) values
  ('b0000000-0000-4000-8000-00000000c001', 'partner-rls@example.com');
insert into email_sends (subscriber_id, status, event_count) values
  ('b0000000-0000-4000-8000-00000000c001', 'sent', 1);
insert into embed_requests (name, email, organization, config) values
  ('Partner RLS Fixture', 'partner-rls@example.com', 'Fixture Org', '{}'::jsonb);
insert into slack_notifications (dedupe_key, kind, channel_key) values
  ('partner-rls-fixture', 'feedback', 'general');
insert into event_aliases (duplicate_source, duplicate_source_id, canonical_event_id, reason) values
  ('partner_rls_fixture', 'x-1', 'b0000000-0000-4000-8000-00000000e002', 'partner test fixture');

-- ── 1. Seed sanity ───────────────────────────────────────────────────────────
do $$
begin
  assert exists (select 1 from admin_users where user_id = 'c5b809ab-8ad0-4e2e-a985-cc709726c12b'),
    'admin roster must contain byronddelpinal@gmail.com (059 seed) or every admin assertion below is meaningless';
  assert exists (select 1 from admin_users where user_id = '5c30e2be-fb56-4b29-923d-71cce9722d80'),
    'admin roster must contain mac@artxlove.com (059 seed)';
  assert not exists (select 1 from admin_users where user_id in (
      'b0000000-0000-4000-8000-00000000f001', 'b0000000-0000-4000-8000-00000000f002',
      'b0000000-0000-4000-8000-00000000f003', 'b0000000-0000-4000-8000-00000000f004')),
    'no partner/stranger fixture may be on the admin roster; if one is, every negative below is vacuous';
  assert (select count(*) from partner_orgs) = 4, 'four tenant fixtures';
  assert (select count(*) from partner_memberships where revoked_at is null) = 4, 'four live membership fixtures';
  raise notice '  ✓ 1. seed sane: both real admins on the roster, fixtures are not';
end $$;

-- ── 2. partner_scope() truth ─────────────────────────────────────────────────
-- Called as the owner with only the claims GUC swapped: the function reads
-- auth.uid(), and it has no grant to worry about at this layer.
do $$
declare scope uuid[];
begin
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f001"}', true);
  select array_agg(x order by x) into scope from unnest(partner_scope()) x;
  assert scope = array['b0000000-0000-4000-8000-00000000a001',
                       'b0000000-0000-4000-8000-00000000a002']::uuid[],
    'P''s scope must be exactly {A, A2}: C is excluded by active = false (the §6.9 load-bearing filter), got ' || coalesce(scope::text, '<null>');

  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f002"}', true);
  select array_agg(x order by x) into scope from unnest(partner_scope()) x;
  assert scope = array['b0000000-0000-4000-8000-00000000a003']::uuid[],
    'PB''s scope must be exactly {B}';

  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f003"}', true);
  assert partner_scope() = '{}'::uuid[], 'the stranger''s scope must be empty';

  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"c5b809ab-8ad0-4e2e-a985-cc709726c12b"}', true);
  assert partner_scope() = '{}'::uuid[], 'an admin with no memberships has an EMPTY scope (ADR §8.4) -- never a fallback to everything';

  perform set_config('request.jwt.claims', '', true);
  assert partner_scope() = '{}'::uuid[], 'no claims at all -> empty scope (auth.uid() is null)';

  raise notice '  ✓ 2. partner_scope(): P={A,A2} (C inactive), PB={B}, stranger/admin/no-claims={}';
end $$;

-- ── 3. M11: partner_scope() and partner_org_context() agree ──────────────────
-- The two functions duplicate one WHERE clause ON PURPOSE (061 section 2 says
-- why refactoring them together is forbidden); this block is what keeps the
-- duplication honest, for every principal and again after block 12's revoke.
do $$
declare who text; sub text; names text[];
begin
  for who, sub in values
    ('P',        'b0000000-0000-4000-8000-00000000f001'),
    ('PB',       'b0000000-0000-4000-8000-00000000f002'),
    ('stranger', 'b0000000-0000-4000-8000-00000000f003'),
    ('admin',    'c5b809ab-8ad0-4e2e-a985-cc709726c12b')
  loop
    perform set_config('request.jwt.claims',
      '{"role":"authenticated","sub":"' || sub || '"}', true);
    assert (select coalesce(array_agg(x order by x), '{}'::uuid[]) from unnest(partner_scope()) x)
         = (select coalesce(array_agg(organization_id order by organization_id), '{}'::uuid[])
              from partner_org_context()),
      'partner_scope() and partner_org_context() disagree for ' || who || ' -- the duplicated WHERE clauses have drifted';
  end loop;

  -- Context is ordered by name and returns the allowlisted columns only.
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f001"}', true);
  select array_agg(name) into names from partner_org_context();
  assert names = array['Exchange Annex', 'Partner Org Alpha'],
    'context must be ordered by name, got ' || coalesce(names::text, '<null>');
  assert (select bool_and(auto_publish = (slug = 'org-alpha')) from partner_org_context()),
    'context must carry each org''s own auto_publish flag';
  assert pg_get_function_result('partner_org_context()'::regprocedure)
       = 'TABLE(organization_id uuid, name text, slug text, auto_publish boolean)',
    'partner_org_context''s column list is an ALLOWLIST -- organizations.contact_email must never appear on it';

  raise notice '  ✓ 3. M11: scope/context agree for all principals; context ordered by name, allowlisted columns only';
end $$;

-- ── 4. Read scope: any-of, pending rows included, nothing more ───────────────
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f001"}', true);
set local role authenticated;

do $$
begin
  -- M1: the union of A's and A2's rows, including co-hosts (any-of read),
  -- and NOTHING more. The fixture holds six pending events; P sees four.
  assert (select count(*) from events where status = 'pending_review') = 4,
    'P must see exactly the 4 pending rows in scope (A-only, A2-only, A+B, A+A2)';
  assert exists (select 1 from events where id = 'b0000000-0000-4000-8000-00000000e005'),
    'the A+B co-host must be READABLE by P (any-of read: if you co-host it, you can see it)';
  -- N1: another tenant's pending row is invisible.
  assert not exists (select 1 from events where id = 'b0000000-0000-4000-8000-00000000e004'),
    'N1: P must not see B''s pending event';
  assert not exists (select 1 from events where id = 'b0000000-0000-4000-8000-00000000e007'),
    'P must not see the orphan pending event (zero links -> zero scope)';

  -- The third 061 policy: categories of OWN pending rows.
  assert exists (select 1 from event_categories where event_id = 'b0000000-0000-4000-8000-00000000e001'),
    'P must read the categories of their own pending event (the 029 public policy stops at published)';
  assert not exists (select 1 from event_categories where event_id = 'b0000000-0000-4000-8000-00000000e004'),
    'P must NOT read categories of B''s pending event';

  -- Own org rows visible even unpublished... they are published here, so pin
  -- the sharper edge: B's org row is published and therefore PUBLICLY
  -- readable -- scope does not narrow the public surface.
  assert exists (select 1 from organizations where id = 'b0000000-0000-4000-8000-00000000a001'),
    'P reads their own org row';
  raise notice '  ✓ 4a. P reads the union of A+A2 rows incl. pending and co-hosted, zero B/orphan pending rows';
end $$;

reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f003"}', true);
set local role authenticated;

do $$
begin
  assert (select count(*) from events where status = 'pending_review') = 0,
    'the signed-in stranger sees zero pending events';
  assert (select count(*) from event_categories ec
            join events e on e.id = ec.event_id where e.status = 'pending_review') = 0,
    'the stranger sees zero categories of pending events';
  raise notice '  ✓ 4b. stranger sees zero pending rows';
end $$;

reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c5b809ab-8ad0-4e2e-a985-cc709726c12b"}', true);
set local role authenticated;

do $$
begin
  assert (select count(*) from events where status = 'pending_review') = 6,
    'the admin still sees all six pending fixture rows';
  raise notice '  ✓ 4c. admin sees everything';
end $$;

reset role;

-- ── 5. The partner_may_write_event() truth table (ADR §6.8, QA-verified) ─────
-- Pasted as expected values from the ADR -- confirmed by two independent
-- implementations; do NOT re-derive. Evaluated as the owner with P's claims
-- (the helper has no grant: it is definer-internal to the RPCs).
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f001"}', true);

do $$
declare
  ev_a     uuid := 'b0000000-0000-4000-8000-00000000e001';
  ev_a2    uuid := 'b0000000-0000-4000-8000-00000000e003';
  ev_ab    uuid := 'b0000000-0000-4000-8000-00000000e005';
  ev_aa2   uuid := 'b0000000-0000-4000-8000-00000000e006';
  ev_orph  uuid := 'b0000000-0000-4000-8000-00000000e007';
  org_a    uuid := 'b0000000-0000-4000-8000-00000000a001';
  org_a2   uuid := 'b0000000-0000-4000-8000-00000000a002';
begin
  --                                        event      | as A | as A2
  assert     partner_may_write_event(org_a,  ev_a),    -- A only     | t |
    'A-only event must be writable as A';
  assert not partner_may_write_event(org_a2, ev_a),    --            |   | f
    'A-only event must NOT be writable as A2 (clause 2: A2 is not linked)';
  assert     partner_may_write_event(org_a,  ev_aa2),  -- A+A2       | t |
    'A+A2 co-host must be writable as A (both orgs in one scope -- the case multi-org creates)';
  assert     partner_may_write_event(org_a2, ev_aa2),  --            |   | t
    'A+A2 co-host must be writable as A2';
  assert not partner_may_write_event(org_a,  ev_ab),   -- A+B        | f |
    'A+B co-host must NOT be writable as A (all-of: B is outside P''s scope)';
  assert not partner_may_write_event(org_a2, ev_ab),   --            |   | f
    'A+B co-host must NOT be writable as A2 (clause 2 AND clause 3)';
  assert not partner_may_write_event(org_a,  ev_a2),   -- A2 only    | f |
    'A2-only event must NOT be writable AS A (clause 2, the anti-laundering guard)';
  assert     partner_may_write_event(org_a2, ev_a2),   --            |   | t
    'A2-only event must be writable as A2';
  assert not partner_may_write_event(org_a,  ev_orph), -- ORPHAN     | f | f
    'the ORPHAN must not be writable -- the vacuous-truth trap: clause 2 supplies the non-vacuity clause 3 cannot';
  assert not partner_may_write_event(org_a2, ev_orph),
    'the orphan must not be writable as A2 either';
  assert not partner_may_write_event('b0000000-0000-4000-8000-00000000a004', ev_a),
    'org C is in P''s memberships but active = false: acting as C must fail clause 1';
  assert not partner_may_write_event(org_a, gen_random_uuid()),
    'a nonexistent event refuses exactly like a foreign one (clause 2) -- no existence oracle';

  -- Empty scope fails closed (the expression property somebody may rewrite).
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f004"}', true);
  assert not partner_may_write_event(org_a, ev_a),  'empty scope must fail closed in the write rule';
  assert not partner_may_create_for_org(org_a),     'empty scope must fail closed in the create rule';

  raise notice '  ✓ 5. partner_may_write_event() reproduces the ADR §6.8 QA truth table exactly';
end $$;

-- ── 6. N-series: the partner principal gets NO direct write, anywhere ────────
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f001"}', true);
set local role authenticated;

do $$
declare n int;
begin
  -- N2: no partner UPDATE policy on events exists -- not even on their OWN
  -- rows. All writes are RPC-only. (RLS filters the row out; zero rows, no
  -- exception -- count the rows, as the admin file's §3 note explains.)
  update events set title = 'partner rewrote this directly'
   where id = 'b0000000-0000-4000-8000-00000000e001';
  get diagnostics n = row_count;
  assert n = 0, 'N2: direct UPDATE on P''s own event must affect zero rows, affected ' || n;

  update events set title = 'partner rewrote this directly'
   where id = 'b0000000-0000-4000-8000-00000000e004';
  get diagnostics n = row_count;
  assert n = 0, 'N2: direct UPDATE on B''s event must affect zero rows';

  -- N13: no partner UPDATE on organizations either -- own row included
  -- (ADR §6.6 ruling: org-profile editing is OUT of v1, in full).
  update organizations set name = 'renamed by partner'
   where id = 'b0000000-0000-4000-8000-00000000a001';
  get diagnostics n = row_count;
  assert n = 0, 'N13: P must not UPDATE organizations, not even their own row';

  -- N4: cannot DELETE any junction row, including their own scope edge.
  delete from event_organizations
   where event_id = 'b0000000-0000-4000-8000-00000000e001';
  get diagnostics n = row_count;
  assert n = 0, 'N4: P must not DELETE their own event_organizations edge';

  delete from event_venues
   where event_id = 'b0000000-0000-4000-8000-00000000e00a';
  get diagnostics n = row_count;
  assert n = 0, 'N4: P must not DELETE event_venues rows';

  raise notice '  ✓ 6a. N2/N4/N13: zero direct UPDATE/DELETE anywhere, own rows included';
end $$;

do $$
begin
  -- N3: the scope edge is unwritable by the partner principal (the analogue
  -- of admin_boundary P1/P4; the create-path variant is block 8's (b)).
  begin
    insert into event_organizations (event_id, organization_id)
    values ('b0000000-0000-4000-8000-00000000e007', 'b0000000-0000-4000-8000-00000000a001');
    raise exception 'N3: partner insert into event_organizations (orphan capture) should have been rejected';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into event_organizations (event_id, organization_id)
    values ('b0000000-0000-4000-8000-00000000e004', 'b0000000-0000-4000-8000-00000000a001');
    raise exception 'N3: partner insert linking their org to B''s event should have been rejected';
  exception when insufficient_privilege then null;
  end;

  -- N5: zero rows from the six admin-only tables (each holds a fixture row,
  -- so zero is a real assertion, not an empty table).
  assert (select count(*) from subscribers)         = 0, 'N5: partner must not read subscribers';
  assert (select count(*) from email_sends)         = 0, 'N5: partner must not read email_sends';
  assert (select count(*) from embed_requests)      = 0, 'N5: partner must not read embed_requests';
  assert (select count(*) from slack_notifications) = 0, 'N5: partner must not read slack_notifications';
  assert (select count(*) from event_aliases)       = 0, 'N5: partner must not read event_aliases';
  assert (select count(*) from venue_aliases)       = 0, 'N5: partner must not read venue_aliases';

  -- And the partner roster tables themselves: reachable ONLY through
  -- partner_org_context(), never through PostgREST table reads.
  assert (select count(*) from partner_orgs)        = 0, 'partner must not read partner_orgs directly';
  assert (select count(*) from partner_memberships) = 0, 'partner must not read partner_memberships directly';

  raise notice '  ✓ 6b. N3/N5: scope edge unwritable; zero rows from every admin table and the roster tables';
end $$;

do $$
declare r jsonb;
begin
  -- N6/N7/N8: the allowlist refuses the forbidden columns BY NAME. The
  -- refusal must name the key (a typo'd column must never be silently
  -- dropped, and neither must an attack).
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                              'b0000000-0000-4000-8000-00000000e001',
                              '{"featured": true}'::jsonb);
    raise exception 'N6: featured in p_patch should have been refused';
  exception when invalid_parameter_value then
    assert sqlerrm like '%featured%', 'the featured refusal must name the key, got: ' || sqlerrm;
  end;
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                              'b0000000-0000-4000-8000-00000000e001',
                              '{"source": "ticketmaster"}'::jsonb);
    raise exception 'N7: source in p_patch should have been refused';
  exception when invalid_parameter_value then
    assert sqlerrm like '%source%', 'the source refusal must name the key';
  end;
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                              'b0000000-0000-4000-8000-00000000e001',
                              '{"source_id": "hijack-1"}'::jsonb);
    raise exception 'N7: source_id in p_patch should have been refused';
  exception when invalid_parameter_value then
    assert sqlerrm like '%source_id%', 'the source_id refusal must name the key';
  end;
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                              'b0000000-0000-4000-8000-00000000e001',
                              '{"status": "published"}'::jsonb);
    raise exception 'N8: status in p_patch should have been refused (only partner_set_event_status changes status)';
  exception when invalid_parameter_value then
    assert sqlerrm like '%status%', 'the status refusal must name the key';
  end;
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                              'b0000000-0000-4000-8000-00000000e001',
                              '{"manual_overrides": {"title": {"at": "2000-01-01"}}}'::jsonb);
    raise exception 'manual_overrides in p_patch should have been refused (RPC-computed only)';
  exception when invalid_parameter_value then null;
  end;
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                              'b0000000-0000-4000-8000-00000000e001',
                              '{"reviewed_at": null}'::jsonb);
    raise exception 'reviewed_at in p_patch should have been refused (admin triage fact)';
  exception when invalid_parameter_value then null;
  end;

  -- Finding 3 (review 2026-08-23): p_venue on the UPDATE branch raises
  -- instead of silently ignoring a validated argument -- venue changes on an
  -- existing event go through partner_set_event_venue (the multi-venue guard
  -- lives there).
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                              'b0000000-0000-4000-8000-00000000e001',
                              '{"title": "with venue"}'::jsonb,
                              p_venue => 'b0000000-0000-4000-8000-00000000b001');
    raise exception 'p_venue on the update branch should have been refused, not silently dropped';
  exception when invalid_parameter_value then
    assert sqlerrm like '%partner_set_event_venue%',
      'the p_venue refusal must point at partner_set_event_venue, got: ' || sqlerrm;
  end;

  -- N8's second half: no status at all on an out-of-scope event.
  begin
    r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                  'b0000000-0000-4000-8000-00000000e004', 'cancelled');
    raise exception 'N8: status change on an out-of-scope event should have been refused';
  exception when insufficient_privilege then null;
  end;
  -- And pending_review is never a partner-REQUESTED status (ADR §6.4).
  begin
    r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                  'b0000000-0000-4000-8000-00000000e001', 'pending_review');
    raise exception 'requesting pending_review should have been refused -- the queue is the RPC''s decision, not the caller''s';
  exception when invalid_parameter_value then null;
  end;

  raise notice '  ✓ 6c. N6/N7/N8: featured / source / source_id / status / manual_overrides / reviewed_at all refused by name';
end $$;

-- N9: the signed-in stranger -- every RPC refuses, every scoped read is empty.
-- Block 12's M8 asserts a fully-revoked partner against THESE SAME
-- expectations so the two cannot drift.
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f003"}', true);
set local role authenticated;

do $$
declare r jsonb;
begin
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001', null,
                              '{"title": "stranger event", "start_at": "2026-12-01T18:00:00Z"}'::jsonb);
    raise exception 'N9: stranger create should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                              'b0000000-0000-4000-8000-00000000e001', '{"title": "x"}'::jsonb);
    raise exception 'N9: stranger update should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                  'b0000000-0000-4000-8000-00000000e001', 'cancelled');
    raise exception 'N9: stranger status change should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_set_event_categories('b0000000-0000-4000-8000-00000000a001',
                                      'b0000000-0000-4000-8000-00000000e001', array['music']);
    raise exception 'N9: stranger category change should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_set_event_venue('b0000000-0000-4000-8000-00000000a001',
                                 'b0000000-0000-4000-8000-00000000e001',
                                 'b0000000-0000-4000-8000-00000000b001');
    raise exception 'N9: stranger venue change should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001',
                            'Stranger Hall', '1 Nowhere Ln');
    raise exception 'N9: stranger venue mint should have been refused';
  exception when insufficient_privilege then null;
  end;

  assert (select count(*) from partner_org_context()) = 0, 'N9: stranger context is empty';
  assert (select count(*) from events where status = 'pending_review') = 0, 'N9: stranger sees zero pending rows';

  raise notice '  ✓ 6d. N9: the signed-in stranger is refused by all six RPCs and reads nothing scoped';
end $$;

-- ── 7. M-series: RPC behavior inside scope ───────────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f001"}', true);
set local role authenticated;

do $$
declare r jsonb; n int;
begin
  -- M2: P writes an A-only and an A2-only event through each RPC family.
  r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                            'b0000000-0000-4000-8000-00000000e001',
                            '{"title": "Alpha Pending Event (edited)", "price_min": 5, "price_max": 12}'::jsonb);
  assert r ->> 'id' = 'b0000000-0000-4000-8000-00000000e001' and r ->> 'status' = 'pending_review',
    'M2: A-only update returns the row id and its (unchanged) status';
  assert (select title from events where id = 'b0000000-0000-4000-8000-00000000e001')
         = 'Alpha Pending Event (edited)', 'M2: the title actually changed';

  r := partner_upsert_event('b0000000-0000-4000-8000-00000000a002',
                            'b0000000-0000-4000-8000-00000000e003',
                            '{"description": "Updated by the Annex."}'::jsonb);
  assert (select description from events where id = 'b0000000-0000-4000-8000-00000000e003')
         = 'Updated by the Annex.', 'M2: A2-only update lands';

  r := partner_set_event_categories('b0000000-0000-4000-8000-00000000a001',
                                    'b0000000-0000-4000-8000-00000000e001',
                                    array['music','civic']);
  assert (select count(*) from event_categories where event_id = 'b0000000-0000-4000-8000-00000000e001') = 2,
    'M2: category swap lands (transactional; no client-side interleave needed)';
  assert (select category_slugs from events where id = 'b0000000-0000-4000-8000-00000000e001')
         = array['civic','music'], 'M2: the 039 slug-sync trigger maintained category_slugs';

  r := partner_set_event_venue('b0000000-0000-4000-8000-00000000a001',
                               'b0000000-0000-4000-8000-00000000e001',
                               'b0000000-0000-4000-8000-00000000b001');
  assert (select count(*) from event_venues where event_id = 'b0000000-0000-4000-8000-00000000e001') = 1,
    'M2: set-venue lands';

  -- Set-venue is SET semantics: null clears.
  r := partner_set_event_venue('b0000000-0000-4000-8000-00000000a001',
                               'b0000000-0000-4000-8000-00000000e001', null);
  assert (select count(*) from event_venues where event_id = 'b0000000-0000-4000-8000-00000000e001') = 0,
    'M2: set-venue null clears the link';

  r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                'b0000000-0000-4000-8000-00000000e002', 'cancelled');
  assert r ->> 'status' = 'cancelled', 'M2: cancel is always allowed within the write rule';

  -- CANCELLED IS FINAL FOR PARTNERS (review finding 5, session-lead product
  -- ruling 2026-08-23): a partner may cancel, but may never move ANY event
  -- out of cancelled -- their own cancels included. Restoring is admin-only,
  -- which is what makes an ADMIN takedown of a partner event durable.
  begin
    r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                  'b0000000-0000-4000-8000-00000000e002', 'published');
    raise exception 'republishing a cancelled event should have been refused (cancellation is final for partners)';
  exception when insufficient_privilege then
    assert sqlerrm like '%cancel%', 'the refusal should explain cancellation, got: ' || sqlerrm;
  end;
  assert (select status from events where id = 'b0000000-0000-4000-8000-00000000e002') = 'cancelled',
    'the cancelled row stayed cancelled';

  r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                'b0000000-0000-4000-8000-00000000e001', 'published');
  assert r ->> 'status' = 'published' and r ->> 'review_required_by' is null,
    'M2: publishing an A-only event publishes directly (A is auto_publish = true)';

  -- M3: the A+A2 co-host is FULLY writable (all-of satisfied inside one scope).
  r := partner_upsert_event('b0000000-0000-4000-8000-00000000a002',
                            'b0000000-0000-4000-8000-00000000e006',
                            '{"title": "Alpha Annex Co-Host (edited)"}'::jsonb);
  assert (select title from events where id = 'b0000000-0000-4000-8000-00000000e006')
         = 'Alpha Annex Co-Host (edited)', 'M3: A+A2 co-host writable as A2';

  -- M9: publishing it resolves to review, most-restrictive-wins, and the RPC
  -- NAMES the blocking org (loud, not silent -- ADR §6.9).
  r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                'b0000000-0000-4000-8000-00000000e006', 'published');
  assert r ->> 'status' = 'pending_review',
    'M9: A+A2 publish must land in review (A2 is auto_publish = false; laundering through A must not work)';
  assert r ->> 'review_required_by' = 'Exchange Annex',
    'M9: review_required_by must NAME the blocking org, got ' || coalesce(r ->> 'review_required_by', '<null>');

  raise notice '  ✓ 7a. M2/M3/M9: in-scope writes land through every RPC; co-host publish resolves most-restrictive and names the org';
end $$;

do $$
declare r jsonb;
begin
  -- M4: the A+B co-host is readable but refused by ALL four write RPCs --
  -- repeated per RPC because the check is easy to add to one and forget in
  -- three.
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                              'b0000000-0000-4000-8000-00000000e005', '{"title": "x"}'::jsonb);
    raise exception 'M4: upsert on the A+B co-host should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                  'b0000000-0000-4000-8000-00000000e005', 'cancelled');
    raise exception 'M4: status change on the A+B co-host should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_set_event_categories('b0000000-0000-4000-8000-00000000a001',
                                      'b0000000-0000-4000-8000-00000000e005', array['music']);
    raise exception 'M4: category change on the A+B co-host should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_set_event_venue('b0000000-0000-4000-8000-00000000a001',
                                 'b0000000-0000-4000-8000-00000000e005',
                                 'b0000000-0000-4000-8000-00000000b001');
    raise exception 'M4: venue change on the A+B co-host should have been refused';
  exception when insufficient_privilege then null;
  end;

  -- M5: the orphan is refused (vacuous-truth trap, through the API shape).
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                              'b0000000-0000-4000-8000-00000000e007', '{"title": "x"}'::jsonb);
    raise exception 'M5: the orphan event should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                  'b0000000-0000-4000-8000-00000000e007', 'cancelled');
    raise exception 'M5: status change on the orphan should have been refused';
  exception when insufficient_privilege then null;
  end;

  -- M6: the confused deputy. Both A and A2 are in P's scope, but naming the
  -- PERMISSIVE org while targeting the RESTRICTIVE org's event is policy
  -- laundering, and clause 2 kills it.
  begin
    r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                  'b0000000-0000-4000-8000-00000000e003', 'published');
    raise exception 'M6: publishing an A2-only event AS A should have been refused (clause 2)';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ 7b. M4/M5/M6: co-host with B refused by all four RPCs; orphan refused; confused deputy refused';
end $$;

-- ── 8. M10: the create path ──────────────────────────────────────────────────
do $$
declare r jsonb; new_id uuid; n int;
begin
  -- (a)..(d): create for A2 (auto_publish = false).
  r := partner_upsert_event('b0000000-0000-4000-8000-00000000a002', null,
        '{"title": "Annex Created Event", "start_at": "2026-12-05T23:00:00Z", "description": "Made by the partner flow."}'::jsonb);
  new_id := (r ->> 'id')::uuid;
  assert new_id is not null, 'M10(a): create returns the new id';
  assert r ->> 'status' = 'pending_review',
    'M10(d): A2 create lands pending_review (auto_publish = false degenerating through the general scan)';
  assert r ->> 'review_required_by' = 'Exchange Annex',
    'M10(d): the review message names the org';

  select count(*) into n from event_organizations where event_id = new_id;
  assert n = 1, 'M10(b): EXACTLY one junction row, got ' || n;
  assert exists (select 1 from event_organizations
                  where event_id = new_id
                    and organization_id = 'b0000000-0000-4000-8000-00000000a002'),
    'M10(b): and it is (new_id, A2)';
  assert (select source from events where id = new_id) = 'partner:exchange-annex',
    'M10(c): source is partner:<A2 slug>, resolved server-side';
  assert (select featured from events where id = new_id) = false,
    'create hard-sets featured = false';
  assert (select manual_overrides ? 'title' and manual_overrides ? 'start_at' and manual_overrides ? 'status'
            from events where id = new_id),
    'create stamps every patch field PLUS status (uniform with withStatusLock; survives any future importer)';

  -- (e): immediately writable through all four RPCs, and SELECT-visible to P
  -- (the RETURNING/refetch rule: the client refetches after create, and the
  -- 061 events policy is what makes the pending row come back).
  assert exists (select 1 from events where id = new_id),
    'M10(e): the fresh pending row is SELECT-visible to P through the partner read policy';
  r := partner_upsert_event('b0000000-0000-4000-8000-00000000a002', new_id,
                            '{"description": "Edited right after create."}'::jsonb);
  r := partner_set_event_categories('b0000000-0000-4000-8000-00000000a002', new_id, array['civic']);
  r := partner_set_event_venue('b0000000-0000-4000-8000-00000000a002', new_id,
                               'b0000000-0000-4000-8000-00000000b001');
  r := partner_set_event_status('b0000000-0000-4000-8000-00000000a002', new_id, 'cancelled');
  assert r ->> 'status' = 'cancelled', 'M10(e): the fresh row is writable through all four RPCs';

  -- Create for A publishes directly.
  r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001', null,
        '{"title": "Alpha Created Event", "start_at": "2026-12-06T23:00:00Z"}'::jsonb);
  assert r ->> 'status' = 'published' and r ->> 'review_required_by' is null,
    'M10: create for A (auto_publish = true) publishes directly';

  -- p_venue and p_categories land on create, and the category lock is
  -- stamped into the same insert.
  r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001', null,
        '{"title": "Alpha Created With Extras", "start_at": "2026-12-07T22:00:00Z"}'::jsonb,
        p_venue      => 'b0000000-0000-4000-8000-00000000b001',
        p_categories => array['music','theater']);
  new_id := (r ->> 'id')::uuid;
  assert (select count(*) from event_venues where event_id = new_id) = 1, 'M10: p_venue linked on create';
  assert (select count(*) from event_categories where event_id = new_id) = 2, 'M10: p_categories landed on create';
  assert (select manual_overrides ? 'category' from events where id = new_id),
    'M10: the category lock is stamped on create';

  -- Negatives on the same path.
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a003', null,
          '{"title": "cross-tenant create", "start_at": "2026-12-08T23:00:00Z"}'::jsonb);
    raise exception 'M10: create with p_org = B should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a002', null,
          '{"start_at": "2026-12-08T23:00:00Z"}'::jsonb);
    raise exception 'M10: create without a title should have been refused';
  exception when invalid_parameter_value then null;
  end;
  -- A non-null, nonexistent p_event must take the UPDATE branch and refuse --
  -- never a silent create, never an existence oracle.
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a002',
                              gen_random_uuid(), '{"title": "ghost"}'::jsonb);
    raise exception 'M10: a nonexistent non-null p_event must refuse, not create';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ 8a. M10: create path -- one edge row, forged-proof source, per-tenant status, immediately writable + visible';
end $$;

-- Empty-scope create refusal, as the temp user with no memberships.
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f004"}', true);
set local role authenticated;

do $$
declare r jsonb;
begin
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001', null,
          '{"title": "empty scope create", "start_at": "2026-12-09T23:00:00Z"}'::jsonb);
    raise exception 'M10/M8: create with an EMPTY scope should have been refused';
  exception when insufficient_privilege then null;
  end;
  raise notice '  ✓ 8b. M10: empty-scope create fails closed';
end $$;

-- ── 9. M12: override re-stamping through the REAL trigger (design D10) ───────
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgname = 'trg_enforce_manual_overrides_events'
                    and tgrelid = 'events'::regclass) then
    -- On a DB without the out-of-band trigger this block still passes
    -- (nothing to defeat), and this notice is what stops a green run on a
    -- bare DB from masquerading as the full result.
    raise notice '  ⚠  9. trg_enforce_manual_overrides_events is ABSENT on this database: block 9 exercises the RPC merge only, NOT the revert-defeat';
  end if;
end $$;

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f001"}', true);
set local role authenticated;

do $$
declare r jsonb;
begin
  -- The pinned title: an UPDATE that does not re-stamp the key is silently
  -- reverted by the trigger. The RPC's server-side merge re-stamps with a
  -- fresh now(), so the edit must ACTUALLY LAND. This is the assertion that
  -- fails if the RPC ever forgets the merge.
  r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                            'b0000000-0000-4000-8000-00000000e008',
                            '{"title": "Corrected By Partner"}'::jsonb);
  assert (select title from events where id = 'b0000000-0000-4000-8000-00000000e008')
         = 'Corrected By Partner',
    'M12: the partner edit to a PINNED title must survive enforce_manual_overrides (re-stamp defeated the revert)';
  assert (select (manual_overrides -> 'title' ->> 'at')::timestamptz
            from events where id = 'b0000000-0000-4000-8000-00000000e008')
         > '2026-01-02T00:00:00+00:00'::timestamptz,
    'M12: manual_overrides.title.at moved to a fresh stamp';

  -- Status stamp via the status RPC.
  r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                'b0000000-0000-4000-8000-00000000e008', 'published');
  assert (select manual_overrides ? 'status' from events where id = 'b0000000-0000-4000-8000-00000000e008'),
    'M12: partner_set_event_status stamps status: {at}';

  -- Category stamp via the category RPC.
  r := partner_set_event_categories('b0000000-0000-4000-8000-00000000a001',
                                    'b0000000-0000-4000-8000-00000000e008', array['civic']);
  assert (select manual_overrides ? 'category' from events where id = 'b0000000-0000-4000-8000-00000000e008'),
    'M12: partner_set_event_categories stamps category: {at} (key stays category, the drawer''s canonical choice)';

  -- No partner path stamps the admin triage facts.
  assert (select reviewed_at is null and reviewed_by is null
            from events where id = 'b0000000-0000-4000-8000-00000000e008'),
    'M12: reviewed_at / reviewed_by untouched by every partner path on this row';

  raise notice '  ✓ 9a. M12: pinned-title edit lands through the real trigger; status and category stamps written; triage facts untouched';
end $$;

do $$
declare r jsonb;
begin
  -- M12b: the 060 reopen-review interaction, pinned as INTENDED. The flagged
  -- row was adjudicated (needs_review = true, reviewed_at set). A partner is
  -- a non-admin authenticated caller, so a material change (title) clears
  -- reviewed_at: the row deserves another admin look.
  assert (select reviewed_at is not null from events where id = 'b0000000-0000-4000-8000-00000000e009'),
    'M12b precondition: the flagged row starts adjudicated';

  -- A non-material RPC first: status change must NOT clear the triage fact
  -- (trg_events_reopen_review fires only on UPDATE OF title, start_at).
  -- AND (finding 1, review 2026-08-23): this row has needs_review = true, so
  -- the publish request must resolve to pending_review -- a flagged row never
  -- reaches publication through this RPC; it is the admin's to clear.
  r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                'b0000000-0000-4000-8000-00000000e009', 'published');
  assert r ->> 'status' = 'pending_review',
    'M12b/finding 1: publishing a needs_review row must land in pending_review, got ' || (r ->> 'status');
  assert (select reviewed_at is not null from events where id = 'b0000000-0000-4000-8000-00000000e009'),
    'M12b: a status change does not reopen review';

  r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                            'b0000000-0000-4000-8000-00000000e009',
                            '{"title": "Scraped Flagged Title (partner fix)"}'::jsonb);
  assert (select title from events where id = 'b0000000-0000-4000-8000-00000000e009')
         = 'Scraped Flagged Title (partner fix)',
    'M12b: the pinned-title edit itself lands';
  assert (select reviewed_at is null and reviewed_by is null
            from events where id = 'b0000000-0000-4000-8000-00000000e009'),
    'M12b: a partner title edit on a needs_review row CLEARS reviewed_at (060 trigger; accepted v1 behavior)';

  raise notice '  ✓ 9b. M12b: partner title edit reopens review on a flagged row; status change does not';
end $$;

-- ── 10. M13: the venue guard (the LAW) over the shared case table ────────────
-- One half of the shared table; the other half is
-- scripts/tests/fixtures/partner-venue-guard-cases.js (JS verdicts asserted
-- by scripts/tests/test-partner-venue-guard.js, which also greps this file
-- for every case name). Keep each row in the exact ('Name', 'family') form.
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare
  rec record;
  v_reason text;
  v_expect text;
begin
  for rec in
    select * from (values
      -- family 1: bare US state names
      ('Ohio',                           'state'),
      ('New York',                       'state'),
      -- family 2: virtual/placeholder markers
      ('Virtual',                        'virtual'),
      ('Online Event',                   'virtual'),
      ('Zoom',                           'virtual'),
      ('TBD',                            'virtual'),
      -- family 3: house-number-less street fragments
      ('Church Street',                  'fragment'),
      ('Main St',                        'fragment'),
      ('Quarry Trail',                   'fragment'),
      ('W Market Street',                'fragment'),
      ('Highland Square',                'fragment'),
      -- family 4: address-shaped names (leading house number + suffix)
      ('123 Main St',                    'address'),
      ('943 Kenmore Blvd.',              'address'),
      ('1000 Kenmore Boulevard, Akron',  'address'),
      ('134 East Tallmadge Ave',         'address'),
      -- Unicode-whitespace evasion (review finding 2026-08-23): these rows
      -- contain LITERAL non-ASCII whitespace (NBSP, NNBSP, U+FEFF) on
      -- purpose -- the node sync test compares them byte-for-byte with the
      -- \u-escaped rows in partner-venue-guard-cases.js. Do not "fix" the
      -- invisible characters.
      ('Ohio ',                     'state'),
      ('Zoom  ',                'virtual'),
      ('Church Street',             'fragment'),
      ('123 Main St',           'address'),
      ('﻿Ohio',                     'state'),
      -- legitimate names that MUST pass (the known false-positive set)
      ('Lock 3',                         null),
      ('1865 Brewing',                   null),
      ('16-Bit Bar+Arcade',              null),
      ('Front Street Brewing',           null),
      ('Townhall',                       null),
      ('The Rialto Theatre',             null),
      ('Musica',                         null)
    ) as t(name, family)
  loop
    v_reason := partner_venue_name_blocked(rec.name);
    v_expect := case rec.family
      when 'state'    then 'That looks like a state name, not a venue. Type the venue''s name.'
      when 'virtual'  then 'Virtual and placeholder locations are not venues. Leave the venue empty instead.'
      when 'fragment' then 'That looks like a street name without a number, not a venue name. Type the venue''s name and put the address in the address field.'
      when 'address'  then 'That looks like a street address, not a venue name. Type the venue''s name and put the address in the address field.'
      else null end;
    if rec.family is null then
      assert v_reason is null,
        'M13 guard: "' || rec.name || '" must PASS, got blocked with: ' || coalesce(v_reason, '');
    else
      assert v_reason = v_expect,
        'M13 guard: "' || rec.name || '" must be blocked as ' || rec.family || ', got: ' || coalesce(v_reason, '<pass>');
    end if;
  end loop;
  raise notice '  ✓ 10a. M13: guard verdicts match the shared case table (all rows)';
end $$;

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f001"}', true);
set local role authenticated;

do $$
declare r jsonb;
begin
  -- Resolve-before-mint: NAME match (case-variant) never mints a duplicate.
  r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001',
                          'PARTNER TEST VENUE ONE', null);
  assert (r ->> 'created')::boolean = false
     and r ->> 'venue_id' = 'b0000000-0000-4000-8000-00000000b001',
    'M13: exact-name (case-folded) mint resolves onto the existing venue';
  assert r ->> 'name' = 'Partner Test Venue One',
    'M13: resolve returns the CANONICAL name';

  -- ADDRESS match (with a city tail) resolves too.
  r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001',
                          'Collision Annex', '500 Kenmore Blvd, Akron, OH 44314');
  assert (r ->> 'created')::boolean = false
     and r ->> 'venue_id' = 'b0000000-0000-4000-8000-00000000b002',
    'M13: normalized-address mint resolves onto the existing venue';

  -- Alias chase: resolving the aliased name lands on the CANONICAL id.
  r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001',
                          'Old Duplicate Hall', null);
  assert (r ->> 'created')::boolean = false
     and r ->> 'venue_id' = 'b0000000-0000-4000-8000-00000000b004'
     and r ->> 'name' = 'Canonical Hall',
    'M13: the venue_aliases chain resolves to the canonical venue';

  -- An EXISTING guard-shaped name resolves rather than minting: the guard is
  -- a MINT-time law only (normalize.js: "venues already in the DB under such
  -- a name keep resolving normally").
  r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001',
                          'Highland Square', null);
  assert (r ->> 'created')::boolean = false
     and r ->> 'venue_id' = 'b0000000-0000-4000-8000-00000000b005',
    'M13: an existing guard-shaped venue name is resolve-not-mint and never reaches the guard';

  -- Blocked mints raise check_violation with the guard''s reason verbatim
  -- (the UI shows it under the field).
  begin
    r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001', 'Church Street', null);
    raise exception 'M13: minting "Church Street" should have been blocked';
  exception when check_violation then
    assert sqlerrm like '%street name without a number%', 'fragment reason expected, got: ' || sqlerrm;
  end;
  begin
    r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001', '123 Main St', null);
    raise exception 'M13: minting "123 Main St" should have been blocked';
  exception when check_violation then
    assert sqlerrm like '%street address%', 'address reason expected, got: ' || sqlerrm;
  end;
  begin
    r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001', 'Ohio', null);
    raise exception 'M13: minting "Ohio" should have been blocked';
  exception when check_violation then null;
  end;
  begin
    r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001', 'Zoom', null);
    raise exception 'M13: minting "Zoom" should have been blocked';
  exception when check_violation then null;
  end;

  -- Unicode-whitespace evasion (review finding 2, 2026-08-23): before
  -- partner_fold_whitespace() these minted, because Postgres \s does not
  -- match NBSP/NNBSP while JS \s does. Built with chr() so the payload is
  -- explicit.
  begin
    r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001', 'Ohio' || chr(160), null);
    raise exception 'M13: minting "Ohio<nbsp>" should have been blocked (unicode whitespace folds)';
  exception when check_violation then
    assert sqlerrm like '%state name%', 'nbsp-Ohio must be blocked as a state name, got: ' || sqlerrm;
  end;
  begin
    r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001',
                            'Church' || chr(8239) || 'Street', null);
    raise exception 'M13: minting "Church<nnbsp>Street" should have been blocked';
  exception when check_violation then
    assert sqlerrm like '%street name without a number%', 'nnbsp fragment must be blocked, got: ' || sqlerrm;
  end;
  -- ...and the fold applies to the RESOLVE key too: an nbsp-padded existing
  -- name resolves instead of minting a whitespace-variant duplicate.
  r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001',
                          'Partner Test Venue One' || chr(160), null);
  assert (r ->> 'created')::boolean = false
     and r ->> 'venue_id' = 'b0000000-0000-4000-8000-00000000b001',
    'M13: an nbsp-padded existing name resolves onto the existing venue';

  -- Finding 4 (review 2026-08-23): a BARE HOUSE NUMBER as the address must
  -- never prefix-bind an unrelated venue ("500" used to resolve onto the
  -- venue at "500 Kenmore Blvd"). Single-token address keys match by
  -- equality only, so this mints a NEW venue.
  r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001',
                          'Completely Unrelated Gallery', '500');
  assert (r ->> 'created')::boolean = true
     and r ->> 'venue_id' <> 'b0000000-0000-4000-8000-00000000b002',
    'finding 4: a bare-house-number address must mint, not bind the venue at 500 Kenmore Blvd';

  -- A legitimate mint: HTML stripped, pending_review, listed, details
  -- allowlist honored.
  r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001',
                          '<b>New Venue Hall</b>', '742 Fictional Way', 'Akron',
                          '{"website": "https://newvenuehall.example", "description": "A fine hall."}'::jsonb);
  assert (r ->> 'created')::boolean = true, 'M13: a legitimate name mints';
  assert r ->> 'name' = 'New Venue Hall', 'M13: HTML wrapping is stripped from the minted name';
  assert exists (select 1 from venues
                  where id = (r ->> 'venue_id')::uuid
                    and status = 'pending_review' and listed
                    and website = 'https://newvenuehall.example'),
    'M13: minted venue lands pending_review + listed with allowlisted details';

  -- p_details is an allowlist too.
  begin
    r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001',
                            'Another Fine Hall', null, null, '{"lat": 41.08}'::jsonb);
    raise exception 'M13: lat in p_details should have been refused (geocoding is the pipeline''s job)';
  exception when invalid_parameter_value then null;
  end;

  -- The multi-venue guard on set-venue: festival furniture is admin-curated.
  begin
    r := partner_set_event_venue('b0000000-0000-4000-8000-00000000a001',
                                 'b0000000-0000-4000-8000-00000000e00a',
                                 'b0000000-0000-4000-8000-00000000b001');
    raise exception 'M13: set-venue on a 2-venue event should have been refused';
  exception when check_violation then
    assert sqlerrm like '%multiple venues%', 'multi-venue message expected, got: ' || sqlerrm;
  end;
  assert (select count(*) from event_venues where event_id = 'b0000000-0000-4000-8000-00000000e00a') = 2,
    'M13: the refused set-venue clobbered nothing';

  raise notice '  ✓ 10b. M13: resolve-by-name/address/alias, mint-time guard, HTML strip, details allowlist, multi-venue guard';
end $$;

-- Empty scope cannot mint either (minting is a create-family right).
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f004"}', true);
set local role authenticated;

do $$
declare r jsonb;
begin
  begin
    r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001', 'Empty Scope Hall', null);
    raise exception 'M13: an empty-scope mint should have been refused';
  exception when insufficient_privilege then null;
  end;
  raise notice '  ✓ 10c. M13: empty-scope mint refused';
end $$;

-- ── 11. Moderation: partners are on the SCREENED side of the shipped gate ────
-- Deviation D11: the live gate is `service_role or is_admin() or NULL claims`.
-- A partner is authenticated and not an admin, so their free text is screened
-- even through the definer RPC -- exactly the population the screen exists
-- for. The RPC reports the ACTUAL post-trigger status, never a lie.
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f001"}', true);
set local role authenticated;

do $$
declare r jsonb; new_id uuid;
begin
  r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001', null,
        '{"title": "Gala night zzzpartnerterm special", "start_at": "2026-12-10T23:00:00Z"}'::jsonb);
  new_id := (r ->> 'id')::uuid;
  assert r ->> 'status' = 'pending_review',
    'a flagged partner create must be demoted by the moderation screen even on an auto_publish tenant, and the RPC must return the ACTUAL status; got ' || (r ->> 'status');
  assert r ->> 'review_required_by' is null,
    'moderation, not auto_publish, caused this review: review_required_by stays null';
  assert (select needs_review from events where id = new_id),
    'the flagged create carries needs_review = true into the admin queue';

  -- Finding 1 (review 2026-08-23): the screen must not be republishable-
  -- around. trg_moderation_events fires only on title/description/tags, so
  -- a bare status flip never re-screens -- the status RPC itself must keep a
  -- flagged row out of publication, even on this auto_publish = true tenant.
  r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001', new_id, 'published');
  assert r ->> 'status' = 'pending_review',
    'finding 1: republishing the flagged row must resolve to pending_review, never published; got ' || (r ->> 'status');
  assert (select status from events where id = new_id) = 'pending_review',
    'finding 1: the row itself stayed out of publication';
  assert (select needs_review from events where id = new_id),
    'finding 1: needs_review still true; clearing it is admin triage';

  -- The EXTREME class: the screen hard-cancels the create, and cancelled is
  -- final for partners -- so the republish path is refused outright, and the
  -- content class the system maps to hard-cancel can never surface at the
  -- partner's will.
  r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001', null,
        '{"title": "Party zzzpartnerextremeterm bash", "start_at": "2026-12-12T23:00:00Z"}'::jsonb);
  new_id := (r ->> 'id')::uuid;
  assert r ->> 'status' = 'cancelled',
    'an extreme-term create is hard-cancelled by the screen; got ' || (r ->> 'status');
  begin
    r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001', new_id, 'published');
    raise exception 'finding 1/5: republishing a screen-cancelled row should have been refused';
  exception when insufficient_privilege then null;
  end;
  assert (select status from events where id = new_id) = 'cancelled',
    'the screen-cancelled row stayed cancelled';

  raise notice '  ✓ 11. partners are screened (D11), and the screen cannot be republished around (findings 1 and 5)';
end $$;

-- ── 12. LAST -- mutating: M7 revocation, tenant deactivation, M8 nobody ──────
-- These blocks mutate the membership fixtures, so nothing may run after them.
reset role;
select set_config('request.jwt.claims', '', true);

-- The admin revokes P's A2 membership BY COMPOSITE PK (the §6.7 runbook
-- shape -- structurally incapable of the unscoped-revoke footgun).
update partner_memberships
   set revoked_at = now()
 where user_id = 'b0000000-0000-4000-8000-00000000f001'
   and organization_id = 'b0000000-0000-4000-8000-00000000a002';

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f001"}', true);

do $$
declare scope uuid[];
begin
  -- M7: the scope shrinks by exactly one, in the same session, no re-login.
  select array_agg(x order by x) into scope from unnest(partner_scope()) x;
  assert scope = array['b0000000-0000-4000-8000-00000000a001']::uuid[],
    'M7: after revoking A2, P''s scope is exactly {A} on the very next query';
  assert (select array_agg(organization_id) from partner_org_context())
       = array['b0000000-0000-4000-8000-00000000a001']::uuid[],
    'M7: partner_org_context() shrank in the same instant (M11 after mutation)';

  -- A rows still writable; A2 rows refused; the A+A2 co-host is now
  -- read-only (all-of over the SHRUNK set).
  assert partner_may_write_event('b0000000-0000-4000-8000-00000000a001',
                                 'b0000000-0000-4000-8000-00000000e001'),
    'M7: A rows stay writable';
  assert not partner_may_write_event('b0000000-0000-4000-8000-00000000a002',
                                     'b0000000-0000-4000-8000-00000000e003'),
    'M7: A2 rows are refused after the revoke';
  assert not partner_may_write_event('b0000000-0000-4000-8000-00000000a001',
                                     'b0000000-0000-4000-8000-00000000e006'),
    'M7: the A+A2 co-host went read-only (all-of over the shrunk set)';
  raise notice '  ✓ 12a. M7: partial revocation is immediate, per-membership, and shrinks all-of correctly';
end $$;

-- The A+A2 co-host must STILL be readable (any-of; A is still in scope).
set local role authenticated;
do $$
begin
  assert exists (select 1 from events where id = 'b0000000-0000-4000-8000-00000000e006'),
    'M7: the co-host stays READABLE (any-of) while unwritable (all-of)';
  raise notice '  ✓ 12b. M7: read is any-of, write is all-of, visibly different after a partial revoke';
end $$;
reset role;

-- The whole-tenant lever: deactivating A removes it from scope and context
-- in the same instant, leaving the membership row (audit) intact.
select set_config('request.jwt.claims', '', true);
update partner_orgs set active = false
 where organization_id = 'b0000000-0000-4000-8000-00000000a001';

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-00000000f001"}', true);
set local role authenticated;

do $$
declare r jsonb;
begin
  -- M8: P is now a NOBODY -- asserted against the same expectations as the
  -- N9 stranger (block 6d), reached by a different route, so the two cannot
  -- drift.
  assert partner_scope() = '{}'::uuid[], 'M8: scope is empty after deactivating the last live org';
  assert (select count(*) from partner_org_context()) = 0, 'M8: context is empty';
  assert (select count(*) from events where status = 'pending_review') = 0,
    'M8: zero pending rows, exactly like the N9 stranger';

  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001', null,
          '{"title": "post-revoke create", "start_at": "2026-12-11T23:00:00Z"}'::jsonb);
    raise exception 'M8: create should now be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_upsert_event('b0000000-0000-4000-8000-00000000a001',
                              'b0000000-0000-4000-8000-00000000e001', '{"title": "x"}'::jsonb);
    raise exception 'M8: update should now be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_set_event_status('b0000000-0000-4000-8000-00000000a001',
                                  'b0000000-0000-4000-8000-00000000e001', 'cancelled');
    raise exception 'M8: status change should now be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_set_event_categories('b0000000-0000-4000-8000-00000000a001',
                                      'b0000000-0000-4000-8000-00000000e001', array['music']);
    raise exception 'M8: category change should now be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_set_event_venue('b0000000-0000-4000-8000-00000000a001',
                                 'b0000000-0000-4000-8000-00000000e001',
                                 'b0000000-0000-4000-8000-00000000b001');
    raise exception 'M8: venue change should now be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    r := partner_mint_venue('b0000000-0000-4000-8000-00000000a001', 'Post Revoke Hall', null);
    raise exception 'M8: mint should now be refused';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ 12c. M8: a fully-revoked partner is the N9 stranger, through every RPC and every read';
end $$;

reset role;
select 'ALL PARTNER RLS TESTS PASSED' as result;

rollback;
