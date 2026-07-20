-- ════════════════════════════════════════════════════════════════════════════
-- anon_submission_rls.test.sql
--
-- Regression tests for migration 042 (public Submit form RLS).
--
-- Migration 038's lockdown left `events` with no anon INSERT policy, silently
-- breaking every public event submission (first user report 2026-07-20).
-- These tests pin the contract the submit forms rely on:
--
--   1. anon CAN insert a pending_review, source='manual' event.
--   2. anon CANNOT insert a published / scraper-sourced / featured event.
--   3. anon CANNOT read back a pending_review row (which is exactly why the
--      forms mint UUIDs client-side instead of using INSERT ... RETURNING).
--
-- Self-contained: runs inside a transaction and ROLLS BACK so nothing
-- persists. Run against a local `supabase start` DB or an isolated branch:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/anon_submission_rls.test.sql
--
-- A clean run prints "ALL ANON-SUBMISSION RLS TESTS PASSED". Any failure raises.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Simulate a PostgREST anon request: role + JWT claims (the moderation
-- triggers from 030 gate on the claim, so this exercises them too).
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

-- ── 1. The public submit path works ──────────────────────────────────────────
do $$
declare
  eid uuid := gen_random_uuid();
begin
  insert into events (id, title, description, start_at, source, status, featured)
  values (eid, 'RLS smoke test event', 'A perfectly ordinary description.',
          now() + interval '7 days', 'manual', 'pending_review', false);

  -- 3. ...but the freshly inserted pending row is NOT readable back (anon
  -- SELECT is published-only). This is why the forms cannot use RETURNING.
  assert not exists (select 1 from events where id = eid),
    'anon should not see its own pending_review row';
end $$;

-- ── 2. Abuse paths stay closed ───────────────────────────────────────────────
do $$
begin
  -- anon may not self-publish
  begin
    insert into events (title, start_at, source, status)
    values ('RLS self-publish attempt', now(), 'manual', 'published');
    raise exception 'anon insert of published event should have been rejected';
  exception when insufficient_privilege then null;
  end;

  -- anon may not forge scraper attribution
  begin
    insert into events (title, start_at, source, status)
    values ('RLS forged-source attempt', now(), 'ticketmaster', 'pending_review');
    raise exception 'anon insert with scraper source should have been rejected';
  exception when insufficient_privilege then null;
  end;

  -- anon may not set featured (human-only, admin UI only)
  begin
    insert into events (title, start_at, source, status, featured)
    values ('RLS featured attempt', now(), 'manual', 'pending_review', true);
    raise exception 'anon insert with featured=true should have been rejected';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
select 'ALL ANON-SUBMISSION RLS TESTS PASSED' as result;

rollback;
