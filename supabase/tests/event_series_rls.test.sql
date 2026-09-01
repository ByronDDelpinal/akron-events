-- ════════════════════════════════════════════════════════════════════════════
-- event_series_rls.test.sql
--
-- Regression tests for migration 069 (event_series + events.series_id RLS).
-- Same skeleton as anon_submission_rls.test.sql, same "role AND claims GUC
-- together" discipline as partner_accounts_rls.test.sql: `set local role`
-- selects the policy set, the request.jwt.claims GUC is what auth.uid() and
-- moderation_request_role() read. Setting only one tests the wrong principal.
--
-- What this file pins:
--   1. anon CAN insert a source='manual' series and an occurrence row that
--      points at it, and CANNOT read the series back (why the submit form
--      mints the uuid client-side instead of INSERT ... RETURNING).
--   2. anon CANNOT forge a scraper / partner source, insert a
--      pre-cancelled series, or stamp a foreign created_by.
--   3. anon CANNOT update or delete a series.
--   4. A signed-in NON-admin with no partner scope sees no series.
--   5. An admin (admin_users row, 059) can select / update / delete.
--   6. A partner (061 scaffold) sees a series whose occurrence is linked to
--      one of their orgs and NOT one linked to another org, and cannot
--      write either (writes are RPC-only per 061).
--
-- Self-contained: one transaction, ROLLS BACK, nothing persists. Needs
-- migrations 059 + 061 + 069 applied (the scaffold harness chain plus 069,
-- or a branch):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/event_series_rls.test.sql
--
-- A clean run prints "ALL EVENT SERIES RLS TESTS PASSED". Any failure raises.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 0. Fixtures, seeded as the connecting (owner) role ───────────────────────
--   org A  b0..69a1  partner tenant; PA is a member
--   org B  b0..69a2  partner tenant; nobody in this file is a member
--   PA     b0..69f1  member of A
--   S      b0..69f2  stranger: signed in, no memberships, not an admin
--   ADM    b0..69f3  admin added through admin_users (059 roster shape)
--   SA     b0..69c1  series whose one occurrence is hosted by org A
--   SB     b0..69c2  series whose one occurrence is hosted by org B

insert into auth.users (id, email) values
  ('b0000000-0000-4000-8000-0000000069f1', 'series-partner-a@example.com'),
  ('b0000000-0000-4000-8000-0000000069f2', 'series-stranger@example.com'),
  ('b0000000-0000-4000-8000-0000000069f3', 'series-admin@example.com')
on conflict (id) do nothing;

insert into admin_users (user_id, email, note) values
  ('b0000000-0000-4000-8000-0000000069f3', 'series-admin@example.com', 'event_series RLS test fixture')
on conflict (user_id) do nothing;

insert into organizations (id, name, status) values
  ('b0000000-0000-4000-8000-0000000069a1', 'Series Org Alpha', 'published'),
  ('b0000000-0000-4000-8000-0000000069a2', 'Series Org Bravo', 'published');

insert into partner_orgs (organization_id, slug, active, auto_publish) values
  ('b0000000-0000-4000-8000-0000000069a1', 'series-org-alpha', true, true),
  ('b0000000-0000-4000-8000-0000000069a2', 'series-org-bravo', true, true);

insert into partner_memberships (user_id, organization_id, email) values
  ('b0000000-0000-4000-8000-0000000069f1', 'b0000000-0000-4000-8000-0000000069a1', 'series-partner-a@example.com');

insert into event_series (id, rrule, dtstart_date, start_time, duration_min, source) values
  ('b0000000-0000-4000-8000-0000000069c1', 'FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-10-01', '19:00', 120, 'manual'),
  ('b0000000-0000-4000-8000-0000000069c2', 'FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-10-01', '19:00', 120, 'manual');

insert into events (id, title, description, start_at, source, source_id, status, featured, series_id) values
  ('b0000000-0000-4000-8000-0000000069e1', 'Series Alpha Occurrence', 'A perfectly ordinary description.',
   '2026-10-01T23:00:00Z', 'manual', 'series:b0000000-0000-4000-8000-0000000069c1:2026-10-01',
   'published', false, 'b0000000-0000-4000-8000-0000000069c1'),
  ('b0000000-0000-4000-8000-0000000069e2', 'Series Bravo Occurrence', 'A perfectly ordinary description.',
   '2026-10-01T23:00:00Z', 'manual', 'series:b0000000-0000-4000-8000-0000000069c2:2026-10-01',
   'published', false, 'b0000000-0000-4000-8000-0000000069c2');

insert into event_organizations (event_id, organization_id) values
  ('b0000000-0000-4000-8000-0000000069e1', 'b0000000-0000-4000-8000-0000000069a1'),
  ('b0000000-0000-4000-8000-0000000069e2', 'b0000000-0000-4000-8000-0000000069a2');

-- Seed sanity: the CHECK on rrule must reject a non-organizer shape and the
-- tz pin must hold, or the RLS assertions below test a different table.
do $$
begin
  begin
    insert into event_series (rrule, dtstart_date, start_time) values ('FREQ=DAILY;COUNT=3', '2026-10-01', '19:00');
    raise exception 'rrule CHECK should reject FREQ=DAILY';
  exception when check_violation then null;
  end;
  begin
    insert into event_series (rrule, dtstart_date, start_time, tz) values ('FREQ=WEEKLY;BYDAY=TH;COUNT=3', '2026-10-01', '19:00', 'UTC');
    raise exception 'tz CHECK should reject anything but America/New_York';
  exception when check_violation then null;
  end;
end $$;

-- ── 1. anon: the submit path works, and RETURNING would not ──────────────────
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

do $$
declare
  sid uuid := gen_random_uuid();
  eid uuid := gen_random_uuid();
begin
  insert into event_series (id, rrule, dtstart_date, start_time, duration_min, source)
  values (sid, 'FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-10-01', '19:00', 120, 'manual');

  insert into events (id, title, description, start_at, source, source_id, status, featured, series_id)
  values (eid, 'RLS series submit test', 'A perfectly ordinary description.',
          '2026-10-01T23:00:00Z', 'manual', 'series:' || sid::text || ':2026-10-01',
          'pending_review', false, sid);

  -- The freshly inserted series is NOT readable back. Either the missing
  -- SELECT grant or the missing SELECT policy refuses it; both are correct.
  begin
    assert not exists (select 1 from event_series where id = sid),
      'anon should not see the series it just inserted';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── 2. anon: abuse paths stay closed ─────────────────────────────────────────
do $$
begin
  -- anon may not forge partner / scraper attribution
  begin
    insert into event_series (rrule, dtstart_date, start_time, source)
    values ('FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-10-01', '19:00', 'partner:x');
    raise exception 'anon insert with source partner:x should have been rejected';
  exception when insufficient_privilege then null;
  end;

  -- anon may not insert a pre-cancelled series
  begin
    insert into event_series (rrule, dtstart_date, start_time, source, cancelled_at)
    values ('FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-10-01', '19:00', 'manual', now());
    raise exception 'anon insert with cancelled_at set should have been rejected';
  exception when insufficient_privilege then null;
  end;

  -- anon may not stamp somebody else's identity as created_by
  begin
    insert into event_series (rrule, dtstart_date, start_time, source, created_by)
    values ('FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-10-01', '19:00', 'manual', 'b0000000-0000-4000-8000-0000000069f3');
    raise exception 'anon insert with a foreign created_by should have been rejected';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── 3. anon: no update, no delete ────────────────────────────────────────────
-- 069 revokes UPDATE/DELETE from anon outright, so these raise; a regime
-- that only relied on the missing policy would return 0 rows. Both are a
-- refusal, so both are accepted here.
do $$
declare
  n int;
begin
  begin
    update event_series set cancelled_at = now() where id = 'b0000000-0000-4000-8000-0000000069c1';
    get diagnostics n = row_count;
    assert n = 0, 'anon update of a series should touch 0 rows';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from event_series where id = 'b0000000-0000-4000-8000-0000000069c1';
    get diagnostics n = row_count;
    assert n = 0, 'anon delete of a series should touch 0 rows';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- ── 4. Signed-in stranger: no scope, not an admin, sees nothing ──────────────
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-0000000069f2"}', true);
set local role authenticated;

do $$
begin
  assert (select count(*) from event_series) = 0,
    'a signed-in non-admin with no partner scope must see no series';
end $$;

reset role;

-- ── 5. Admin: full access ────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-0000000069f3"}', true);
set local role authenticated;

do $$
declare
  n int;
begin
  assert is_admin(), 'fixture admin must be an admin or block 5 is meaningless';
  assert (select count(*) from event_series where id in (
      'b0000000-0000-4000-8000-0000000069c1', 'b0000000-0000-4000-8000-0000000069c2')) = 2,
    'admin should see both fixture series';

  update event_series set duration_min = 90 where id = 'b0000000-0000-4000-8000-0000000069c1';
  get diagnostics n = row_count;
  assert n = 1, 'admin update should touch the row';
  -- (updated_at is not compared to created_at: now() is frozen for the whole
  -- transaction, so the 001 trigger stamps the same instant the row was
  -- inserted with.)
  assert (select duration_min = 90 from event_series where id = 'b0000000-0000-4000-8000-0000000069c1'),
    'admin update should be visible';

  delete from event_series where id = 'b0000000-0000-4000-8000-0000000069c2';
  get diagnostics n = row_count;
  assert n = 1, 'admin delete should touch the row';
  -- SET NULL, not CASCADE: the occurrence survives, only the link is gone.
  assert (select series_id is null from events where id = 'b0000000-0000-4000-8000-0000000069e2'),
    'deleting a series must null the occurrence link, not delete the event';
end $$;

reset role;

-- Re-seed SB (block 5 deleted it) so block 6 has its negative case.
insert into event_series (id, rrule, dtstart_date, start_time, duration_min, source) values
  ('b0000000-0000-4000-8000-0000000069c2', 'FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-10-01', '19:00', 120, 'manual');
update events set series_id = 'b0000000-0000-4000-8000-0000000069c2'
 where id = 'b0000000-0000-4000-8000-0000000069e2';

-- ── 6. Partner: any-of read over own orgs, no writes ─────────────────────────
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b0000000-0000-4000-8000-0000000069f1"}', true);
set local role authenticated;

do $$
declare
  n int;
begin
  assert 'b0000000-0000-4000-8000-0000000069a1' = any (partner_scope()),
    'PA must be in scope for org A or block 6 is meaningless';
  assert exists (select 1 from event_series where id = 'b0000000-0000-4000-8000-0000000069c1'),
    'partner should see the series whose occurrence is hosted by their org';
  assert not exists (select 1 from event_series where id = 'b0000000-0000-4000-8000-0000000069c2'),
    'partner must NOT see a series hosted only by another org';

  -- No partner write policy exists (061 rule): updates and deletes match 0
  -- rows even on the series the partner can read.
  update event_series set cancelled_at = now() where id = 'b0000000-0000-4000-8000-0000000069c1';
  get diagnostics n = row_count;
  assert n = 0, 'partner update of a series should touch 0 rows';
  delete from event_series where id = 'b0000000-0000-4000-8000-0000000069c1';
  get diagnostics n = row_count;
  assert n = 0, 'partner delete of a series should touch 0 rows';
end $$;

reset role;

do $$ begin raise notice 'ALL EVENT SERIES RLS TESTS PASSED'; end $$;

rollback;
