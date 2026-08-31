-- ════════════════════════════════════════════════════════════════════════════
-- org_opt_outs_rls.test.sql
--
-- RLS / grant posture tests for migration 066's org_opt_outs table. Modeled on
-- admin_boundary_rls.test.sql. Pins the contract from every side:
--
--   * anon has ZERO privileges on the table (revoked outright).
--   * authenticated has SELECT, INSERT, UPDATE and specifically NOT DELETE
--     (opt-outs are retired via active=false, never removed).
--   * the single FOR ALL policy is is_admin()-gated: an admin sees and writes
--     rows; a signed-in non-admin sees nothing and cannot insert.
--   * RLS is ENABLED but NOT forced (the guard functions are SECURITY DEFINER
--     and owned by a bypassing role; forcing buys nothing, same call as 059).
--
-- ⚠️  Both `set local role <role>` AND the matching request.jwt.claims GUC are
--     required together: the role selects the policy set, the claim is what
--     auth.uid()/is_admin() read. See admin_boundary_rls.test.sql:44.
--
-- Self-contained: runs in a transaction and ROLLS BACK. Run against a local
-- `supabase start` DB or an isolated branch with 066 applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/org_opt_outs_rls.test.sql
--
-- A clean run prints "ALL ORG OPT-OUT RLS TESTS PASSED". Any failure raises.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 0. Fixtures: one synthetic admin, one synthetic stranger ────────────────
-- Both synthetic and rolled back. auth.users first (admin_users FKs it).
insert into auth.users (id, email) values
  ('b0000000-0000-4000-8000-0000000000a1', 'optout-admin@example.com'),
  ('b0000000-0000-4000-8000-0000000000ff', 'optout-stranger@example.com')
on conflict (id) do nothing;

insert into admin_users (user_id) values ('b0000000-0000-4000-8000-0000000000a1')
on conflict do nothing;

-- A seed opt-out row, written as the owner (bypasses RLS) so the stranger's
-- "sees zero rows" assertion has something it must NOT see.
insert into org_opt_outs (name_key, display_name)
  values (org_name_match_key('RLS Seed Org'), 'RLS Seed Org');

-- ── 1. Table posture: RLS enabled, not forced ──────────────────────────────
do $$
declare rls boolean; forced boolean;
begin
  select relrowsecurity, relforcerowsecurity into rls, forced
    from pg_class where oid = 'org_opt_outs'::regclass;
  assert rls, '1a RLS must be enabled on org_opt_outs';
  assert not forced, '1b RLS must NOT be forced on org_opt_outs';
  raise notice '  ok 1 RLS enabled, not forced';
end $$;

-- ── 2. Grants: anon none; authenticated select/insert/update but NOT delete ─
-- Read straight from the catalog, no role switch needed.
do $$
begin
  assert not has_table_privilege('anon','org_opt_outs','SELECT'), '2a anon must not SELECT';
  assert not has_table_privilege('anon','org_opt_outs','INSERT'), '2b anon must not INSERT';
  assert not has_table_privilege('anon','org_opt_outs','UPDATE'), '2c anon must not UPDATE';
  assert not has_table_privilege('anon','org_opt_outs','DELETE'), '2d anon must not DELETE';

  assert has_table_privilege('authenticated','org_opt_outs','SELECT'), '2e authenticated SELECT';
  assert has_table_privilege('authenticated','org_opt_outs','INSERT'), '2f authenticated INSERT';
  assert has_table_privilege('authenticated','org_opt_outs','UPDATE'), '2g authenticated UPDATE';
  assert not has_table_privilege('authenticated','org_opt_outs','DELETE'),
    '2h authenticated must NOT have DELETE (opt-outs are retired via active=false)';
  raise notice '  ok 2 grants: anon none, authenticated s/i/u not d';
end $$;

-- ── 3. Policy: a signed-in NON-admin sees no rows and cannot insert ─────────
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-0000000000ff"}', true);
set local role authenticated;

do $$
declare n int; blocked boolean := false;
begin
  assert not is_admin(), '3a stranger must not be admin';
  select count(*) into n from org_opt_outs;
  assert n = 0, '3b stranger must see zero org_opt_outs rows, saw '||n;
  begin
    insert into org_opt_outs (name_key, display_name)
      values (org_name_match_key('Stranger Org'),'Stranger Org');
  exception when insufficient_privilege then blocked := true;
  end;
  assert blocked, '3c stranger INSERT must be blocked by the is_admin() WITH CHECK';
  raise notice '  ok 3 non-admin sees nothing, cannot insert';
end $$;

-- ── 4. Policy: an admin sees rows and can insert / update ───────────────────
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-0000000000a1"}', true);
set local role authenticated;

do $$
declare n int; s text;
begin
  assert is_admin(), '4a admin must be admin';
  select count(*) into n from org_opt_outs;
  assert n >= 1, '4b admin must see the seed row, saw '||n;
  insert into org_opt_outs (name_key, display_name)
    values (org_name_match_key('Admin Added Org'),'Admin Added Org');
  select display_name into s from org_opt_outs where name_key = org_name_match_key('Admin Added Org');
  assert s = 'Admin Added Org', '4c admin INSERT visible to admin';
  update org_opt_outs set active = false where name_key = org_name_match_key('Admin Added Org');
  assert not (select active from org_opt_outs where name_key = org_name_match_key('Admin Added Org')),
    '4d admin UPDATE (active=false) works';
  raise notice '  ok 4 admin sees rows, can insert and update';
end $$;

-- ── 5. Even an admin cannot DELETE (no grant) ──────────────────────────────
do $$
declare blocked boolean := false;
begin
  begin
    delete from org_opt_outs where name_key = org_name_match_key('Admin Added Org');
  exception when insufficient_privilege then blocked := true;
  end;
  assert blocked, '5 DELETE must be refused for authenticated even as admin (no DELETE grant)';
  raise notice '  ok 5 delete refused (no grant)';
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

rollback;

\echo 'ALL ORG OPT-OUT RLS TESTS PASSED'
