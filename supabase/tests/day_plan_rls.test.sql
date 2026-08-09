-- ════════════════════════════════════════════════════════════════════════════
-- day_plan_rls.test.sql
--
-- Regression tests for migration 052 (day_plans / day_plan_items -- the
-- collaborative day planner at /day and /d/<code>). Modeled on
-- supabase/tests/embed_request_rls.test.sql: self-contained begin/rollback,
-- set_config('request.jwt.claims', '{"role":"anon"}', true) + set local role
-- anon, final "ALL ... PASSED" marker.
--
-- docs/day-planner.md is gitignored and will not exist when this test is
-- read later, so every load-bearing rationale is restated inline below
-- rather than pointed at.
--
-- TWO TRAPS, same spirit as 051's warning about copying the wrong SQLSTATE:
--
-- 1. BOTH `set local role anon` AND the `request.jwt.claims` set_config are
--    required. day_plan_mutation_gate and moderation_screen_day_plan gate on
--    moderation_request_role(), which reads the JWT claim GUC; GUCs are
--    transaction-scoped and are NOT affected by SECURITY DEFINER, so a test
--    that sets only the role silently exercises a different code path (the
--    "not anon" branch) and would pass while asserting nothing about the
--    anon-facing behavior.
--
-- 2. Error classes differ by mechanism, and copying the wrong handler makes a
--    test pass vacuously.
--      - Direct table access with no policy       -> insufficient_privilege
--      - App-level guards raised in PL/pgSQL       -> check_violation
--        (velocity caps, missing/bad-code lookups, the 31st item, the add-time
--        published gate -- all raised `using errcode = 'check_violation'`,
--        matching the convention already established by 030/043/051)
--      - The item_count table CHECK                -> check_violation
--
-- SECURITY BOUNDARY THIS FILE GUARDS (§1 below is the load-bearing one):
-- day_plans and day_plan_items have RLS enabled with ZERO anon policies.
-- The ONLY way anon reaches them is the five SECURITY DEFINER functions in
-- migration 052. A future `create policy ... on day_plans for select to anon
-- using (true)` -- added by someone who sees an empty policy list and
-- assumes it's an oversight -- would silently convert this feature into a
-- public dump of every plan on the site, because an RLS USING clause cannot
-- see the client's WHERE clause (the only expressible anon SELECT policy is
-- `using (true)`). Section 1 below is what catches that regression. Treat it
-- as production code, not a nice-to-have.
--
-- Self-contained: runs inside a transaction and ROLLS BACK so nothing
-- persists. Run against a local `supabase start` DB or an isolated branch
-- that already has migration 052 applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/day_plan_rls.test.sql
--
-- A clean run prints "ALL DAY PLAN RLS TESTS PASSED". Any failure raises.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Seed a published venue + event to add to plans. service_role / migration
-- connection (no anon role set yet), so RLS doesn't get in the way here.
do $$
begin
  -- NOTE: this literal must be valid hex. An earlier revision used
  -- '...0000000000v1', which is not a UUID ('v' is not a hex digit) and made
  -- this file fail on its very first statement.
  insert into venues (id, name, city, state)
  values ('00000000-0000-0000-0000-0000000000f1', 'Test Venue', 'Akron', 'OH')
  on conflict (id) do nothing;
end $$;

-- ── Setup helper: a fresh published event, returns its id ──────────────────
create or replace function _dp_test_make_event(
  p_title text, p_start timestamptz, p_source text default 'manual', p_source_id text default null
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  -- Schema note (this file previously got all three of these wrong and could
  -- therefore never have run): `events` has NO `category` column (categories
  -- live in `category_slugs` plus the `event_categories` junction) and NO
  -- `venue_id` column (venues attach through the `event_venues` junction).
  insert into events (title, start_at, category_slugs, status, source, source_id)
  values (p_title, p_start, array['community'], 'published', p_source,
          coalesce(p_source_id, 'dp-test-' || gen_random_uuid()::text))
  returning id into v_id;

  insert into event_venues (event_id, venue_id)
  values (v_id, '00000000-0000-0000-0000-0000000000f1')
  on conflict do nothing;

  return v_id;
end; $$;

-- Simulate a PostgREST anon request for the rest of this file.
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

-- ── 1. No direct table access (THE test that guards the whole design) ──────
do $$
declare v_event uuid;
begin
  reset role;
  v_event := _dp_test_make_event('Direct Access Probe', now() + interval '3 days');
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  begin
    perform 1 from day_plans limit 1;
    raise exception 'anon SELECT on day_plans should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into day_plans (code, title) values ('aaaaaaaaaaaa', 'x');
    raise exception 'anon INSERT on day_plans should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    update day_plans set title = 'x';
    raise exception 'anon UPDATE on day_plans should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from day_plans;
    raise exception 'anon DELETE on day_plans should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    perform 1 from day_plan_items limit 1;
    raise exception 'anon SELECT on day_plan_items should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into day_plan_items (plan_id, event_id, snap_title, snap_start_at)
    values (gen_random_uuid(), v_event, 'x', now());
    raise exception 'anon INSERT on day_plan_items should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    update day_plan_items set removed_at = now();
    raise exception 'anon UPDATE on day_plan_items should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from day_plan_items;
    raise exception 'anon DELETE on day_plan_items should have been rejected';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ 1. no direct table access for anon on either table (insufficient_privilege) -- THE guard test';
end $$;

-- ── 2 & 3. create_day_plan returns a well-formed code; get_day_plan reads it ─
do $$
declare
  v_pid  uuid := gen_random_uuid();
  v_ev1  uuid;
  v_ev2  uuid;
  v_code text;
  v_plan jsonb;
begin
  reset role;
  v_ev1 := _dp_test_make_event('Jazz Night', now() + interval '2 days');
  v_ev2 := _dp_test_make_event('Art Walk', now() + interval '2 days' + interval '3 hours');
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  v_code := create_day_plan(v_pid, 'Weekend Plan', array[v_ev1, v_ev2]);
  assert v_code ~ '^[0-9a-hjkmnp-tv-z]{12}$', 'code must match the Crockford-base32 12-char shape';

  v_plan := get_day_plan(v_code);
  assert v_plan is not null, 'get_day_plan(correct code) should not be null';
  assert v_plan->>'title' = 'Weekend Plan', 'title should round-trip';
  assert jsonb_array_length(v_plan->'items') = 2, 'both items should be present';

  raise notice '  ✓ 2 & 3. create_day_plan issues a valid code; get_day_plan reads it back with its items';
end $$;

-- ── 4. Unknown / hostile codes return null, not an error ───────────────────
do $$
begin
  reset role;
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  assert get_day_plan('zzzzzzzzzzzz') is null, 'an unknown well-formed code should return null';
  assert get_day_plan(E'\' OR 1=1--') is null, 'a code-shaped string with SQL metacharacters should return null, not error (the function is parameterized)';
  assert get_day_plan('') is null, 'an empty string should return null';

  raise notice '  ✓ 4. get_day_plan(unknown/hostile code) returns null, never an error';
end $$;

-- ── 5. Plan isolation ────────────────────────────────────────────────────────
do $$
declare
  v_pid_a uuid := gen_random_uuid();
  v_pid_b uuid := gen_random_uuid();
  v_ev_a  uuid;
  v_ev_b  uuid;
  v_code_a text;
  v_code_b text;
  v_plan_a jsonb;
begin
  reset role;
  v_ev_a := _dp_test_make_event('Plan A Event', now() + interval '4 days');
  v_ev_b := _dp_test_make_event('Plan B Event', now() + interval '4 days');
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  v_code_a := create_day_plan(v_pid_a, 'Plan A', array[v_ev_a]);
  v_code_b := create_day_plan(v_pid_b, 'Plan B', array[v_ev_b]);

  v_plan_a := get_day_plan(v_code_a);
  assert jsonb_array_length(v_plan_a->'items') = 1, 'plan A should have exactly its own item';
  assert (v_plan_a->'items'->0->>'event_id')::uuid = v_ev_a, 'plan A must never see plan B''s items';

  raise notice '  ✓ 5. get_day_plan(codeA) never returns plan B''s items';
end $$;

-- ── 6 & 7. day_plan_add_event: wrong code raises; snapshot populated; add-time gate ─
do $$
declare
  v_pid   uuid := gen_random_uuid();
  v_ev    uuid;
  v_pending uuid;
  v_code  text;
  v_plan  jsonb;
  v_item  jsonb;
begin
  reset role;
  v_ev := _dp_test_make_event('Snapshot Probe', now() + interval '5 days');
  insert into events (title, start_at, category_slugs, status, source, source_id)
  values ('Pending Probe', now() + interval '5 days', array['community'], 'pending_review', 'manual', 'dp-pending-' || gen_random_uuid()::text)
  returning id into v_pending;
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  v_code := create_day_plan(v_pid, 'Snapshot Plan', array[]::uuid[]);

  begin
    perform day_plan_add_event('zzzzzzzzzzzz', v_ev);
    raise exception 'day_plan_add_event with a wrong code should have raised';
  exception when check_violation then null;
  end;

  v_plan := day_plan_add_event(v_code, v_ev);
  v_item := v_plan->'items'->0;
  assert v_item->>'snap_title' = 'Snapshot Probe', 'snap_title must be populated from the live row';
  assert v_item->>'rot_status' = 'ok', 'a freshly added published event should read back ok';

  begin
    perform day_plan_add_event(v_code, v_pending);
    raise exception 'adding a pending_review event should have raised (add-time gate)';
  exception when check_violation then null;
  end;

  raise notice '  ✓ 6 & 7. wrong code raises; snapshot populated on add; pending_review event rejected at add time';
end $$;

-- ── 8. 31st item -> check_violation ─────────────────────────────────────────
do $$
declare
  v_pid  uuid := gen_random_uuid();
  v_code text;
  v_ids  uuid[] := '{}';
  i      int;
begin
  reset role;
  for i in 1..31 loop
    v_ids := v_ids || _dp_test_make_event('Cap Probe ' || i, now() + interval '6 days' + (i || ' minutes')::interval);
  end loop;
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  begin
    v_code := create_day_plan(v_pid, 'Cap Plan', v_ids);
    raise exception 'a 31-item plan should have been rejected';
  exception when check_violation then null;
  end;

  raise notice '  ✓ 8. the 31st item is rejected with check_violation (30-item cap, D3)';
end $$;

-- ── 8b. 31st item via SEQUENTIAL day_plan_add_event calls -> check_violation ─
-- Distinct from #8, which only exercises the BULK create_day_plan path (that
-- function has its own explicit array-length check, section 9 of migration
-- 052). This exercises the single-item add RPC called 31 times in a row --
-- the path QA found untested (2026-08-08), where the design doc's "guarded
-- twice" claim did not actually hold before this fix: day_plan_add_event had
-- no explicit guard of its own, only the day_plans.item_count table CHECK
-- (bound via trg_day_plan_rollup) as a backstop. day_plan_add_event now also
-- raises its own friendly check_violation ahead of that CHECK (see migration
-- 052) -- this test asserts the error CLASS, matching the project convention
-- (030/043/051) that app-level guards raise `check_violation`, which is also
-- exactly the SQLSTATE a table CHECK violation raises natively, so this
-- assertion is correct whichever of the two actually fires.
do $$
declare
  v_pid  uuid := gen_random_uuid();
  v_code text;
  v_ids  uuid[] := '{}';
  i      int;
begin
  reset role;
  for i in 1..31 loop
    v_ids := v_ids || _dp_test_make_event('Sequential Cap Probe ' || i, now() + interval '6 days' + (i || ' minutes')::interval);
  end loop;
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  v_code := create_day_plan(v_pid, 'Sequential Cap Plan', array[]::uuid[]);

  for i in 1..30 loop
    perform day_plan_add_event(v_code, v_ids[i]);
  end loop;

  begin
    perform day_plan_add_event(v_code, v_ids[31]);
    raise exception 'the 31st item via a SEQUENTIAL day_plan_add_event call should have been rejected';
  exception when check_violation then null;
  end;

  raise notice '  ✓ 8b. the 31st item via SEQUENTIAL day_plan_add_event calls is rejected with check_violation too, not just the bulk create_day_plan path';
end $$;

-- ── 9. Remove tombstones; re-add clears removed_at and preserves added_at ──
do $$
declare
  v_pid  uuid := gen_random_uuid();
  v_ev   uuid;
  v_code text;
  v_plan jsonb;
  v_added_before timestamptz;
  v_added_after  timestamptz;
begin
  reset role;
  v_ev := _dp_test_make_event('Tombstone Probe', now() + interval '7 days');
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  v_code := create_day_plan(v_pid, 'Tombstone Plan', array[v_ev]);
  select added_at into v_added_before from day_plan_items where event_id = v_ev;

  v_plan := day_plan_remove_event(v_code, v_ev);
  assert jsonb_array_length(v_plan->'items') = 0, 'removed item must not appear in a live get_day_plan read';
  assert exists (select 1 from day_plan_items where event_id = v_ev and removed_at is not null),
    'the row must still exist after remove -- a remove is a tombstone, never a delete';

  perform pg_sleep(0); -- no-op, keeps the added_at comparison honest
  v_plan := day_plan_add_event(v_code, v_ev);
  select added_at into v_added_after from day_plan_items where event_id = v_ev;
  assert v_added_after = v_added_before, 're-adding must preserve the original added_at';
  assert (select removed_at from day_plan_items where event_id = v_ev) is null,
    're-adding must clear removed_at';

  raise notice '  ✓ 9. remove tombstones (row survives, hidden from get_day_plan); re-add clears removed_at, keeps added_at';
end $$;

-- ── 10. Per-plan mutation cap: 121st mutation -> check_violation ────────────
do $$
declare
  v_pid  uuid := gen_random_uuid();
  v_ev   uuid;
  v_code text;
  i      int;
begin
  reset role;
  v_ev := _dp_test_make_event('Mutation Cap Probe', now() + interval '8 days');
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  v_code := create_day_plan(v_pid, 'Mutation Cap Plan', array[]::uuid[]);
  -- create_day_plan does not itself count against the per-plan mutation
  -- window, so all 120 allowed mutations are available here.
  for i in 1..120 loop
    if i % 2 = 1 then
      perform day_plan_add_event(v_code, v_ev);
    else
      perform day_plan_remove_event(v_code, v_ev);
    end if;
  end loop;

  begin
    perform day_plan_add_event(v_code, v_ev);
    raise exception 'the 121st mutation within 10 minutes should have been rejected';
  exception when check_violation then null;
  end;

  raise notice '  ✓ 10. per-plan mutation cap rejects the 121st mutation within 10 minutes';
end $$;

-- ── 11. Global creation cap: 61st plan within an hour -> check_violation ───
-- ORDER MATTERS: run last among the create_day_plan-heavy sections, mirroring
-- 051's own ordering note, so it doesn't starve earlier sections that also
-- call create_day_plan.
do $$
declare
  recent_all int;
  to_insert  int;
  i          int;
  v_pid      uuid;
begin
  reset role;
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  select count(*) into recent_all from day_plans where created_at > now() - interval '1 hour';
  to_insert := greatest(60 - recent_all, 0);
  for i in 1..to_insert loop
    v_pid := gen_random_uuid();
    perform create_day_plan(v_pid, 'Filler ' || i, array[]::uuid[]);
  end loop;

  begin
    v_pid := gen_random_uuid();
    perform create_day_plan(v_pid, 'One Too Many', array[]::uuid[]);
    raise exception 'the 61st day plan within one hour should have been rejected';
  exception when check_violation then null;
  end;

  raise notice '  ✓ 11. global creation cap rejects the 61st plan within one hour';
end $$;

-- ── 12. Rot: gone ────────────────────────────────────────────────────────────
do $$
declare
  v_pid  uuid := gen_random_uuid();
  v_ev   uuid;
  v_code text;
  v_plan jsonb;
  v_item jsonb;
begin
  reset role;
  v_ev := _dp_test_make_event('Gone Probe', now() + interval '9 days');
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  v_code := create_day_plan(v_pid, 'Gone Plan', array[v_ev]);

  reset role;
  delete from events where id = v_ev;
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  v_plan := get_day_plan(v_code);
  v_item := v_plan->'items'->0;
  assert v_item->>'rot_status' = 'gone', 'a deleted-with-no-alias event must read back as gone';
  assert v_item->>'snap_title' = 'Gone Probe', 'a gone item still renders its snapshot title';

  raise notice '  ✓ 12. rot: gone -- deleted event with no alias renders from the snapshot, still returned';
end $$;

-- ── 13. Rot: merged ──────────────────────────────────────────────────────────
do $$
declare
  v_pid   uuid := gen_random_uuid();
  v_dup   uuid;
  v_canon uuid;
  v_code  text;
  v_plan  jsonb;
  v_item  jsonb;
begin
  reset role;
  v_dup   := _dp_test_make_event('Duplicate Listing', now() + interval '10 days', 'eventbrite', 'dp-dup-src-1');
  v_canon := _dp_test_make_event('Canonical Listing', now() + interval '10 days');
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  v_code := create_day_plan(v_pid, 'Merge Plan', array[v_dup]);

  reset role;
  insert into event_aliases (duplicate_source, duplicate_source_id, canonical_event_id, reason)
  values ('eventbrite', 'dp-dup-src-1', v_canon, 'dedupe-cross-source:test:cross-source');
  delete from events where id = v_dup;
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  v_plan := get_day_plan(v_code);
  v_item := v_plan->'items'->0;
  assert v_item->>'rot_status' = 'merged', 'a deleted-but-aliased event must read back as merged';
  assert v_item->>'title' = 'Canonical Listing', 'a merged item renders the CANONICAL event''s live title, not the snapshot';

  raise notice '  ✓ 13. rot: merged -- alias-resolved deleted event renders the canonical event''s live data';
end $$;

-- ── 14. Rot: cancelled ───────────────────────────────────────────────────────
do $$
declare
  v_pid  uuid := gen_random_uuid();
  v_ev   uuid;
  v_code text;
  v_plan jsonb;
  v_item jsonb;
begin
  reset role;
  v_ev := _dp_test_make_event('Cancellation Probe', now() + interval '11 days');
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  v_code := create_day_plan(v_pid, 'Cancel Plan', array[v_ev]);

  reset role;
  update events set event_status = 'cancelled' where id = v_ev;
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  v_plan := get_day_plan(v_code);
  v_item := v_plan->'items'->0;
  assert v_item->>'rot_status' = 'cancelled', 'a cancelled event must be returned, not dropped';
  assert v_item is not null, 'the item must still be present (never silently vanish)';

  raise notice '  ✓ 14. rot: cancelled -- returned with rot_status=cancelled, never dropped (this is the SECURITY DEFINER''s whole reason to exist)';
end $$;

-- ── 15. Rot: moved ───────────────────────────────────────────────────────────
do $$
declare
  v_pid  uuid := gen_random_uuid();
  v_ev   uuid;
  v_code text;
  v_plan jsonb;
  v_item jsonb;
  v_new_start timestamptz := now() + interval '12 days' + interval '2 hours';
begin
  reset role;
  v_ev := _dp_test_make_event('Reschedule Probe', now() + interval '12 days');
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  v_code := create_day_plan(v_pid, 'Reschedule Plan', array[v_ev]);

  reset role;
  update events set start_at = v_new_start where id = v_ev;
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  v_plan := get_day_plan(v_code);
  v_item := v_plan->'items'->0;
  assert v_item->>'rot_status' = 'moved', 'a rescheduled event must read back as moved';
  assert (v_item->>'start_at')::timestamptz = v_new_start, 'the NEW start time must be present';
  assert v_item->>'snap_start_at' is not null, 'the OLD (snapshot) start time must also be present, for the struck-through old time';

  raise notice '  ✓ 15. rot: moved -- new time present, old (snapshot) time also present';
end $$;

-- ── 16. purge_expired_day_plans: deletes expired, spares a live reschedule ──
do $$
declare
  v_pid_expired  uuid := gen_random_uuid();
  v_pid_extended uuid := gen_random_uuid();
  v_ev_expired   uuid;
  v_ev_extended  uuid;
  v_code_expired  text;
  v_code_extended text;
  v_deleted int;
begin
  reset role;
  v_ev_expired  := _dp_test_make_event('Long Past Probe', now() - interval '20 days');
  v_ev_extended := _dp_test_make_event('Rescheduled Forward Probe', now() - interval '20 days');
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  v_code_expired  := create_day_plan(v_pid_expired, 'Expired Plan', array[v_ev_expired]);
  v_code_extended := create_day_plan(v_pid_extended, 'Extended Plan', array[v_ev_extended]);

  reset role;
  -- Force both plans' trigger-maintained expires_at into the past (they'd
  -- otherwise be computed from a snapshot taken above, before the reschedule).
  update day_plans set expires_at = now() - interval '1 day'
   where id in (v_pid_expired, v_pid_extended);
  -- The "extended" plan's live event was rescheduled forward AFTER the
  -- snapshot was taken -- the reaper's live re-check must spare it.
  update events set start_at = now() + interval '30 days' where id = v_ev_extended;

  v_deleted := purge_expired_day_plans();

  assert not exists (select 1 from day_plans where id = v_pid_expired),
    'a plan whose live event is still safely in the past must be purged';
  assert exists (select 1 from day_plans where id = v_pid_extended),
    'a plan whose live event was rescheduled INTO THE FUTURE must survive despite a stale expires_at';

  raise notice '  ✓ 16. purge_expired_day_plans deletes a truly-expired plan and spares one rescheduled forward (live re-check)';
end $$;

-- ── 17. anon cannot execute service-role-only functions ─────────────────────
do $$
begin
  reset role;
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  begin
    perform purge_expired_day_plans();
    raise exception 'anon should not be able to execute purge_expired_day_plans';
  exception when insufficient_privilege then null;
  end;

  begin
    perform gen_day_plan_code();
    raise exception 'anon should not be able to execute gen_day_plan_code';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ 17. anon cannot execute purge_expired_day_plans or gen_day_plan_code (insufficient_privilege)';
end $$;

-- ── 18. Moderation trigger nulls a seeded extreme title, keeps the plan ────
-- Mirrors feedback_orb_rls.test.sql's approach: seed the term list itself
-- rather than depend on production moderation_terms content.
do $$
declare
  v_pid  uuid := gen_random_uuid();
  v_code text;
  v_plan jsonb;
  v_term text := 'dptestextremeterm' || substr(gen_random_uuid()::text, 1, 8);
begin
  reset role;
  insert into moderation_terms (term, kind, severity) values (v_term, 'phrase', 'extreme');
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  v_code := create_day_plan(v_pid, v_term, array[]::uuid[]);
  v_plan := get_day_plan(v_code);
  assert v_plan is not null, 'the plan must survive moderation screening';
  assert v_plan->>'title' is null, 'a title matching a seeded extreme term must be nulled, not rejected';

  raise notice '  ✓ 18. moderation trigger nulls a seeded extreme title on create, keeps the plan and its items';
end $$;

reset role;
drop function if exists _dp_test_make_event(text, timestamptz, text, text);
select 'ALL DAY PLAN RLS TESTS PASSED' as result;

rollback;
