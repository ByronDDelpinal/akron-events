-- ════════════════════════════════════════════════════════════════════════════
-- org_opt_out_gates.test.sql
--
-- Behavioral tests for migration 066 (org opt-out triggers + reconcile).
-- Self-contained: seeds its own orgs/events/links, runs assertions, and ROLLS
-- BACK so nothing persists. Modeled on content_moderation.test.sql. Run against
-- a local `supabase start` DB or an isolated branch with 066 applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/org_opt_out_gates.test.sql
--
-- A clean run prints "ALL ORG OPT-OUT GATE TESTS PASSED". Any failure raises.
--
-- NOTE ON THE LIVE ENFORCE TRIGGER. trg_enforce_manual_overrides_events is a
-- LIVE, unversioned trigger that does NOT exist in a from-migrations local DB,
-- so this file cannot exercise "opt-out beats enforce" against the real thing.
-- What it CAN pin portably is the re-publish backstop: a plain admin UPDATE to
-- status='published' on an all-opted-out event is re-cancelled by
-- trg_opt_out_events_cancel firing last (section 4). The developer's container
-- validation additionally stood up a dummy enforce trigger named to sort BEFORE
-- trg_opt_out_* and proved the opt-out cancel still wins.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 0. Trigger ordering: no VERSIONED trigger on events/organizations may sort
--       after trg_opt_out_* (the correctness of "opt-out fires last"). This
--       catches a future migration that adds a later-sorting trigger; the live
--       enforce trigger is checked by the DEPLOY PREREQ in the 066 header.
do $$
declare bad text;
begin
  select string_agg(tgrelid::regclass || '.' || tgname, ', ')
    into bad
    from pg_trigger
   where not tgisinternal
     and tgrelid in ('events'::regclass, 'organizations'::regclass)
     and tgname > 'trg_opt_out_'
     and tgname not like 'trg_opt_out_%'
     and tgname !~ '^RI_';
  assert bad is null,
    '0 a trigger sorts AFTER trg_opt_out_* and could re-publish a cancelled row: ' || coalesce(bad,'');
  raise notice '  ok 0 no versioned trigger sorts after trg_opt_out_*';
end $$;

-- ── 1. Zero active opt-outs: the early-out leaves normal writes untouched ────
do $$
declare oid uuid; eid uuid; s text;
begin
  insert into organizations (name, status) values ('Gate Normal Org','published') returning id into oid;
  select status into s from organizations where id=oid;
  assert s='published', '1a org untouched, got '||s;
  insert into events (title, start_at, source, status, featured)
    values ('Gate Normal Event', now(), 'manual','published', false) returning id into eid;
  insert into event_organizations (event_id, organization_id) values (eid, oid);
  select status into s from events where id=eid;
  assert s='published', '1b event untouched, got '||s;
  update events set status='published' where id=eid;
  select status into s from events where id=eid;
  assert s='published', '1c event update untouched, got '||s;
  raise notice '  ok 1 zero-opt-out early-out';
end $$;

-- ── 2. Co-host unlink: opted-out link dropped, event stays live ─────────────
do $$
declare optA uuid; cleanB uuid; eid uuid; s text; nl int;
begin
  insert into organizations (name, status) values ('Gate OptA','published') returning id into optA;
  insert into organizations (name, status) values ('Gate CleanB','published') returning id into cleanB;
  insert into events (title, start_at, source, status, featured)
    values ('Gate Cohost', now(),'manual','published', false) returning id into eid;
  insert into event_organizations (event_id, organization_id) values (eid, cleanB);
  insert into org_opt_outs (name_key, display_name) values (org_name_match_key('Gate OptA'),'Gate OptA');
  insert into event_organizations (event_id, organization_id) values (eid, optA);
  select status into s from events where id=eid;
  assert s='published', '2a event stays live under clean co-host, got '||s;
  select count(*) into nl from event_organizations where event_id=eid;
  assert nl=1, '2b only clean link remains, got '||nl;
  assert not exists(select 1 from event_organizations where event_id=eid and organization_id=optA), '2c opted-out link dropped';
  raise notice '  ok 2 co-host unlink keeps event live';
end $$;

-- ── 3. All-opted-out event cancelled via the LINK path ──────────────────────
do $$
declare optA uuid; optB uuid; eid uuid; s text;
begin
  insert into organizations (name, status) values ('Gate OnlyA','published') returning id into optA;
  insert into organizations (name, status) values ('Gate OnlyB','published') returning id into optB;
  insert into events (title, start_at, source, status, featured)
    values ('Gate AllOptLink', now(),'manual','published', false) returning id into eid;
  insert into org_opt_outs (name_key, display_name) values
    (org_name_match_key('Gate OnlyA'),'Gate OnlyA'), (org_name_match_key('Gate OnlyB'),'Gate OnlyB');
  insert into event_organizations (event_id, organization_id) values (eid, optA);
  select status into s from events where id=eid;
  assert s='cancelled', '3 event cancelled via link path, got '||s;
  raise notice '  ok 3 all-opted-out cancelled via link path';
end $$;

-- ── 4. All-opted-out event cancelled via RE-PUBLISH path (trigger c wins) ───
do $$
declare optA uuid; optB uuid; eid uuid; s text;
begin
  insert into organizations (name, status) values ('Gate RepA','published') returning id into optA;
  insert into organizations (name, status) values ('Gate RepB','published') returning id into optB;
  insert into events (title, start_at, source, status, featured)
    values ('Gate Repub', now(),'manual','published', false) returning id into eid;
  -- links persisted BEFORE the opt-out exists (early-out lets them in)
  insert into event_organizations (event_id, organization_id) values (eid, optA);
  insert into event_organizations (event_id, organization_id) values (eid, optB);
  -- activate both at once so reconcile sees every host opted out
  insert into org_opt_outs (name_key, display_name) values
    (org_name_match_key('Gate RepA'),'Gate RepA'), (org_name_match_key('Gate RepB'),'Gate RepB');
  select status into s from events where id=eid;
  assert s='cancelled', '4a reconcile cancelled all-opted-out event, got '||s;
  -- admin re-publishes: trigger (c) fires last on UPDATE and re-cancels
  update events set status='published' where id=eid;
  select status into s from events where id=eid;
  assert s='cancelled', '4b re-publish re-cancelled by trg_opt_out_events_cancel, got '||s;
  raise notice '  ok 4 re-publish path re-cancels';
end $$;

-- ── 5. Re-mint under the same folded name is born cancelled ─────────────────
do $$
declare s text;
begin
  insert into org_opt_outs (name_key, display_name) values (org_name_match_key('The Gate Bad Org'),'The Gate Bad Org');
  insert into organizations (name, status) values ('  gate   bad org ', 'published') returning status into s;
  assert s='cancelled', '5a whitespace/The variant born cancelled, got '||s;
  insert into organizations (name, status) values ('THE GATE BAD ORG','published') returning status into s;
  assert s='cancelled', '5b The/case variant born cancelled, got '||s;
  raise notice '  ok 5 re-mint born cancelled';
end $$;

-- ── 6. active=false stops enforcement; a simulated re-scrape recovers ───────
do $$
declare ooid uuid; oid uuid; eid uuid; s text;
begin
  insert into org_opt_outs (name_key, display_name, active)
    values (org_name_match_key('Gate Reversible'),'Gate Reversible', true) returning id into ooid;
  insert into organizations (name, status) values ('Gate Reversible','published') returning id, status into oid, s;
  assert s='cancelled', '6a org cancelled while active, got '||s;
  insert into events (title, start_at, source, status, featured)
    values ('Gate Rev Event', now(),'manual','published', false) returning id into eid;
  insert into event_organizations (event_id, organization_id) values (eid, oid);
  select status into s from events where id=eid;
  assert s='cancelled', '6b event cancelled (only host opted out), got '||s;
  update org_opt_outs set active=false where id=ooid;
  update organizations set status='published' where id=oid;
  select status into s from organizations where id=oid;
  assert s='published', '6c org republished after active=false, got '||s;
  update events set status='published' where id=eid;
  select status into s from events where id=eid;
  assert s='published', '6d event republished after active=false, got '||s;
  raise notice '  ok 6 active=false stops enforcement + re-scrape recovers';
end $$;

-- ── 7. Reconcile: cleans pre-existing co-host links AND cancels all-opted-out ─
do $$
declare optA uuid; cleanB uuid; optC uuid; e_co uuid; e_all uuid; s text; nl int;
begin
  insert into organizations (name, status) values ('Gate R7 A','published') returning id into optA;
  insert into organizations (name, status) values ('Gate R7 B','published') returning id into cleanB;
  insert into organizations (name, status) values ('Gate R7 C','published') returning id into optC;
  insert into events (title, start_at, source, status, featured)
    values ('Gate R7 Cohost', now(),'manual','published', false) returning id into e_co;
  insert into event_organizations (event_id, organization_id) values (e_co, optA), (e_co, cleanB);
  insert into events (title, start_at, source, status, featured)
    values ('Gate R7 AllOpt', now(),'manual','published', false) returning id into e_all;
  insert into event_organizations (event_id, organization_id) values (e_all, optA), (e_all, optC);
  insert into org_opt_outs (name_key, display_name) values
    (org_name_match_key('Gate R7 A'),'Gate R7 A'), (org_name_match_key('Gate R7 C'),'Gate R7 C');
  select status into s from events where id=e_co;
  assert s='published', '7a co-host event stays live, got '||s;
  select count(*) into nl from event_organizations where event_id=e_co;
  assert nl=1, '7b only clean link remains on co-host event, got '||nl;
  assert not exists(select 1 from event_organizations where event_id=e_co and organization_id=optA), '7c optA link deleted';
  select status into s from events where id=e_all;
  assert s='cancelled', '7d all-opted-out event cancelled, got '||s;
  assert (select status from organizations where id=optA)='cancelled', '7e optA org cancelled';
  assert (select status from organizations where id=cleanB)='published', '7f cleanB org untouched';
  raise notice '  ok 7 reconcile cleans co-host links + cancels all-opted-out';
end $$;

-- ── 8. Match by captured organization_id even when the name does not match ──
do $$
declare oid uuid; s text;
begin
  insert into organizations (name, status) values ('Gate Renamed Inc','published') returning id into oid;
  insert into org_opt_outs (name_key, display_name, organization_id)
    values (org_name_match_key('A Totally Different Label'),'A Totally Different Label', oid);
  assert is_org_opted_out(oid), '8a matches by captured organization_id';
  update organizations set status='published' where id=oid;
  select status into s from organizations where id=oid;
  assert s='cancelled', '8b org cancelled via organization_id match, got '||s;
  raise notice '  ok 8 organization_id match path';
end $$;

-- ── 9. CHECK constraint keeps name_key equal to the fold of display_name ────
do $$
declare ok boolean := false;
begin
  begin
    insert into org_opt_outs (name_key, display_name) values ('wrongkey','Gate Some Org');
  exception when check_violation then ok := true;
  end;
  assert ok, '9 CHECK rejects name_key <> fold(display_name)';
  raise notice '  ok 9 CHECK constraint enforced';
end $$;

-- == 10. DEFECT 1: single-host opted-out event via the LINK path stays cancelled
--        across an admin/enforce re-publish (the case gate 4 missed). The guard
--        must KEEP the opted-out link so the event has a host for the backstop.
do $$
declare optX uuid; eid uuid; s text; nl int;
begin
  insert into organizations (name, status) values ('Gate D1 X','published') returning id into optX;
  insert into events (title, start_at, source, status, featured)
    values ('Gate D1 Event', now(),'manual','published', false) returning id into eid;
  insert into org_opt_outs (name_key, display_name) values (org_name_match_key('Gate D1 X'),'Gate D1 X');
  -- LINK path (not reconcile): opted-out org is the only host
  insert into event_organizations (event_id, organization_id) values (eid, optX);
  select status into s from events where id=eid;
  assert s='cancelled', '10a single-host opted-out event cancelled via link path, got '||s;
  select count(*) into nl from event_organizations where event_id=eid;
  assert nl=1, '10b opted-out link KEPT (event must not be hostless), got '||nl;
  -- admin/enforce re-publish must be re-forced to cancelled by the events backstop
  update events set status='published' where id=eid;
  select status into s from events where id=eid;
  assert s='cancelled', '10c re-publish of single-host opted-out event re-cancelled, got '||s;
  raise notice '  ok 10 single-host link-path event re-cancels on re-publish (defect 1)';
end $$;

-- == 11. DEFECT 2: opted-out host linked FIRST, clean co-host SECOND. The
--        AFTER-insert reconcile must unlink the opted-out org once a live
--        co-host exists, regardless of link order (Decision B holds).
do $$
declare optA uuid; cleanB uuid; eid uuid; nl int;
begin
  insert into organizations (name, status) values ('Gate D2 OptA','published') returning id into optA;
  insert into organizations (name, status) values ('Gate D2 CleanB','published') returning id into cleanB;
  insert into events (title, start_at, source, status, featured)
    values ('Gate D2 Event', now(),'manual','published', false) returning id into eid;
  insert into org_opt_outs (name_key, display_name) values (org_name_match_key('Gate D2 OptA'),'Gate D2 OptA');
  -- opted-out host FIRST: event cancelled, link kept (defect 1 behavior)
  insert into event_organizations (event_id, organization_id) values (eid, optA);
  -- clean co-host SECOND: AFTER reconcile must drop the opted-out link
  insert into event_organizations (event_id, organization_id) values (eid, cleanB);
  assert not exists(select 1 from event_organizations where event_id=eid and organization_id=optA),
    '11a opted-out link removed once a clean co-host exists (order-proof Decision B)';
  assert exists(select 1 from event_organizations where event_id=eid and organization_id=cleanB),
    '11b clean co-host link retained';
  select count(*) into nl from event_organizations where event_id=eid;
  assert nl=1, '11c exactly the clean link remains, got '||nl;
  -- Event stays cancelled (documented self-heal on next scrape); not asserted as published.
  raise notice '  ok 11 insertion-order-proof Decision B unlink (defect 2)';
end $$;

rollback;

\echo 'ALL ORG OPT-OUT GATE TESTS PASSED'
