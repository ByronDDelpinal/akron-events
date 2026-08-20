-- ════════════════════════════════════════════════════════════════════════════
-- feedback_orb_rls.test.sql
--
-- Regression tests for migration 043 (feedback orb — reuses feedback_posts).
-- Modeled on supabase/tests/anon_submission_rls.test.sql. Pins the contract
-- the orb's fire-and-forget insert relies on:
--
--   1. anon CAN insert an orb note (category='orb', is_private=true).
--   2. anon CANNOT read that note back (proves the no-.select() contract —
--      orb rows are is_private=true, and the 038 anon SELECT policy is
--      status='published' AND is_private=false).
--   3. The tightened anon INSERT policy (043) rejects: is_private=false,
--      a non-null image_url, and any category other than 'orb'.
--   4. The DB-side max length (043's char_length check) rejects a body over
--      1000 chars.
--   5. The 030 content-moderation trigger still fires on orb inserts
--      (reused for free — no new moderation code). A temporary extreme-
--      severity term is seeded so this holds regardless of whether the real
--      (env-var) term list is loaded locally — mirrors how
--      content_moderation.test.sql seeds its own sample list.
--   6. The 058 email length bound: null and a 254-char value accepted,
--      255 chars and the empty string rejected. Ordered BEFORE the
--      velocity cap, which would otherwise reject them for an
--      unrelated reason.
--   7. The 043 velocity-cap trigger rejects the 21st insert within a
--      one-minute window.
--
-- Self-contained: runs inside a transaction and ROLLS BACK so nothing
-- persists. Run against a local `supabase start` DB or an isolated branch
-- that already has migration 043 applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/feedback_orb_rls.test.sql
--
-- A clean run prints "ALL FEEDBACK ORB RLS TESTS PASSED". Any failure raises.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Seed one throwaway extreme-severity term as the connecting (owner) role,
-- before switching to anon below — moderation_terms is RLS-protected with
-- zero anon/authenticated policies, so this must happen first. Rolled back
-- with everything else; never touches the real term list.
insert into moderation_terms (term, severity, kind) values
  ('zzzorbtestblockedterm', 'extreme', 'word')
on conflict (term) do update set severity = excluded.severity, kind = excluded.kind;

-- Simulate a PostgREST anon request: role + JWT claims (the moderation
-- trigger from 030 and the rate-limit trigger from 043 both gate on the
-- claim, so this exercises them too).
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

-- ── 1 & 2. Happy path works, and the row is not readable back ───────────────
-- NOTE: deliberately does NOT use `insert ... returning id into fid`. Under
-- RLS, a RETURNING clause the SELECT policy can't see comes back as zero
-- rows, which PL/pgSQL's INTO silently turns into NULL (no error) — so
-- `id = fid` would compare against NULL and the "not exists" check would
-- trivially pass even if RLS were broken. A unique marker embedded in the
-- body sidesteps that trap entirely (mirrors why the real client never uses
-- .select() on this insert either — see plan §3).
do $$
declare
  marker text := 'rls-smoke-' || gen_random_uuid()::text;
begin
  insert into feedback_posts (category, body, is_private, page_path)
  values ('orb', 'ordinary orb note ' || marker, true, '/events/x');

  assert not exists (select 1 from feedback_posts where body like '%' || marker || '%'),
    'anon should not see its own freshly-inserted orb row';

  raise notice '  ✓ happy path insert + no readback';
end $$;

-- ── 3. Public insert is locked down ──────────────────────────────────────────
do $$
begin
  -- anon may not insert a non-private orb note
  begin
    insert into feedback_posts (category, body, is_private, page_path)
    values ('orb', 'attempted public orb note', false, '/events/x');
    raise exception 'anon insert with is_private=false should have been rejected';
  exception when insufficient_privilege then null;
  end;

  -- anon may not attach an image (dropped for the minimal widget)
  begin
    insert into feedback_posts (category, body, is_private, image_url, page_path)
    values ('orb', 'attempted image attach', true, 'https://example.com/x.png', '/events/x');
    raise exception 'anon insert with a non-null image_url should have been rejected';
  exception when insufficient_privilege then null;
  end;

  -- anon may not insert under any category but 'orb' (legacy board categories
  -- are still allowed by the CHECK constraint, but RLS now scopes anon to 'orb')
  begin
    insert into feedback_posts (category, body, is_private, page_path)
    values ('general', 'attempted legacy-category note', true, '/events/x');
    raise exception 'anon insert with category=general should have been rejected';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ locked-down insert paths stay closed';
end $$;

-- ── 4. DB max-length ──────────────────────────────────────────────────────
do $$
begin
  begin
    insert into feedback_posts (category, body, is_private, page_path)
    values ('orb', repeat('x', 1001), true, '/events/x');
    raise exception 'anon insert with a 1001-char body should have been rejected';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ DB max-length enforced';
end $$;

-- ── 5. Content moderation still fires on orb inserts ─────────────────────────
-- Same RETURNING-under-RLS trap as above applies here too — is_private=true
-- blocks anon SELECT regardless of status, so `returning status into s`
-- would silently yield NULL rather than proving anything. Insert as anon,
-- then check the resulting status as the connecting (owner) role, which
-- bypasses RLS entirely. moderation_request_role() reads the JWT claim (still
-- 'anon' from set_config above), not the actual Postgres role, so the 030
-- trigger fires exactly as it would for a real anon PostgREST request.
do $$
begin
  insert into feedback_posts (category, body, is_private, page_path)
  values ('orb', 'this note contains zzzorbtestblockedterm', true, '/events/x');
end $$;

reset role;
do $$
declare s text;
begin
  select status into s from feedback_posts
    where body like '%zzzorbtestblockedterm%'
    order by id desc limit 1;
  assert s = 'cancelled',
    'anon orb note matching an extreme term should be auto-cancelled by the 030 trigger, got ' || coalesce(s, '<null>');

  raise notice '  ✓ 030 moderation trigger still fires on orb inserts';
end $$;
set local role anon;

-- ── 6. Email length bound (058) ──────────────────────────────────────────────
-- ORDER MATTERS: this block must stay ABOVE the velocity-cap block below.
-- That block deliberately fills the one-minute window to 20 rows and never
-- unwinds them (the whole file is a single transaction), so any insert that
-- runs after it -- including these -- raises check_violation from the cap
-- trigger instead of exercising the email bound under test.
do $$
begin
  -- null email is fine
  insert into feedback_posts (category, body, is_private, page_path, email)
  values ('orb', 'email null test', true, '/events/x', null);

  -- exactly 254 chars is fine (the boundary)
  insert into feedback_posts (category, body, is_private, page_path, email)
  values ('orb', 'email 254 test', true, '/events/x', repeat('a', 249) || '@a.co');

  begin
    -- 255 chars is rejected
    insert into feedback_posts (category, body, is_private, page_path, email)
    values ('orb', 'email 255 test', true, '/events/x', repeat('a', 250) || '@a.co');
    raise exception 'anon insert with a 255-char email should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    -- empty string is rejected (must be null, not '')
    insert into feedback_posts (category, body, is_private, page_path, email)
    values ('orb', 'email empty test', true, '/events/x', '');
    raise exception 'anon insert with an empty-string email should have been rejected';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ email length bound enforced (null ok, 254 ok, 255 rejected, empty-string rejected)';
end $$;

-- ── 7. Velocity cap (043) ────────────────────────────────────────────────────
do $$
declare
  recent_count int;
  to_insert    int;
  i            int;
begin
  select count(*) into recent_count from feedback_posts where created_at > now() - interval '1 minute';
  to_insert := greatest(20 - recent_count, 0);

  for i in 1 .. to_insert loop
    insert into feedback_posts (category, body, is_private, page_path)
    values ('orb', 'velocity cap filler row ' || i, true, '/events/x');
  end loop;

  -- At least 20 rows now exist within the window; the next insert must raise.
  begin
    insert into feedback_posts (category, body, is_private, page_path)
    values ('orb', 'one insert too many', true, '/events/x');
    raise exception 'the 21st insert within one minute should have been rejected by the velocity cap';
  exception when check_violation then null;
  end;

  raise notice '  ✓ velocity cap rejects the 21st insert within one minute';
end $$;

reset role;
select 'ALL FEEDBACK ORB RLS TESTS PASSED' as result;

rollback;
