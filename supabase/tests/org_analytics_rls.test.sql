-- ════════════════════════════════════════════════════════════════════════════
-- org_analytics_rls.test.sql
--
-- Regression tests for partner_event_metrics, the partner analytics read path.
-- Written for 063, retargeted at 064, which dropped the three-argument
-- signature, added p_upcoming_days plus the is_upcoming flag, and raised the
-- window cap from 400 days to 1200.
--
-- ⚠️  THIS FILE HAS NEVER BEEN EXECUTED. There is no Postgres harness in CI, so
-- every count asserted below is derived by reading, not by running. Two things
-- to expect on the first real run, neither of them a bug in the RPC:
--   * the fixture events are now()-relative (+7 to +10 days) while the window
--     asked for is the fixed 2026-08-01..2026-08-31, so which events come back
--     depends on when you run it. Under 064 they arrive through the upcoming
--     branch rather than the window branch.
--   * the row counts in blocks 2, 6 and 11 were written against 063's two
--     branches. Re-derive them from the first run rather than trusting them.
-- Fix the expectations, do not delete the blocks. Modeled on partner_accounts_rls.test.sql, including the
-- "role AND claims GUC together" discipline: both `set local role <role>` AND
-- the matching `request.jwt.claims` GUC are required together. The role
-- selects the policy set, the claim is what auth.uid() reads. Setting only one
-- silently tests the wrong principal.
--
-- ⚠️  WHY THIS FILE IS REQUIRED, NOT OPTIONAL
--
-- 063 is the first surface that lets a non-admin authenticated principal read
-- anything derived from page_metrics_daily, and the whole security argument
-- sits inside a SECURITY DEFINER body that bypasses RLS by design. There is no
-- policy to inspect. This file is the only artifact that proves the gate.
--
-- ⚠️  THE ASSERTION THAT MATTERS MOST is block 3: asking for someone else's
-- org RAISES, and does not return zero rows. Zero rows is this feature's
-- legitimate day-one state (the first real partner has exactly that), so a
-- silent refusal would render as an honest-looking empty dashboard and nobody
-- would ever find out.
--
-- ⚠️  ORDER MATTERS: block 12 revokes a membership, so it comes last, after
--     everything that depends on the un-revoked state.
--
-- ⚠️  VELOCITY-CAP RULE (house): new RLS test blocks go ABOVE any velocity-cap
--     block, because a cap block fills its 1-minute window in-transaction and
--     never unwinds it. This file contains NO velocity-cap block and MUST NOT
--     gain one except as the very last section.
--
-- Fixture ids use the d0.. prefix so this file cannot collide with
-- partner_accounts_rls.test.sql's b0.. fixtures if both are ever run in one
-- session. Everything is inside one transaction and rolled back; nothing
-- persists. A clean run prints "ALL ORG ANALYTICS TESTS PASSED".
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 0. Fixtures ──────────────────────────────────────────────────────────────
--
--   org A   d0..a001  tenant, active
--   org B   d0..a003  tenant, active, a different partner's org
--   org C   d0..a004  tenant, active = FALSE, P is a member
--
--   P        d0..f001  member of A and C
--   stranger d0..f003  authenticated, no memberships, not an admin
--
-- Events: A-only (measured), A-only (zero measured traffic), B-only, A+B
-- co-host, plus a metrics row pointing at an event id that does not exist.

insert into auth.users (id, email) values
  ('d0000000-0000-4000-8000-00000000f001', 'metrics-p@example.com'),
  ('d0000000-0000-4000-8000-00000000f003', 'metrics-stranger@example.com')
on conflict (id) do nothing;

insert into organizations (id, name, status) values
  ('d0000000-0000-4000-8000-00000000a001', 'Metrics Org Alpha',   'published'),
  ('d0000000-0000-4000-8000-00000000a003', 'Metrics Org Bravo',   'published'),
  ('d0000000-0000-4000-8000-00000000a004', 'Metrics Org Charlie', 'published');

insert into partner_orgs (organization_id, slug, active, auto_publish) values
  ('d0000000-0000-4000-8000-00000000a001', 'metrics-alpha',   true,  true),
  ('d0000000-0000-4000-8000-00000000a003', 'metrics-bravo',   true,  true),
  ('d0000000-0000-4000-8000-00000000a004', 'metrics-charlie', false, true);

insert into partner_memberships (user_id, organization_id, email) values
  ('d0000000-0000-4000-8000-00000000f001', 'd0000000-0000-4000-8000-00000000a001', 'metrics-p@example.com'),
  ('d0000000-0000-4000-8000-00000000f001', 'd0000000-0000-4000-8000-00000000a004', 'metrics-p@example.com');

insert into events (id, title, description, start_at, source, status, featured) values
  ('d0000000-0000-4000-8000-00000000e001', 'Alpha Measured Event', 'Ordinary.', now() + interval '7 days',  'manual', 'published', false),
  ('d0000000-0000-4000-8000-00000000e002', 'Alpha Quiet Event',    'Ordinary.', now() + interval '8 days',  'manual', 'published', false),
  ('d0000000-0000-4000-8000-00000000e004', 'Bravo Event',          'Ordinary.', now() + interval '9 days',  'manual', 'published', false),
  ('d0000000-0000-4000-8000-00000000e005', 'Alpha Bravo Co-Host',  'Ordinary.', now() + interval '10 days', 'manual', 'published', false);

insert into event_organizations (event_id, organization_id) values
  ('d0000000-0000-4000-8000-00000000e001', 'd0000000-0000-4000-8000-00000000a001'),
  ('d0000000-0000-4000-8000-00000000e002', 'd0000000-0000-4000-8000-00000000a001'),
  ('d0000000-0000-4000-8000-00000000e004', 'd0000000-0000-4000-8000-00000000a003'),
  ('d0000000-0000-4000-8000-00000000e005', 'd0000000-0000-4000-8000-00000000a001'),
  ('d0000000-0000-4000-8000-00000000e005', 'd0000000-0000-4000-8000-00000000a003');

-- Metrics. Note e001 carries TWO page_path rows on the SAME day: that is the
-- renamed-event case, which happens 97 times in production and is the reason
-- the RPC groups by event_id. Naive per-row reading would report two rows for
-- one event and a reader would double-count by eye.
insert into page_metrics_daily
  (metric_date, page_path, event_id, url_slug, page_views, users, outbound_clicks, outbound_tickets, outbound_source)
values
  ('2026-08-10', '/events/alpha-measured-aug-15/d0000000-0000-4000-8000-00000000e001',
   'd0000000-0000-4000-8000-00000000e001', 'alpha-measured-aug-15', 10, 6, 4, 3, 1),
  ('2026-08-10', '/events/alpha-measured-renamed-aug-15/d0000000-0000-4000-8000-00000000e001',
   'd0000000-0000-4000-8000-00000000e001', 'alpha-measured-renamed-aug-15', 5, 3, 2, 1, 1),
  ('2026-08-11', '/events/alpha-bravo-co-host/d0000000-0000-4000-8000-00000000e005',
   'd0000000-0000-4000-8000-00000000e005', 'alpha-bravo-co-host', 20, 12, 7, 5, 2),
  ('2026-08-11', '/events/bravo-event/d0000000-0000-4000-8000-00000000e004',
   'd0000000-0000-4000-8000-00000000e004', 'bravo-event', 8, 5, 1, 1, 0),
  -- A dangling event_id: 062 stores these on purpose (GA reported a path for an
  -- event since merged or deleted). It must contribute to nothing and break
  -- nothing.
  ('2026-08-11', '/events/gone-event/d0000000-0000-4000-8000-0000000000ff',
   'd0000000-0000-4000-8000-0000000000ff', 'gone-event', 99, 99, 99, 99, 0),
  -- A page with no event at all, the other half of what this table holds.
  ('2026-08-11', '/venues', null, null, 40, 30, 0, 0, 0);

-- ── 1. Seed sanity ───────────────────────────────────────────────────────────
do $$
begin
  assert exists (select 1 from admin_users where user_id = 'c5b809ab-8ad0-4e2e-a985-cc709726c12b'),
    'admin roster must contain the 059 seed admin, or every admin assertion below is meaningless';
  assert not exists (select 1 from admin_users where user_id in (
      'd0000000-0000-4000-8000-00000000f001', 'd0000000-0000-4000-8000-00000000f003')),
    'no fixture principal may be on the admin roster; if one is, every negative below is vacuous';
  raise notice '  ✓ 1. seed sane';
end $$;

-- ── 2. Baseline: P sees org A ────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"d0000000-0000-4000-8000-00000000f001"}', true);
set local role authenticated;

do $$
declare r record; n int;
begin
  select count(*) into n from partner_event_metrics(
    'd0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31');
  assert n = 3, 'P must see A''s three events (measured, quiet, co-host), got ' || n;

  select * into r from partner_event_metrics(
    'd0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31')
   where event_id = 'd0000000-0000-4000-8000-00000000e001';
  -- 10 + 5 views, 6 + 3 visitor days, 4 + 2 clicks: the two page_paths for one
  -- renamed event, summed into one row.
  assert r.page_views = 15,       'renamed-event rows must SUM, got page_views ' || r.page_views;
  assert r.visitor_days = 9,      'visitor days must sum, got ' || r.visitor_days;
  assert r.outbound_clicks = 6,   'clicks must sum, got ' || r.outbound_clicks;
  assert r.outbound_tickets = 4,  'tickets must sum, got ' || r.outbound_tickets;
  assert r.outbound_source = 2,   'source must sum, got ' || r.outbound_source;
  raise notice '  ✓ 2. P reads A, and two page_paths for one event collapse to one summed row';
end $$;

-- ── 3. THE ONE THAT MATTERS: another org RAISES, never zero rows ─────────────
do $$
declare got text; n int;
begin
  begin
    select count(*) into n from partner_event_metrics(
      'd0000000-0000-4000-8000-00000000a003', '2026-08-01', '2026-08-31');
    assert false,
      'P asked for org B and got ' || n || ' rows instead of an exception. Zero rows is this feature''s '
      'legitimate empty state, so a silent refusal is indistinguishable from the truth and would ship '
      'unnoticed. The refusal MUST raise.';
  exception when insufficient_privilege then
    got := 'raised';
  end;
  assert got = 'raised', 'expected insufficient_privilege for a foreign org';
  raise notice '  ✓ 3. a foreign org RAISES insufficient_privilege, it does not return zero rows';
end $$;

-- ── 3b. A NULL org raises too, and does not fall through to zero rows ───────
-- The three-valued-logic hole. `null = any(scope)` is NULL, not false, so a
-- gate written as `if not (p_org = any(scope) or is_admin())` evaluates to
-- NULL for any caller with a non-empty scope and takes the ELSE branch: no
-- raise, no rows, and a dashboard that looks honestly empty. The function
-- checks for null first; this asserts that it does.
do $$
declare got text;
begin
  begin
    perform partner_event_metrics(null, '2026-08-01', '2026-08-31');
    assert false, 'a null p_org must raise. Falling through returns zero rows, which is indistinguishable '
                  'from this feature''s legitimate empty state.';
  exception when invalid_parameter_value then
    got := 'raised';
  end;
  assert got = 'raised';
  raise notice '  ✓ 3b. a null org raises rather than returning zero rows';
end $$;

-- ── 4. An inactive tenant is not scope, even with a live membership ──────────
do $$
declare got text;
begin
  begin
    perform partner_event_metrics('d0000000-0000-4000-8000-00000000a004', '2026-08-01', '2026-08-31');
    assert false, 'org C is active = false, so P must NOT reach it. partner_scope()''s p.active filter is '
                  'load-bearing and this asserts it rather than assuming it is inherited.';
  exception when insufficient_privilege then
    got := 'raised';
  end;
  assert got = 'raised';
  raise notice '  ✓ 4. an inactive tenant raises';
end $$;

-- ── 5. Co-hosted clicks count in full for BOTH orgs, and appear once each ────
do $$
declare a_clicks bigint; a_rows int;
begin
  select outbound_clicks into a_clicks from partner_event_metrics(
    'd0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31')
   where event_id = 'd0000000-0000-4000-8000-00000000e005';
  assert a_clicks = 7, 'A must see the co-host''s full 7 clicks, not a split share, got ' || a_clicks;

  select count(*) into a_rows from partner_event_metrics(
    'd0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31')
   where event_id = 'd0000000-0000-4000-8000-00000000e005';
  assert a_rows = 1, 'the co-hosted event must appear exactly ONCE in A''s result, got ' || a_rows;
  raise notice '  ✓ 5. co-host counts in full for A and appears once';
end $$;

-- ── 6. Zero-traffic events still appear (the empty state depends on it) ──────
do $$
declare r record;
begin
  select * into r from partner_event_metrics(
    'd0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31')
   where event_id = 'd0000000-0000-4000-8000-00000000e002';
  assert found, 'an event with no measured traffic must still be RETURNED. "We have no events" and "we '
                'have events and nobody has been counted looking at them" are different facts and the UI '
                'renders them differently.';
  assert r.page_views = 0 and r.outbound_clicks = 0, 'the quiet event''s figures must be zero, not null';
  raise notice '  ✓ 6. a zero-traffic event is returned with zeros';
end $$;

-- ── 7. Dangling event_ids contribute to nothing ──────────────────────────────
do $$
declare total bigint;
begin
  select coalesce(sum(page_views), 0) into total from partner_event_metrics(
    'd0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31');
  -- 15 (measured, both paths) + 20 (co-host) + 0 (quiet). The dangling row's 99
  -- views and the /venues row's 40 must not appear anywhere.
  assert total = 35, 'A''s total views must be 35; a dangling event_id or a non-event page leaked in, got ' || total;
  raise notice '  ✓ 7. dangling event_ids and non-event pages contribute nothing';
end $$;

-- ── 8. 062 stays closed: no direct read of the metrics tables ────────────────
do $$
declare n int;
begin
  select count(*) into n from page_metrics_daily;
  -- 062 grants SELECT to `authenticated` and narrows it to admins with a
  -- policy, so this returns zero rows rather than raising permission denied.
  -- Either outcome is fine; a non-zero count is not.
  assert n = 0,
    'a partner read ' || n || ' rows directly from page_metrics_daily. 063 must not widen what 062 '
    'deliberately narrowed to admins.';
  raise notice '  ✓ 8. a partner still gets zero rows from page_metrics_daily directly';
end $$;

-- ── 9. The stranger reaches nothing ──────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"d0000000-0000-4000-8000-00000000f003"}', true);
set local role authenticated;

do $$
declare got int := 0;
begin
  begin
    perform partner_event_metrics('d0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31');
    assert false, 'an authenticated stranger must not read any org''s analytics';
  exception when insufficient_privilege then got := got + 1;
  end;
  begin
    perform partner_event_metrics('d0000000-0000-4000-8000-00000000a003', '2026-08-01', '2026-08-31');
    assert false, 'an authenticated stranger must not read any org''s analytics';
  exception when insufficient_privilege then got := got + 1;
  end;
  assert got = 2;
  raise notice '  ✓ 9. the stranger raises for every org';
end $$;

-- ── 10. Argument validation ──────────────────────────────────────────────────
-- The full triple on every principal switch, even where the role does not
-- change: this file's own header says role and claim go together, and this is
-- the file the next person copies.
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"d0000000-0000-4000-8000-00000000f001"}', true);
set local role authenticated;

do $$
declare got int := 0;
begin
  begin
    perform partner_event_metrics('d0000000-0000-4000-8000-00000000a001', '2026-08-31', '2026-08-01');
    assert false, 'p_to before p_from must raise';
  exception when invalid_parameter_value then got := got + 1;
  end;
  begin
    -- 1201 days: one past the cap 064 raised to 1200. Relative to today, so it
    -- keeps probing the boundary instead of drifting into "obviously huge".
    perform partner_event_metrics('d0000000-0000-4000-8000-00000000a001',
      (current_date - 1201)::date, current_date);
    assert false, 'a window wider than 1200 days must raise';
  exception when invalid_parameter_value then got := got + 1;
  end;
  -- And the other side of the same boundary: exactly 1200 days is allowed, so
  -- the all-time window has somewhere to grow into.
  perform partner_event_metrics('d0000000-0000-4000-8000-00000000a001',
    (current_date - 1200)::date, current_date);
  assert got = 2;
  raise notice '  ✓ 10. an inverted window raises, 1200 days passes, 1201 raises';
end $$;

-- ── 10b. The forward window argument is guarded on every side ────────────────
-- p_upcoming_days has a DEFAULT, and a default only applies when the argument
-- is omitted. An explicitly-passed null would make every comparison against it
-- null, so the forward branch would silently match nothing: the same class of
-- failure as a null p_org, one argument over.
do $$
declare got int := 0; n int;
begin
  begin
    perform partner_event_metrics('d0000000-0000-4000-8000-00000000a001',
      '2026-08-01', '2026-08-31', null);
    assert false, 'an explicitly null p_upcoming_days must raise, not fall back to the default';
  exception when invalid_parameter_value then got := got + 1;
  end;
  begin
    perform partner_event_metrics('d0000000-0000-4000-8000-00000000a001',
      '2026-08-01', '2026-08-31', -1);
    assert false, 'a negative forward window must raise';
  exception when invalid_parameter_value then got := got + 1;
  end;
  begin
    perform partner_event_metrics('d0000000-0000-4000-8000-00000000a001',
      '2026-08-01', '2026-08-31', 401);
    assert false, 'a forward window past the 400 day cap must raise';
  exception when invalid_parameter_value then got := got + 1;
  end;
  assert got = 3, 'all three bad forward windows must raise, got ' || got;

  -- Omitting the argument entirely still works: PostgREST binds a call that
  -- leaves it out, and the frontend deployed before 064 does exactly that.
  select count(*) into n from partner_event_metrics(
    'd0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31');
  assert n >= 0;
  raise notice '  ✓ 10b. p_upcoming_days rejects null, negative and over-cap, and stays optional';
end $$;

-- ── 10c. is_upcoming answers "has it happened yet", in Eastern ───────────────
-- The flag is what splits the two tables in the UI, and it is deliberately NOT
-- bounded by p_upcoming_days: an event further out that people are already
-- looking at still has not happened, and filing it under "already happened"
-- would be a plain lie about time.
do $$
declare n_up int; n_past int; n_zero_forward int;
begin
  select count(*) filter (where is_upcoming),
         count(*) filter (where not is_upcoming)
    into n_up, n_past
  from partner_event_metrics(
    'd0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31');
  assert n_up >= 1, 'the fixture events start 7 to 10 days out, so at least one must be flagged upcoming';
  assert n_past >= 0;

  -- With a zero-day forward window, an unmeasured future event has no branch
  -- left to arrive through and must drop out entirely. If this returns the
  -- same count as above, the forward branch is not bounded by its argument.
  select count(*) into n_zero_forward from partner_event_metrics(
    'd0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31', 0);
  assert n_zero_forward < n_up + n_past,
    'p_upcoming_days = 0 must drop the unmeasured future events, got ' || n_zero_forward;
  raise notice '  ✓ 10c. is_upcoming splits by Eastern today, and the forward branch honours its bound';
end $$;

-- ── 11. Admin reads any org, and anon holds no grant ─────────────────────────
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c5b809ab-8ad0-4e2e-a985-cc709726c12b"}', true);
set local role authenticated;

do $$
declare n_a int; n_b int;
begin
  select count(*) into n_a from partner_event_metrics(
    'd0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31');
  select count(*) into n_b from partner_event_metrics(
    'd0000000-0000-4000-8000-00000000a003', '2026-08-01', '2026-08-31');
  assert n_a = 3, 'an admin must read org A, got ' || n_a;
  assert n_b = 2, 'an admin must read org B (its own event plus the co-host), got ' || n_b;
  raise notice '  ✓ 11. an admin reads any org';
end $$;

reset role;

do $$
begin
  assert not has_function_privilege('anon', 'partner_event_metrics(uuid,date,date,int)', 'execute'),
    'anon must NOT hold execute. Supabase default privileges grant it directly, so the migration revokes '
    'from anon BY NAME; a revoke from public alone would leave this true.';
  assert has_function_privilege('authenticated', 'partner_event_metrics(uuid,date,date,int)', 'execute'),
    'authenticated must hold execute or the whole surface is dead';
  raise notice '  ✓ 11b. anon has no execute, authenticated does';
end $$;

-- ── 12. LAST, MUTATING: revocation cuts access immediately ───────────────────
-- This block revokes a membership, so nothing that depends on the un-revoked
-- state may come after it.
update partner_memberships
   set revoked_at = now()
 where user_id = 'd0000000-0000-4000-8000-00000000f001'
   and organization_id = 'd0000000-0000-4000-8000-00000000a001';

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"d0000000-0000-4000-8000-00000000f001"}', true);
set local role authenticated;

do $$
declare got text;
begin
  begin
    perform partner_event_metrics('d0000000-0000-4000-8000-00000000a001', '2026-08-01', '2026-08-31');
    assert false, 'a revoked membership must cut analytics access immediately, mid-session, with no cache '
                  'and no grace period';
  exception when insufficient_privilege then
    got := 'raised';
  end;
  assert got = 'raised';
  raise notice '  ✓ 12. revocation cuts access immediately';
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  raise notice 'ALL ORG ANALYTICS TESTS PASSED';
end $$;

rollback;
