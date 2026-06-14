-- ════════════════════════════════════════════════════════════════════════════
-- 038_lock_down_anon_rls.sql
--
-- SECURITY FIX (audit finding C-1): close the wide-open anon RLS surface.
--
-- Background: the admin UI historically used the public anon key with no real
-- auth (a client-side password), so a string of migrations (007, 010, 031,
-- 032, 033, 036, 017, 013) granted the *anon* role destructive / PII-exposing
-- access just to make that password-only admin work. Because the anon key
-- ships in the browser bundle, every one of those grants was reachable by any
-- visitor via the PostgREST API — full read/write/delete over the dataset plus
-- the entire subscriber list (email + token).
--
-- This migration moves the admin boundary back to the `authenticated` role
-- (real Supabase Auth login — see src/pages/admin/AdminLayout.tsx) and revokes
-- the over-broad anon grants. The "full access to authenticated" policies from
-- 001/006 already exist and become the admin boundary; here we add the few that
-- were missing (event_categories, feedback_posts, subscribers, email_sends).
--
-- PUBLIC paths that MUST keep working are preserved:
--   • anon SELECT of published events / venues / orgs / areas / their categories
--   • anon INSERT of pending_review submissions (event submit, venue/org signup)
--   • anon INSERT of event_categories for a pending submission (scoped below)
--   • anon INSERT + read of published feedback, anon voting
--   • anon INSERT (subscribe)
-- Scrapers/admin scripts use the service_role key, which bypasses RLS entirely
-- and is unaffected by everything here.
--
-- ⚠️  DEPLOY PREREQUISITE: this is only safe once (a) a Supabase Auth admin user
--     exists and (b) public email sign-ups are DISABLED in the Supabase Auth
--     settings — otherwise anyone could self-register to obtain the
--     `authenticated` role and inherit admin access. See AUDIT notes.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Revoke anon UPDATE/DELETE on the core entity tables (was migration 007) ─
-- Admin edits now run as `authenticated`, covered by the "full access" policies
-- created in 001 (events/venues/organizations) and 006 (areas + junctions).
drop policy if exists "Anon can update events"        on events;
drop policy if exists "Anon can delete events"        on events;
drop policy if exists "Anon can update venues"         on venues;
drop policy if exists "Anon can delete venues"         on venues;
drop policy if exists "Anon can update organizations"  on organizations;
drop policy if exists "Anon can delete organizations"  on organizations;
drop policy if exists "Anon can update areas"          on areas;
drop policy if exists "Anon can delete areas"          on areas;
drop policy if exists "Anon can delete event_venues"         on event_venues;
drop policy if exists "Anon can delete event_organizations"  on event_organizations;
drop policy if exists "Anon can delete event_areas"          on event_areas;

-- ── 2. Revoke anon read of ALL events incl. unpublished (was migration 031) ────
-- The public "read published events" policy from 001 remains. Admin reads
-- pending/cancelled rows via the authenticated "full access" policy from 001.
drop policy if exists "Anon can read all events" on events;

-- ── 3. event_categories: scope anon INSERT, revoke anon DELETE + read-all ──────
-- (was migrations 032 / 033 / 036)

-- Helper: does this event exist and is it still pending_review? SECURITY DEFINER
-- so it bypasses RLS — a plain subquery in a WITH CHECK would be evaluated under
-- the anon role, which (correctly) can't see its own freshly-inserted
-- pending_review event, and the check would always fail.
create or replace function event_is_pending_review(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from events e
    where e.id = p_event_id and e.status = 'pending_review'
  )
$$;
revoke all on function event_is_pending_review(uuid) from public;
grant execute on function event_is_pending_review(uuid) to anon, authenticated;

-- Replace the unconditional anon INSERT (032) with one scoped to the submitter's
-- own pending_review event. Keeps the public Submit form working (SubmitPage.tsx)
-- while preventing anon from attaching categories to already-published events.
drop policy if exists "Anon can insert event_categories" on event_categories;
create policy "Anon can insert event_categories for pending events"
  on event_categories for insert to anon
  with check (event_is_pending_review(event_id));

-- Remove anon DELETE (033) and anon read-all (036). Public still reads
-- categories of published events via the 029 policy; admin reads/edits all via
-- the authenticated policy added below.
drop policy if exists "Anon can delete event_categories"    on event_categories;
drop policy if exists "Anon can read all event_categories"  on event_categories;

create policy "Authenticated full access event_categories"
  on event_categories for all to authenticated
  using (true) with check (true);

-- ── 4. subscribers / email_sends: revoke anon read, grant authenticated read ───
-- (was migration 010). subscribers holds email + the secret unsubscribe token;
-- email_sends is the delivery log. Only the admin (authenticated) dashboard
-- reads these now; the digest Edge Functions use service_role (bypass RLS).
-- anon INSERT on subscribers (009 "Anon can subscribe") is intentionally kept.
drop policy if exists "Anon can read subscribers"  on subscribers;
drop policy if exists "Anon can read email_sends"  on email_sends;

create policy "Authenticated can read subscribers"
  on subscribers for select to authenticated
  using (true);

create policy "Authenticated can read email_sends"
  on email_sends for select to authenticated
  using (true);

-- ── 5. feedback_posts: enforce privacy in RLS, revoke anon UPDATE/DELETE ───────

-- Public read now also excludes is_private rows (was 030 — only checked status,
-- so "private" feedback was readable via the API). Replaces the 030 policy.
drop policy if exists "Public read feedback_posts" on feedback_posts;
create policy "Public read published non-private feedback"
  on feedback_posts for select to anon
  using (status = 'published' and is_private = false);

-- Admin (authenticated) reads all feedback incl. private, resolves, deletes.
drop policy if exists "Allow update feedback posts"   on feedback_posts;  -- anon UPDATE (017)
drop policy if exists "Public delete feedback_posts"  on feedback_posts;  -- anon DELETE (013)

create policy "Authenticated full access feedback_posts"
  on feedback_posts for all to authenticated
  using (true) with check (true);

-- Note: anon INSERT on feedback_posts (012) and the anon vote policies on
-- feedback_votes (012) are intentionally left in place — they back the public
-- Town Square submit + upvote features. Tightening vote integrity is tracked
-- separately (audit H-tier), not part of this lock-down.

commit;
