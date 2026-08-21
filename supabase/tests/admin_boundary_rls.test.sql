-- ════════════════════════════════════════════════════════════════════════════
-- admin_boundary_rls.test.sql
--
-- Regression tests for migration 059 (admin boundary -- is_admin()).
-- Modeled on supabase/tests/anon_submission_rls.test.sql and
-- supabase/tests/feedback_orb_rls.test.sql.
--
-- 059 replaced "is there a session" with an explicit membership test. Before
-- it, ANY signed-in Supabase Auth user was a full administrator (audit finding
-- H1), and `anon` could write the three junction tables (audit finding M1).
-- This file pins the new contract from three sides at once:
--
--   1. The seed exists, and it contains BOTH administrators. If either row is
--      missing, 059 locked one of them out of the admin UI and every other
--      assertion below is meaningless.
--   2. A signed-in STRANGER -- a Supabase Auth session with no admin_users
--      row -- gets exactly the anon surface and nothing more. This is the
--      assertion that would have caught H1.
--   3. `anon` can no longer write event_venues / event_organizations /
--      event_areas, and neither can a signed-in stranger. The second half is
--      what catches a future maintainer "completing the sweep" of 059's two
--      widened policies by widening these three the same way.
--
-- Plus the halves that are easy to omit and expensive to lose:
--   • a signed-in non-admin can still READ the public Town Square (§3b) -- the
--     read-side twin of the 054 bug class, and the one thing "gets exactly the
--     anon surface" must not be allowed to mean less than;
--   • every public submit path still works, for anon AND for a signed-in
--     visitor (the 054 bug class -- 059 re-armed it on two more tables);
--   • the admin still has everything ("did we accidentally revoke something");
--   • admin triage does not bounce a flagged row back to pending_review.
--
-- ⚠️  ORDER MATTERS, and it matters for a reason that is invisible on the page.
--     This file inserts into feedback_posts in §7 and §9. 043's
--     feedback_rate_limit() raises check_violation on the 21st insert within a
--     one-minute window, and because the whole file is a single transaction a
--     block that fills that window NEVER unwinds it --
--     feedback_orb_rls.test.sql:147-151 documents the same trap for its own
--     email-bound block, and embed_request_rls.test.sql:229-236 for the embed
--     caps. This file deliberately contains NO velocity-cap block. If one is
--     ever added, it goes LAST, below everything else, or every insert above
--     it starts failing for an unrelated reason.
--
-- ⚠️  Both `set local role <role>` AND the matching `request.jwt.claims` GUC
--     are required together -- the role selects the RLS policy set, the claim
--     is what auth.uid() and moderation_request_role() read. Setting only one
--     of the two silently tests the wrong principal. See
--     day_plan_rls.test.sql:656-658.
--
-- Self-contained: runs inside a transaction and ROLLS BACK so nothing
-- persists. Run against a local `supabase start` DB or an isolated branch that
-- already has migration 059 applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/admin_boundary_rls.test.sql
--
-- A clean run prints "ALL ADMIN BOUNDARY RLS TESTS PASSED". Any failure raises.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 0. Fixtures, seeded as the connecting (owner) role ───────────────────────
-- THREE identities. The two admins are the two REAL rows in auth.users that
-- 059 section 2 seeds, so this file tests the accounts that actually exist:
--   admin A  c5b809ab-8ad0-4e2e-a985-cc709726c12b  byronddelpinal@gmail.com
--   admin B  5c30e2be-fb56-4b29-923d-71cce9722d80  mac@artxlove.com
-- Both must come out of §1, §2 and §8 with is_admin() true and full access.
--
-- The STRANGER is synthetic and created below:
--   stranger a0000000-0000-4000-8000-0000000000ff  boundary-stranger@example.com
-- It has to be synthetic BECAUSE both real accounts are admins. Reusing either
-- of them as the "stranger" would make every negative assertion in §3-§5, §7b
-- and §9a assert the opposite of the truth, and the file would go green while
-- proving nothing. The row is written to auth.users rather than conjured out
-- of a JWT claim so the fixture is a genuine signed-in user that simply is not
-- on the roster -- the exact principal audit finding H1 is about -- and so a
-- future assertion may join it against admin_users. The whole file rolls back,
-- so nothing persists.
--
-- Strictly speaking the auth.users row is not required for the RLS assertions:
-- auth.uid() reads the JWT `sub` claim and is_admin() joins that against
-- admin_users, so identity is a matter of what the claim says. It is written
-- anyway; a fixture that cannot exist in auth.users is not a stranger, it is a
-- typo.
--
-- A throwaway term list is seeded the way feedback_orb_rls.test.sql:43-45 and
-- content_moderation.test.sql do, so §9 holds whether or not the real
-- (env-var) list is loaded locally. moderation_terms is RLS-protected with
-- zero anon/authenticated policies, so this must happen before any role
-- switch.
insert into moderation_terms (term, severity, kind) values
  ('zzzadminboundaryterm', 'high', 'word')
on conflict (term) do update set severity = excluded.severity, kind = excluded.kind;

-- The synthetic non-admin. Every negative assertion in this file is asserted
-- against THIS uuid, never against a real account -- see the note above.
insert into auth.users (id, email)
values ('a0000000-0000-4000-8000-0000000000ff', 'boundary-stranger@example.com')
on conflict (id) do nothing;

insert into venues (id, name, status)
values ('a0000000-0000-4000-8000-000000000001', 'Admin Boundary Test Venue', 'published');

insert into organizations (id, name, status)
values ('a0000000-0000-4000-8000-000000000002', 'Admin Boundary Test Org', 'published');

insert into areas (id, venue_id, name)
values ('a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'Admin Boundary Test Area');

insert into events (id, title, description, start_at, source, status, featured)
values ('a0000000-0000-4000-8000-000000000004', 'Admin Boundary Published Event',
        'A perfectly ordinary description.', now() + interval '7 days', 'manual', 'published', false);

-- The ORPHAN: zero event_organizations rows. This is the row the dropped anon
-- INSERT policy turned into a privilege-escalation primitive, so §5 asserts
-- against it specifically and not only against the published event.
insert into events (id, title, description, start_at, source, status, featured)
values ('a0000000-0000-4000-8000-000000000005', 'Admin Boundary Orphan Event',
        'A perfectly ordinary description.', now() + interval '8 days', 'manual', 'published', false);

insert into subscribers (id, email) values ('a0000000-0000-4000-8000-000000000006', 'boundary@example.com');

-- Two Town Square rows for §3b: one the public may read, one it may not.
-- Seeded as the owner so the 030 screen and the 043 velocity cap both see a
-- NULL request role and stay out of the way. Neither body may contain the
-- flagged term, or §9's `order by id desc limit 1` lookups would find them.
insert into feedback_posts (category, body, is_private, status, page_path) values
  ('general', 'boundary public town square note',  false, 'published',      '/'),
  ('orb',     'boundary private town square note', true,  'published',      '/events/x'),
  ('general', 'boundary unpublished note',         false, 'pending_review', '/');

-- ── 1. The seed exists -- the lockout guard ───────────────────────────────────
-- 059's own header calls this out: admin_users must contain BOTH
-- administrators' user_ids before any policy references is_admin(), or the
-- migration locks one of them out the instant it commits. If either assertion
-- fails, stop and do not apply 059 to anything else.
--
-- The roster is data, not schema, so this does NOT assert `count(*) = 2`: a
-- third admin added later with `insert into admin_users` is a legitimate
-- state, not a regression. What must hold is that both seeded principals are
-- on it and that the synthetic stranger is not.
do $$
begin
  assert exists (select 1 from admin_users where user_id = 'c5b809ab-8ad0-4e2e-a985-cc709726c12b'),
    'admin_users must contain byronddelpinal@gmail.com BEFORE any policy references is_admin() -- see 059 section 2. A missing row means 059 locked him out of the admin UI.';

  assert exists (select 1 from admin_users where user_id = '5c30e2be-fb56-4b29-923d-71cce9722d80'),
    'admin_users must contain mac@artxlove.com BEFORE any policy references is_admin() -- see 059 section 2. Both principals are full admins; a missing row means 059 locked him out of the admin UI.';

  assert not exists (select 1 from admin_users where user_id = 'a0000000-0000-4000-8000-0000000000ff'),
    'the synthetic stranger fixture must NOT be on the roster -- if it is, every negative assertion below is vacuous';

  raise notice '  ✓ 1. admin roster seeded: both administrators are in, the stranger fixture is not';
end $$;

-- ── 2. is_admin() truth table ────────────────────────────────────────────────
do $$
begin
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"c5b809ab-8ad0-4e2e-a985-cc709726c12b"}', true);
  assert is_admin(), 'byronddelpinal@gmail.com is seeded and must be an admin';

  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"5c30e2be-fb56-4b29-923d-71cce9722d80"}', true);
  assert is_admin(), 'mac@artxlove.com is seeded and must be an admin too';

  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"a0000000-0000-4000-8000-0000000000ff"}', true);
  assert not is_admin(), 'a signed-in user with no admin_users row must NOT be an admin';

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  assert not is_admin(), 'anon must not be an admin';

  perform set_config('request.jwt.claims', '', true);
  assert not is_admin(), 'a caller with no JWT claims at all must not be an admin (auth.uid() is null)';

  raise notice '  ✓ 2. is_admin() true for both seeded admins, false for everyone else';
end $$;

-- ── 3. A signed-in stranger reads NOTHING from the admin-only tables ─────────
-- Audit finding H1, stated as a test. `subscribers` is the row that matters
-- most: email plus the secret unsubscribe token.
--
-- NOTE the assertion shape. A SELECT filtered by an RLS USING clause returns
-- ZERO ROWS; it does not raise. Asserting on an exception here would pass
-- vacuously if the policy were restored to `using (true)`, because no
-- exception would be raised in either case. Count the rows.
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a0000000-0000-4000-8000-0000000000ff"}', true);
set local role authenticated;

do $$
begin
  assert (select count(*) from subscribers)         = 0, 'stranger must not read subscribers (email + unsubscribe token) -- audit H1';
  assert (select count(*) from email_sends)         = 0, 'stranger must not read email_sends';
  assert (select count(*) from embed_requests)      = 0, 'stranger must not read embed_requests (partner contact details) -- 051:126-130';
  assert (select count(*) from slack_notifications) = 0, 'stranger must not read slack_notifications';
  assert (select count(*) from event_aliases)       = 0, 'stranger must not read event_aliases';
  assert (select count(*) from venue_aliases)       = 0, 'stranger must not read venue_aliases';

  raise notice '  ✓ 3. signed-in stranger reads zero rows from all six admin-only tables';
end $$;

-- ── 3b. ...but the stranger must still READ THE PUBLIC TOWN SQUARE ────────────
-- The read-side twin of the 054 bug class, and the one regression 059 would
-- otherwise have shipped. feedback_posts has exactly two SELECT policies:
-- "Authenticated full access feedback_posts" (narrowed to is_admin() by 059)
-- and "Public read published non-private feedback" (038:118-120), which was
-- `to anon` ONLY. A `to anon` policy contributes nothing to a caller whose
-- role is `authenticated`, so narrowing the first without widening the second
-- takes a signed-in non-admin from "sees every published public post" to
-- "sees zero rows" -- silently, as an empty page rather than an error.
-- 059 section 4b widens the public read; this pins that it did.
--
-- Both halves are asserted together on purpose. Widening the read is only
-- correct if it stays the ANON read surface: the USING clause is untouched, so
-- private and unpublished rows must remain invisible. An assertion that only
-- counted the public row would pass just as happily against
-- `using (true)`.
do $$
begin
  assert (select count(*) from feedback_posts
           where body = 'boundary public town square note') = 1,
    'a SIGNED-IN NON-ADMIN must still read published non-private feedback -- 059 narrows the only other SELECT policy on this table, so "Public read published non-private feedback" must be widened to authenticated (059 section 4b)';

  assert (select count(*) from feedback_posts
           where body = 'boundary private town square note') = 0,
    'a signed-in non-admin must NOT read PRIVATE feedback -- the widened public read keeps its USING clause, it does not become using (true)';

  assert (select count(*) from feedback_posts
           where body = 'boundary unpublished note') = 0,
    'a signed-in non-admin must NOT read unpublished feedback -- same USING clause, status = published half';

  raise notice '  ✓ 3b. signed-in stranger reads published public feedback and nothing private or unpublished';
end $$;

-- ── 4. A signed-in stranger cannot WRITE the core entity tables ──────────────
-- Two different failure modes, and conflating them is how a test passes while
-- the boundary is open:
--   • UPDATE / DELETE -- rows the USING clause rejects are silently filtered
--     out, so the statement succeeds and affects ZERO rows. No exception.
--   • INSERT -- there is no row to filter, so a failed WITH CHECK raises
--     insufficient_privilege (42501).
do $$
declare n int;
begin
  update events set title = 'stranger rewrote this' where id = 'a0000000-0000-4000-8000-000000000004';
  get diagnostics n = row_count;
  assert n = 0, 'stranger UPDATE on events must affect zero rows, affected ' || n;

  delete from events where id = 'a0000000-0000-4000-8000-000000000004';
  get diagnostics n = row_count;
  assert n = 0, 'stranger DELETE on events must affect zero rows, affected ' || n;

  update venues set name = 'stranger rewrote this' where id = 'a0000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'stranger UPDATE on venues must affect zero rows, affected ' || n;

  update organizations set name = 'stranger rewrote this' where id = 'a0000000-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  assert n = 0, 'stranger UPDATE on organizations must affect zero rows, affected ' || n;

  raise notice '  ✓ 4a. signed-in stranger cannot update or delete events / venues / organizations';
end $$;

do $$
begin
  -- may not self-publish a venue (only the pending_review submit surface)
  begin
    insert into venues (name, status) values ('stranger published venue', 'published');
    raise exception 'stranger insert of a published venue should have been rejected';
  exception when insufficient_privilege then null;
  end;

  -- may not self-publish an organization
  begin
    insert into organizations (name, status) values ('stranger published org', 'published');
    raise exception 'stranger insert of a published organization should have been rejected';
  exception when insufficient_privilege then null;
  end;

  -- may not self-publish an event, forge a scraper source, or set featured
  begin
    insert into events (title, start_at, source, status)
    values ('stranger self-publish attempt', now() + interval '1 day', 'manual', 'published');
    raise exception 'stranger insert of a published event should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into events (title, start_at, source, status)
    values ('stranger forged-source attempt', now() + interval '1 day', 'ticketmaster', 'pending_review');
    raise exception 'stranger insert with a scraper source should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into events (title, start_at, source, status, featured)
    values ('stranger featured attempt', now() + interval '1 day', 'manual', 'pending_review', true);
    raise exception 'stranger insert with featured=true should have been rejected';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ 4b. signed-in stranger gets exactly the anon write surface, not a wider one';
end $$;

-- ── 5. A signed-in stranger cannot write the junction tables either ──────────
-- This is the assertion that catches a future maintainer "completing the
-- sweep" of 059 section 4b by widening the three junction policies to
-- `anon, authenticated` the way `areas` and `event_categories` were widened.
-- Those two have live public callers; these three have none. See 059 section 5.
do $$
begin
  begin
    insert into event_organizations (event_id, organization_id)
    values ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002');
    raise exception 'stranger insert into event_organizations should have been rejected';
  exception when insufficient_privilege then null;
  end;

  -- Against the ORPHAN specifically: this is the escalation shape. An event
  -- with zero organization links plus one attacker-supplied link is an event
  -- whose entire organizer set belongs to whoever wrote that row.
  begin
    insert into event_organizations (event_id, organization_id)
    values ('a0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000002');
    raise exception 'stranger insert into event_organizations (orphan event) should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into event_venues (event_id, venue_id)
    values ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001');
    raise exception 'stranger insert into event_venues should have been rejected';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into event_areas (event_id, area_id)
    values ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000003');
    raise exception 'stranger insert into event_areas should have been rejected';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ 5. signed-in stranger cannot insert into any of the three junction tables';
end $$;

-- ── 6. anon cannot write the junction tables -- audit finding M1 ──────────────
-- 006:203-216 granted these unconditionally and 038 dropped only the DELETE
-- twins. 059 drops the INSERT policies and revokes the grant, so anon now
-- fails on the table grant rather than on the policy -- still 42501, one layer
-- earlier.
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

do $$
begin
  begin
    insert into event_organizations (event_id, organization_id)
    values ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002');
    raise exception 'anon insert into event_organizations should have been rejected -- audit M1';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into event_organizations (event_id, organization_id)
    values ('a0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000002');
    raise exception 'anon insert into event_organizations (orphan event) should have been rejected -- the escalation path';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into event_venues (event_id, venue_id)
    values ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001');
    raise exception 'anon insert into event_venues should have been rejected -- audit M1';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into event_areas (event_id, area_id)
    values ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000003');
    raise exception 'anon insert into event_areas should have been rejected -- audit M1';
  exception when insufficient_privilege then null;
  end;

  raise notice '  ✓ 6. anon cannot insert into any of the three junction tables (published or orphan)';
end $$;

-- ── 7. Every public submit path still works -- for anon AND for a stranger ────
-- The single most likely regression in the whole migration, and the one that
-- fails silently: SubmitPage.tsx:93, VenueSubmitPage.tsx:101 and
-- OrganizationSubmitPage.tsx:151 all swallow their error into a console.warn,
-- so a broken categories or areas insert looks like a successful submission.
--
-- Both halves are asserted. Before 054 only the anon half existed, and that is
-- exactly why the bug 054 fixed survived for weeks: neither psql, nor curl,
-- nor the SQL editor, nor a logged-out browser can produce the `authenticated`
-- role (054:25-27).
do $$
declare eid uuid := gen_random_uuid();
        vid uuid := gen_random_uuid();
        oid uuid := gen_random_uuid();
begin
  -- /submit -- event, then its categories (the 059-widened policy)
  insert into events (id, title, description, start_at, source, status, featured)
  values (eid, 'anon submit path', 'A perfectly ordinary description.',
          now() + interval '9 days', 'manual', 'pending_review', false);
  insert into event_categories (event_id, category) values (eid, 'music');

  -- /venues/submit -- venue, then its areas (the other 059-widened policy)
  insert into venues (id, name, status) values (vid, 'anon submit venue', 'pending_review');
  insert into areas (venue_id, name) values (vid, 'anon submit area');

  -- /organizations/submit -- organization, then a venue and its areas
  insert into organizations (id, name, status) values (oid, 'anon submit org', 'pending_review');

  -- Town Square orb note
  insert into feedback_posts (category, body, is_private, page_path)
  values ('orb', 'anon submit path orb note', true, '/events/x');

  -- digest subscribe
  insert into subscribers (email) values ('anon-submit@example.com');

  -- embed request
  insert into embed_requests (name, email, organization, config, status, notified_at, embed_path)
  values ('Anon Requester', 'anon-embed@example.com', 'Anon Org', '{}'::jsonb, 'new', null, null);

  raise notice '  ✓ 7a. all seven public submit paths still work for anon (incl. event_categories and areas)';
end $$;

reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a0000000-0000-4000-8000-0000000000ff"}', true);
set local role authenticated;

do $$
declare eid uuid := gen_random_uuid();
        vid uuid := gen_random_uuid();
        oid uuid := gen_random_uuid();
begin
  insert into events (id, title, description, start_at, source, status, featured)
  values (eid, 'stranger submit path', 'A perfectly ordinary description.',
          now() + interval '10 days', 'manual', 'pending_review', false);
  -- Before 059 widened it, this insert landed only because of the god-mode
  -- "Authenticated full access event_categories" policy. It must now land on
  -- its own merits.
  insert into event_categories (event_id, category) values (eid, 'music');

  insert into venues (id, name, status) values (vid, 'stranger submit venue', 'pending_review');
  -- Same story for areas, via "Anon can insert areas for pending venues".
  insert into areas (venue_id, name) values (vid, 'stranger submit area');

  insert into organizations (id, name, status) values (oid, 'stranger submit org', 'pending_review');

  insert into feedback_posts (category, body, is_private, page_path)
  values ('orb', 'stranger submit path orb note', true, '/events/x');

  insert into subscribers (email) values ('stranger-submit@example.com');

  insert into embed_requests (name, email, organization, config, status, notified_at, embed_path)
  values ('Stranger Requester', 'stranger-embed@example.com', 'Stranger Org', '{}'::jsonb, 'new', null, null);

  raise notice '  ✓ 7b. all seven public submit paths still work for a SIGNED-IN visitor (the 054 bug class, re-armed by 059 on two more tables)';
end $$;

-- ── 8. The admin still has everything ────────────────────────────────────────
-- The "did we accidentally revoke something" half. EventEditPage.tsx:171-184
-- depends on the three junction inserts specifically.
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c5b809ab-8ad0-4e2e-a985-cc709726c12b"}', true);
set local role authenticated;

do $$
declare n int;
begin
  assert is_admin(), 'the admin fixture must be an admin here';

  -- reads
  assert (select count(*) from subscribers)         > 0, 'admin must read subscribers';
  assert (select count(*) from embed_requests)      > 0, 'admin must read embed_requests';
  perform 1 from email_sends         limit 1;   -- may legitimately be empty
  perform 1 from slack_notifications limit 1;
  perform 1 from event_aliases       limit 1;
  perform 1 from venue_aliases       limit 1;

  -- writes on the core entities
  update events set title = 'Admin Boundary Published Event (admin edited)'
    where id = 'a0000000-0000-4000-8000-000000000004';
  get diagnostics n = row_count;
  assert n = 1, 'admin UPDATE on events must affect the row, affected ' || n;

  update venues set name = 'Admin Boundary Test Venue (admin edited)'
    where id = 'a0000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 1, 'admin UPDATE on venues must affect the row, affected ' || n;

  update organizations set name = 'Admin Boundary Test Org (admin edited)'
    where id = 'a0000000-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  assert n = 1, 'admin UPDATE on organizations must affect the row, affected ' || n;

  -- the admin editor's three junction writes (EventEditPage.tsx:171-184)
  insert into event_venues (event_id, venue_id)
  values ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001');
  insert into event_organizations (event_id, organization_id)
  values ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002');
  insert into event_areas (event_id, area_id)
  values ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000003');

  delete from event_venues where event_id = 'a0000000-0000-4000-8000-000000000004';
  get diagnostics n = row_count;
  assert n = 1, 'admin DELETE on event_venues must affect the row (the editor deletes before re-inserting), affected ' || n;

  -- admin may set featured, which no public path may
  update events set featured = true where id = 'a0000000-0000-4000-8000-000000000004';
  get diagnostics n = row_count;
  assert n = 1, 'admin must be able to set featured, affected ' || n;

  raise notice '  ✓ 8. admin retains full read and write access, including the three junction tables';
end $$;

-- ── 8b. ...and so does the SECOND admin ───────────────────────────────────────
-- 059 seeds TWO administrators, so "the admin still has everything" has to
-- hold through both sessions or half the roster is decorative. Nothing in the
-- boundary singles out the first row -- is_admin() is a membership test -- but
-- that is the claim, and this is where it is checked rather than assumed.
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"5c30e2be-fb56-4b29-923d-71cce9722d80"}', true);
set local role authenticated;

do $$
declare n int;
begin
  assert is_admin(), 'the second seeded admin (mac@artxlove.com) must be an admin here';

  assert (select count(*) from subscribers)    > 0, 'the second admin must read subscribers (email + unsubscribe token)';
  assert (select count(*) from embed_requests) > 0, 'the second admin must read embed_requests';
  perform 1 from email_sends         limit 1;   -- may legitimately be empty
  perform 1 from slack_notifications limit 1;

  update events set title = 'Admin Boundary Published Event (second admin edited)'
    where id = 'a0000000-0000-4000-8000-000000000004';
  get diagnostics n = row_count;
  assert n = 1, 'second admin UPDATE on events must affect the row, affected ' || n;

  update venues set name = 'Admin Boundary Test Venue (second admin edited)'
    where id = 'a0000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 1, 'second admin UPDATE on venues must affect the row, affected ' || n;

  update organizations set name = 'Admin Boundary Test Org (second admin edited)'
    where id = 'a0000000-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  assert n = 1, 'second admin UPDATE on organizations must affect the row, affected ' || n;

  -- §8 deleted this junction row on its way out, so re-inserting it here is
  -- the second admin exercising EventEditPage.tsx:171-184's delete-then-insert
  -- pair rather than colliding with §8.
  insert into event_venues (event_id, venue_id)
  values ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001');
  delete from event_venues where event_id = 'a0000000-0000-4000-8000-000000000004';
  get diagnostics n = row_count;
  assert n = 1, 'second admin must be able to write AND delete junction rows, affected ' || n;

  raise notice '  ✓ 8b. the second seeded admin has exactly the same access as the first';
end $$;

-- ── 9. Moderation screening: the gate moved in TWO directions ────────────────
-- 059 section 6. The gate went from "screen only anon" to "screen everyone
-- except service_role, the admin, and direct database connections."
--
--   9a. a SIGNED-IN NON-ADMIN is now screened  -- the bug 059 fixes
--   9b. the ADMIN is not screened              -- triage must stick
--   9c. a direct DB connection is not screened -- SQL-editor triage must stick
--
-- 9b and 9c are the same requirement reached through the two doors the
-- maintainer actually uses. Without them, moving a flagged row out of
-- pending_review re-runs the matcher on the same text and shoves it straight
-- back, on exactly the rows that most need triaging.
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a0000000-0000-4000-8000-0000000000ff"}', true);
set local role authenticated;

do $$
declare eid uuid := gen_random_uuid();
begin
  insert into events (id, title, description, start_at, source, status, featured)
  values (eid, 'stranger event zzzadminboundaryterm', 'A perfectly ordinary description.',
          now() + interval '11 days', 'manual', 'pending_review', false);

  insert into feedback_posts (category, body, is_private, page_path)
  values ('orb', 'stranger note zzzadminboundaryterm', true, '/events/x');

  raise notice '  (9a inserts done as a signed-in non-admin)';
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare s text;
begin
  select status into s from events where title like '%zzzadminboundaryterm%' order by created_at desc limit 1;
  assert s = 'pending_review',
    'a SIGNED-IN NON-ADMIN event matching a flagged term must be screened -- this is the bug 059 fixes; got ' || coalesce(s, '<null>');

  select status into s from feedback_posts where body like '%zzzadminboundaryterm%' order by id desc limit 1;
  assert s = 'pending_review',
    'a SIGNED-IN NON-ADMIN feedback post matching a flagged term must be screened; got ' || coalesce(s, '<null>');

  raise notice '  ✓ 9a. a signed-in non-admin is screened (before 059 they bypassed the screen entirely)';
end $$;

-- 9b. Admin triage must stick. Both triggers fire on the admin's own triage
-- columns: trg_moderation_events on `update of title, description, tags`,
-- trg_moderation_feedback on `update of body, author_name, status`.
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c5b809ab-8ad0-4e2e-a985-cc709726c12b"}', true);
set local role authenticated;

do $$
declare eid uuid; fid bigint; s text;
begin
  select id into eid from events where title like '%zzzadminboundaryterm%' order by created_at desc limit 1;
  -- The admin decides the title is fine in context and publishes it. The text
  -- STILL matches the term list -- that is the whole point of the assertion.
  update events set title = 'zzzadminboundaryterm is fine in context', status = 'published', needs_review = false
    where id = eid;

  select id into fid from feedback_posts where body like '%zzzadminboundaryterm%' order by id desc limit 1;
  update feedback_posts set status = 'published' where id = fid;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  select status into s from events where id = eid;
  assert s = 'published',
    'admin triage must stick: an admin UPDATE to a flagged event must NOT bounce it back to pending_review; got ' || coalesce(s, '<null>');

  select status into s from feedback_posts where id = fid;
  assert s = 'published',
    'admin triage must stick: moving a flagged feedback post to published must NOT bounce it back; got ' || coalesce(s, '<null>');

  raise notice '  ✓ 9b. admin triage sticks on both events and feedback_posts (does not bounce back to pending_review)';
end $$;

-- 9c. The same requirement through the other door. Verified against
-- production 2026-08-21: in the Supabase SQL editor request.jwt.claims is
-- NULL, so moderation_request_role() is NULL and is_admin() is FALSE. A
-- service_role-only or is_admin()-only gate would re-screen SQL-editor triage
-- and undo it. 051:126-130 documents SQL-only triage as the real mechanism for
-- at least one table, so this is not a hypothetical door.
do $$
declare fid bigint; s text;
begin
  select id into fid from feedback_posts where body like '%zzzadminboundaryterm%' order by id desc limit 1;
  update feedback_posts set status = 'pending_review' where id = fid;
  update feedback_posts set status = 'published'      where id = fid;

  select status into s from feedback_posts where id = fid;
  assert s = 'published',
    'SQL-editor / direct-connection triage must stick: moderation_request_role() is NULL there and is_admin() is false, so the gate needs its null carve-out; got ' || coalesce(s, '<null>');

  raise notice '  ✓ 9c. direct database connections (psql, migrations, the SQL editor) are not screened';
end $$;

-- 9d. And anon is still screened, unchanged from 030. The half that must not
-- be lost while widening the other three.
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

do $$
begin
  insert into feedback_posts (category, body, is_private, page_path)
  values ('orb', 'anon note zzzadminboundaryterm', true, '/events/x');
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare s text;
begin
  select status into s from feedback_posts where body like '%anon note zzzadminboundaryterm%' order by id desc limit 1;
  assert s = 'pending_review',
    'anon must still be screened by the 030 trigger; got ' || coalesce(s, '<null>');

  raise notice '  ✓ 9d. anon is still screened';
end $$;

reset role;
select 'ALL ADMIN BOUNDARY RLS TESTS PASSED' as result;

rollback;
