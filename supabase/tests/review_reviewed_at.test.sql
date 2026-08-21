-- ════════════════════════════════════════════════════════════════════════════
-- review_reviewed_at.test.sql
--
-- Regression tests for migration 060 (reviewed_at -- approvals survive the
-- nightly re-scrape). Modeled on supabase/tests/admin_boundary_rls.test.sql.
--
-- THE BUG. `events.needs_review` carried two facts under one name: the
-- scraper's per-run confidence assessment, which it correctly recomputes every
-- night (scripts/lib/normalize.js:1803), and the human's triage decision, which
-- nothing protected. Measured on prod 2026-08-21: 159 of the 200 upcoming rows
-- in the queue would have their approval reverted by that night's run.
--
-- 060 splits them. `needs_review` keeps its meaning and stays freely
-- recomputed; `reviewed_at` is the human decision and no scraper payload ever
-- contains it. The queue is `needs_review AND reviewed_at IS NULL`.
--
-- What this file pins, and why each one is here rather than obvious:
--
--   §1  The mechanism itself: an upsert that OMITS reviewed_at cannot clear it,
--       while needs_review stays freely writable. This is the whole fix.
--   §2  A scraper changing title or start_at DOES re-open review. A settled
--       judgement was about a specific title at a specific time.
--   §3  An ADMIN changing the same fields does NOT re-open it. An admin
--       retitling a row must not clear their own decision.
--   §4  Description churn does NOT re-open it. Aggregator descriptions change
--       constantly; keying on them would re-open the queue on whitespace.
--   §5  ⚠️  THE TRIGGER-ORDER TEST. Same-timing triggers fire in NAME order.
--       `trg_events_reopen_review` MUST sort after
--       `trg_enforce_manual_overrides_events`, which restores OLD.title for a
--       title-locked row. If the order is ever reversed -- by a rename, or by
--       someone adding a trigger that sorts between them -- this is the ONLY
--       assertion here that fails, and the symptom in production would be the
--       most deliberately-settled rows re-opening every single night.
--   §6  A signed-in NON-admin is untrusted, not exempt. 059's exemption list
--       sits three lines away in the source and looks copy-pasteable; note
--       that this trigger must NOT exempt service_role, which is the inverse
--       of 059 on exactly one entry.
--   §7  The backfill adopts object-shaped manual_overrides.needs_review markers
--       and SKIPS the ~181 string-shaped ones written by SQL sweeps, without
--       erroring on them.
--
-- NOTE ON ORDERING: this file inserts into `events` only. It does not touch
-- feedback_posts or embed_requests, so the velocity-cap ordering constraint
-- documented in feedback_orb_rls.test.sql:147-151 does not apply here. If a
-- rate-limited table is ever added to this file, new blocks go ABOVE the cap.
--
-- Run against a database with 001-060 applied. Rolls itself back.
-- ════════════════════════════════════════════════════════════════════════════

begin;

do $$
declare
  v_id uuid; v_ra timestamptz; v_nr boolean; v_title text;
  v_admin uuid; v_stranger uuid := 'a0000000-0000-0000-0000-0000000000ff';
  SVC     constant text := '{"role":"service_role"}';
  ADMIN_C text;
  STRANGE constant text := '{"role":"authenticated","sub":"a0000000-0000-0000-0000-0000000000ff"}';
begin
  select user_id into v_admin from admin_users limit 1;
  if v_admin is null then
    raise exception 'PRECONDITION FAIL: admin_users is empty. Run 059 first.';
  end if;
  ADMIN_C := json_build_object('role','authenticated','sub',v_admin)::text;

  insert into auth.users (id, email) values (v_stranger, 'stranger@test.invalid')
    on conflict (id) do nothing;

  -- ── §1 the mechanism: re-scrape preserves reviewed_at ───────────────────
  insert into events (title, start_at, source, source_id, needs_review)
    values ('060 test row', now() + interval '5 days', 'test_060', 'sid-1', true)
    returning id into v_id;

  perform set_config('request.jwt.claims', ADMIN_C, true);
  update events set reviewed_at = now(), reviewed_by = v_admin, needs_review = false
   where id = v_id;

  -- the nightly scrape: an upsert whose payload has no reviewed_at key
  perform set_config('request.jwt.claims', SVC, true);
  update events set needs_review = true where id = v_id;

  select reviewed_at, needs_review into v_ra, v_nr from events where id = v_id;
  if v_ra is null then
    raise exception '§1 FAIL: re-scrape cleared reviewed_at. The fix does not work.';
  end if;
  if v_nr is not true then
    raise exception '§1 FAIL: needs_review is no longer freely recomputable.';
  end if;
  raise notice '  ok §1  re-scrape preserves reviewed_at; needs_review stays free';

  -- ── §2 a scraper title / start_at change RE-OPENS review ────────────────
  update events set title = '060 test row RENAMED' where id = v_id;
  select reviewed_at into v_ra from events where id = v_id;
  if v_ra is not null then
    raise exception '§2 FAIL: scraper retitle did not re-open review';
  end if;

  perform set_config('request.jwt.claims', ADMIN_C, true);
  update events set reviewed_at = now(), reviewed_by = v_admin where id = v_id;
  perform set_config('request.jwt.claims', SVC, true);
  update events set start_at = now() + interval '9 days' where id = v_id;
  select reviewed_at into v_ra from events where id = v_id;
  if v_ra is not null then
    raise exception '§2 FAIL: scraper start_at change did not re-open review';
  end if;
  raise notice '  ok §2  scraper title and start_at changes re-open review';

  -- ── §3 an ADMIN editing the same fields does NOT re-open ────────────────
  perform set_config('request.jwt.claims', ADMIN_C, true);
  update events set reviewed_at = now(), reviewed_by = v_admin where id = v_id;
  update events set title = 'Admin Retitled' where id = v_id;
  select reviewed_at into v_ra from events where id = v_id;
  if v_ra is null then
    raise exception '§3 FAIL: an admin edit cleared the admin''s own decision';
  end if;
  raise notice '  ok §3  admin retitle keeps reviewed_at';

  -- ── §4 description churn does NOT re-open ───────────────────────────────
  perform set_config('request.jwt.claims', SVC, true);
  update events set description = 'aggregator whitespace churn' where id = v_id;
  select reviewed_at into v_ra from events where id = v_id;
  if v_ra is null then
    raise exception '§4 FAIL: description churn re-opened review';
  end if;
  raise notice '  ok §4  description churn does not re-open review';

  -- ── §5 ⚠️  TRIGGER ORDER: a LOCKED title must not re-open nightly ───────
  perform set_config('request.jwt.claims', ADMIN_C, true);
  update events
     set manual_overrides = manual_overrides
                          || jsonb_build_object('title', jsonb_build_object('at', now()))
   where id = v_id;
  update events set reviewed_at = now(), reviewed_by = v_admin where id = v_id;

  perform set_config('request.jwt.claims', SVC, true);
  update events set title = 'Scraper Tried To Rename' where id = v_id;

  select reviewed_at, title into v_ra, v_title from events where id = v_id;
  if v_title <> 'Admin Retitled' then
    raise exception '§5 FAIL: enforce_manual_overrides did not protect the locked title (got %)', v_title;
  end if;
  if v_ra is null then
    raise exception
      '§5 FAIL: TRIGGER ORDER IS WRONG. trg_events_reopen_review must sort AFTER '
      'trg_enforce_manual_overrides_events. As written, every title-locked row '
      're-opens on every nightly run.';
  end if;
  raise notice '  ok §5  locked title: scraper blocked AND reviewed_at survives (order correct)';

  -- ── §6 a signed-in NON-admin is untrusted, not exempt ───────────────────
  -- fresh row: the §5 row has a locked title, so there would be no material
  -- change for the trigger to react to.
  insert into events (title, start_at, source, source_id)
    values ('060 stranger row', now() + interval '5 days', 'test_060', 'sid-2')
    returning id into v_id;
  perform set_config('request.jwt.claims', ADMIN_C, true);
  update events set reviewed_at = now(), reviewed_by = v_admin where id = v_id;

  perform set_config('request.jwt.claims', STRANGE, true);
  update events set title = 'Stranger Retitle' where id = v_id;
  select reviewed_at into v_ra from events where id = v_id;
  if v_ra is not null then
    raise exception '§6 FAIL: a signed-in non-admin was exempted from re-opening';
  end if;
  raise notice '  ok §6  signed-in non-admin is NOT exempt';

  -- direct DB access (NULL claims, the Supabase SQL editor) IS exempt
  perform set_config('request.jwt.claims', ADMIN_C, true);
  update events set reviewed_at = now(), reviewed_by = v_admin where id = v_id;
  perform set_config('request.jwt.claims', '', true);
  update events set title = 'SQL Editor Retitle' where id = v_id;
  select reviewed_at into v_ra from events where id = v_id;
  if v_ra is null then
    raise exception '§6 FAIL: a direct-DB edit cleared the decision';
  end if;
  raise notice '  ok §6  NULL-claims (SQL editor) is exempt';

  -- ── §7 the backfill: adopt object markers, skip string ones ─────────────
  perform set_config('request.jwt.claims', '', true);

  insert into events (title, start_at, needs_review, manual_overrides)
    values ('060 pinned row', now() + interval '2 days', true,
            '{"needs_review":{"at":"2026-07-27T12:00:00Z","by":"review-queue-2026-07-27"}}'::jsonb);
  insert into events (title, start_at, needs_review, manual_overrides)
    values ('060 sweep row', now() + interval '2 days', true,
            '{"needs_review":"dq-sweep-2026-07-18"}'::jsonb);

  update events
     set reviewed_at = nullif(manual_overrides -> 'needs_review' ->> 'at', '')::timestamptz
   where manual_overrides ? 'needs_review'
     and jsonb_typeof(manual_overrides -> 'needs_review') = 'object'
     and (manual_overrides -> 'needs_review' ->> 'at') is not null
     and reviewed_at is null;

  select reviewed_at into v_ra from events where title = '060 pinned row';
  if v_ra is null then
    raise exception '§7 FAIL: backfill did not adopt an object-shaped marker';
  end if;

  select reviewed_at into v_ra from events where title = '060 sweep row';
  if v_ra is not null then
    raise exception '§7 FAIL: backfill touched a string-shaped sweep marker';
  end if;
  raise notice '  ok §7  backfill adopts object markers and skips string ones';

  raise notice 'ALL REVIEWED_AT (060) TESTS PASSED';
end $$;

rollback;
