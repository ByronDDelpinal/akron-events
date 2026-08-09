-- ════════════════════════════════════════════════════════════════════════════
-- embed_request_rls.test.sql
--
-- Regression tests for migration 051 (embed_requests — "request an embed"
-- form at the bottom of /embed-builder). Modeled on
-- supabase/tests/feedback_orb_rls.test.sql — same self-contained begin/
-- rollback, same set_config('request.jwt.claims', '{"role":"anon"}', true)
-- + set local role anon setup, same final "ALL ... PASSED" marker.
--
-- READ THIS BEFORE COPYING THE FEEDBACK-ORB TEST'S LENGTH CASE (architect's
-- warning, docs/embed-request-capture.md §6.6): the feedback-orb test's
-- length check expects `insufficient_privilege` because migration 043 put
-- its length bound in the RLS POLICY. This migration puts every length bound
-- in table CHECK CONSTRAINTS instead (so a service-role/admin write is
-- bounded too, not just anon) — that raises `check_violation`, a DIFFERENT
-- SQLSTATE. Copying the feedback-orb test's
-- `exception when insufficient_privilege then null` handler verbatim for
-- section 4 below would make this test pass even if the CHECK constraints
-- were silently removed — it is asserting the wrong error class. Section 3
-- (the RLS-policy-pinned columns: status/notified_at/embed_path) is the one
-- place `insufficient_privilege` is actually correct here, because those
-- three columns are pinned by the POLICY, not a CHECK constraint.
--
-- Pins the contract the notifier's fire-and-forget insert relies on:
--   1. anon CAN insert a well-formed embed request (website optional, D3).
--   2. anon CANNOT read it back (no anon SELECT policy — proves the
--      no-.select() contract the client insert relies on).
--   3. anon CANNOT set status/notified_at/embed_path away from their
--      required values -> insufficient_privilege (RLS policy).
--   4. Over-length name/email/organization/website/note -> check_violation
--      (CHECK constraint), NOT insufficient_privilege.
--   5. An email with no '@' -> check_violation.
--   6. config as a JSON array, as 'null'::jsonb, and oversized (>4096 bytes)
--      -> all rejected with check_violation.
--   7. anon cannot UPDATE and cannot DELETE any row (no policy at all for
--      either — D5, SQL-only triage for v1).
--   8. Velocity cap (051's embed_request_rate_limit trigger): the 11th
--      insert within an hour raises check_violation; the 4th from the same
--      email address raises too.
--
-- Self-contained: runs inside a transaction and ROLLS BACK so nothing
-- persists. Run against a local `supabase start` DB or an isolated branch
-- that already has migration 051 applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/embed_request_rls.test.sql
--
-- A clean run prints "ALL EMBED REQUEST RLS TESTS PASSED". Any failure raises.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Simulate a PostgREST anon request: role + JWT claims (the velocity-cap
-- trigger gates on the claim via moderation_request_role(), same as 043's
-- feedback_rate_limit).
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

-- ── 1 & 2. Happy path works, and the row is not readable back ───────────────
-- NOTE: deliberately does NOT use `insert ... returning id into rid`. Under
-- RLS, a RETURNING clause the SELECT policy can't see comes back as zero
-- rows, which PL/pgSQL's INTO silently turns into NULL (no error) — so
-- `id = rid` would compare against NULL and the "not exists" check would
-- trivially pass even if RLS were broken. A unique marker embedded in
-- `organization` sidesteps that trap entirely (mirrors the real client,
-- which never uses .select() on this insert either — see
-- docs/embed-request-capture.md §5.4).
do $$
declare
  marker text := 'rls-smoke-' || gen_random_uuid()::text;
begin
  insert into embed_requests (name, email, organization, website, note, config)
  values ('Jordan Rivera', 'jordan@example.com', 'Highland Square Neighbors ' || marker, null, null, '{}'::jsonb);

  assert not exists (select 1 from embed_requests where organization like '%' || marker || '%'),
    'anon should not see its own freshly-inserted embed_requests row';

  raise notice '  ✓ happy path insert (website null, D3 optional) + no readback';
end $$;

do $$
declare
  marker text := 'rls-smoke-website-' || gen_random_uuid()::text;
begin
  insert into embed_requests (name, email, organization, website, note, config)
  values ('Jordan Rivera', 'jordan@example.com', 'Highland Square Neighbors ' || marker, 'https://example.org', 'Please make it teal.', '{"theme":"akron-pulse"}'::jsonb);

  assert not exists (select 1 from embed_requests where organization like '%' || marker || '%'),
    'anon should not see its own freshly-inserted embed_requests row (website provided)';

  raise notice '  ✓ happy path insert (website + note provided) + no readback';
end $$;

-- ── 3. RLS-policy-pinned columns: status / notified_at / embed_path ─────────
do $$
begin
  begin
    insert into embed_requests (name, email, organization, status, config)
    values ('Jordan', 'jordan@example.com', 'Org', 'approved', '{}'::jsonb);
    raise exception 'anon insert with status != new should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into embed_requests (name, email, organization, notified_at, config)
    values ('Jordan', 'jordan@example.com', 'Org', now(), '{}'::jsonb);
    raise exception 'anon insert with notified_at set should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into embed_requests (name, email, organization, embed_path, config)
    values ('Jordan', 'jordan@example.com', 'Org', '/embed', '{}'::jsonb);
    raise exception 'anon insert with embed_path set should have been rejected';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ status/notified_at/embed_path are pinned by the RLS policy (insufficient_privilege)';
end $$;

-- ── 4. DB max-lengths (CHECK constraints, NOT the policy) ────────────────────
-- These must raise check_violation, not insufficient_privilege — see this
-- file's header for why that distinction matters here.
do $$
begin
  begin
    insert into embed_requests (name, email, organization, config)
    values (repeat('x', 121), 'jordan@example.com', 'Org', '{}'::jsonb);
    raise exception 'a 121-char name should have been rejected';
  exception when check_violation then null;
  end;

  begin
    insert into embed_requests (name, email, organization, config)
    values ('Jordan', repeat('x', 250) || '@example.com', 'Org', '{}'::jsonb);
    raise exception 'a 255-char email should have been rejected';
  exception when check_violation then null;
  end;

  begin
    insert into embed_requests (name, email, organization, config)
    values ('Jordan', 'jordan@example.com', repeat('x', 161), '{}'::jsonb);
    raise exception 'a 161-char organization should have been rejected';
  exception when check_violation then null;
  end;

  begin
    insert into embed_requests (name, email, organization, website, config)
    values ('Jordan', 'jordan@example.com', 'Org', repeat('x', 301), '{}'::jsonb);
    raise exception 'a 301-char website should have been rejected';
  exception when check_violation then null;
  end;

  begin
    insert into embed_requests (name, email, organization, note, config)
    values ('Jordan', 'jordan@example.com', 'Org', repeat('x', 1001), '{}'::jsonb);
    raise exception 'a 1001-char note should have been rejected';
  exception when check_violation then null;
  end;

  raise notice '  ✓ DB max-lengths enforced via CHECK constraints (check_violation)';
end $$;

-- ── 5. Email shape ────────────────────────────────────────────────────────
do $$
begin
  begin
    insert into embed_requests (name, email, organization, config)
    values ('Jordan', 'not-an-email', 'Org', '{}'::jsonb);
    raise exception 'an email with no @ should have been rejected';
  exception when check_violation then null;
  end;

  raise notice '  ✓ email without "@" rejected (check_violation)';
end $$;

-- ── 6. config jsonb shape ─────────────────────────────────────────────────
do $$
begin
  begin
    insert into embed_requests (name, email, organization, config)
    values ('Jordan', 'jordan@example.com', 'Org', '[1,2,3]'::jsonb);
    raise exception 'config as a JSON array should have been rejected';
  exception when check_violation then null;
  end;

  begin
    insert into embed_requests (name, email, organization, config)
    values ('Jordan', 'jordan@example.com', 'Org', 'null'::jsonb);
    raise exception 'config as JSON null should have been rejected';
  exception when check_violation then null;
  end;

  begin
    -- A single key with a value comfortably over 4096 bytes of jsonb.
    insert into embed_requests (name, email, organization, config)
    values ('Jordan', 'jordan@example.com', 'Org', jsonb_build_object('categories', repeat('a', 5000)));
    raise exception 'an oversized config (>4096 bytes) should have been rejected';
  exception when check_violation then null;
  end;

  raise notice '  ✓ config jsonb shape enforced (array / null / oversized all check_violation)';
end $$;

-- ── 7. No UPDATE, no DELETE for anon ─────────────────────────────────────────
do $$
declare
  marker text := 'rls-noupdate-' || gen_random_uuid()::text;
begin
  insert into embed_requests (name, email, organization, config)
  values ('Jordan', 'jordan@example.com', 'Org ' || marker, '{}'::jsonb);

  begin
    update embed_requests set status = 'approved' where organization like '%' || marker || '%';
    raise exception 'anon UPDATE should have been rejected (no UPDATE policy at all)';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from embed_requests where organization like '%' || marker || '%';
    raise exception 'anon DELETE should have been rejected (no DELETE policy at all)';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ no UPDATE, no DELETE policy for anon (D5 — SQL-only triage for v1)';
end $$;

-- ── 8. Velocity cap (051's embed_request_rate_limit trigger) ────────────────
--
-- ORDER MATTERS: the per-email cap test MUST run before the global cap test.
-- The trigger checks the GLOBAL cap first (see 051's embed_request_rate_limit
-- function), so once the global count is pushed to its 10-row ceiling by the
-- global-cap test below, EVERY subsequent insert in this transaction —
-- including the per-email test's own filler rows — would be rejected by the
-- global check before the per-email check is ever reached, breaking the
-- per-email test. Running per-email first, while the total row count from
-- earlier sections is still small, avoids that ordering trap.
do $$
declare
  test_email   text := 'sameaddr-' || gen_random_uuid()::text || '@example.com';
  recent_email int;
  to_insert    int;
  i            int;
begin
  select count(*) into recent_email from embed_requests where email = test_email and created_at > now() - interval '1 hour';
  to_insert := greatest(3 - recent_email, 0);
  for i in 1 .. to_insert loop
    insert into embed_requests (name, email, organization, config)
    values ('Same Address', test_email, 'Org ' || i, '{}'::jsonb);
  end loop;

  begin
    insert into embed_requests (name, email, organization, config)
    values ('Same Address', test_email, 'One Too Many From Same Address', '{}'::jsonb);
    raise exception 'the 4th embed request from the same email within one hour should have been rejected';
  exception when check_violation then null;
  end;

  raise notice '  ✓ per-email velocity cap rejects the 4th insert from the same address within one hour';
end $$;

do $$
declare
  recent_all int;
  to_insert  int;
  i          int;
begin
  -- Global cap: top up to 10 existing rows within the last hour (counting
  -- every row this test has inserted so far, including the per-email test's
  -- above), then the 11th must raise. Count existing rows first so this is
  -- not order-dependent on how many rows earlier sections left behind.
  select count(*) into recent_all from embed_requests where created_at > now() - interval '1 hour';
  to_insert := greatest(10 - recent_all, 0);
  for i in 1 .. to_insert loop
    insert into embed_requests (name, email, organization, config)
    values ('Filler', 'filler-' || i || '-' || gen_random_uuid()::text || '@example.com', 'Filler Org ' || i, '{}'::jsonb);
  end loop;

  begin
    insert into embed_requests (name, email, organization, config)
    values ('One Too Many', 'onetoomany-' || gen_random_uuid()::text || '@example.com', 'Org', '{}'::jsonb);
    raise exception 'the 11th embed request within one hour should have been rejected';
  exception when check_violation then null;
  end;

  raise notice '  ✓ global velocity cap rejects the 11th insert within one hour';
end $$;

reset role;
select 'ALL EMBED REQUEST RLS TESTS PASSED' as result;

rollback;
