-- ════════════════════════════════════════════════════════════════════════════
-- 059_admin_boundary_rollback.sql
--
-- Reverses 059_admin_boundary.sql. Written at the same time as 059, not after
-- something goes wrong at 11pm.
--
-- ⚠️  THIS IS A STOP-THE-BLEEDING MOVE, NOT A RESTING STATE. Applying it
--     re-opens audit finding H1: every signed-in Supabase Auth user becomes a
--     full administrator again, including read of `subscribers` (email + the
--     secret unsubscribe token) and `email_sends`. The correct sequence is
--     roll back, fix forward, re-apply within the same week -- not roll back
--     and leave it.
--
-- ⚠️  IT DELIBERATELY DOES NOT RESTORE EVERYTHING. Section 5 of 059 dropped
--     three `anon` INSERT policies on the junction tables (audit finding M1).
--     Those are NOT restored here. See section 4 below for why, and for the
--     verbatim DDL if a human consciously decides otherwise.
--
-- SCOPE. 059 touched policies originally created in 001, 006, 030, 038, 041,
-- 044, 050 and 051. It did NOT touch 003 -- "Authenticated users can read
-- scraper_runs" (003:46-48) was graded safe to leave, so there is nothing in
-- 003 to restore.
--
-- DO NOT APPLY THIS MIGRATION. The maintainer applies migrations himself.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Restore the nine FOR ALL policies (001, 006, 038) ─────────────────────
-- Verbatim predicates from their source migrations: using (true) with check (true).

drop policy if exists "Admin full access events" on events;
create policy "Authenticated users have full event access"
  on events for all
  to authenticated
  using (true) with check (true);

drop policy if exists "Admin full access venues" on venues;
create policy "Authenticated users have full venue access"
  on venues for all
  to authenticated
  using (true) with check (true);

drop policy if exists "Admin full access organizations" on organizations;
create policy "Authenticated users have full organization access"
  on organizations for all
  to authenticated
  using (true) with check (true);

-- DRIFT NOTE: the LIVE policy carried roles {authenticated, supabase_admin},
-- not the {authenticated} that 006:101-104 checks in (verified against
-- production 2026-08-21). This restores the live shape rather than the file
-- shape, so a rollback lands where the database actually was. It makes no
-- practical difference -- supabase_admin is a superuser with BYPASSRLS and was
-- never gated by this policy -- but a rollback that silently changes something
-- is worse than one that does not.
drop policy if exists "Admin full access areas" on areas;
create policy "Authenticated users have full area access"
  on areas for all
  to authenticated, supabase_admin
  using (true) with check (true);

drop policy if exists "Admin full access event_venues" on event_venues;
create policy "Authenticated users have full event_venues access"
  on event_venues for all to authenticated
  using (true) with check (true);

drop policy if exists "Admin full access event_areas" on event_areas;
create policy "Authenticated users have full event_areas access"
  on event_areas for all to authenticated
  using (true) with check (true);

drop policy if exists "Admin full access event_organizations" on event_organizations;
create policy "Authenticated users have full event_organizations access"
  on event_organizations for all to authenticated
  using (true) with check (true);

drop policy if exists "Admin full access event_categories" on event_categories;
create policy "Authenticated full access event_categories"
  on event_categories for all to authenticated
  using (true) with check (true);

drop policy if exists "Admin full access feedback_posts" on feedback_posts;
create policy "Authenticated full access feedback_posts"
  on feedback_posts for all to authenticated
  using (true) with check (true);

-- ── 2. Restore the six SELECT-only policies (038, 041, 044, 050, 051) ────────

drop policy if exists "Admin can read subscribers" on subscribers;
create policy "Authenticated can read subscribers"
  on subscribers for select to authenticated
  using (true);

drop policy if exists "Admin can read email_sends" on email_sends;
create policy "Authenticated can read email_sends"
  on email_sends for select to authenticated
  using (true);

drop policy if exists "Admin can read embed_requests" on embed_requests;
create policy "Authenticated can read embed_requests"
  on embed_requests for select to authenticated
  using (true);

drop policy if exists "Admin can read slack_notifications" on slack_notifications;
create policy "Authenticated can read slack_notifications"
  on slack_notifications for select to authenticated
  using (true);

drop policy if exists "Admin can read event_aliases" on public.event_aliases;
create policy "Authenticated can read event_aliases"
  on public.event_aliases
  for select
  to authenticated
  using (true);

drop policy if exists "Admin can read venue_aliases" on public.venue_aliases;
create policy "Authenticated can read venue_aliases"
  on public.venue_aliases
  for select
  to authenticated
  using (true);

-- ── 3. Un-widen the three masked anon policies ───────────────────────────────
-- 059 section 4b widened the two INSERT policies because narrowing the god-mode
-- policies above would otherwise have 403'd both public submit paths for a
-- signed-in visitor, and widened the feedback_posts public READ because
-- narrowing "Authenticated full access feedback_posts" would otherwise have
-- returned zero Town Square rows to a signed-in non-admin. Section 1 has just
-- put the god-mode policies back, so the masking is back and all three are
-- redundant again. Narrowing them restores the exact pre-059 state.
--
-- Leaving them widened would also be harmless -- the WITH CHECK and USING
-- expressions bind either way -- but a rollback that leaves residue is how the
-- next person's `pg_policies` diff comes out dirty for no reason.
alter policy "Anon can insert areas for pending venues"            on areas            to anon;
alter policy "Anon can insert event_categories for pending events" on event_categories to anon;
alter policy "Public read published non-private feedback"          on feedback_posts   to anon;

-- ── 4. The three junction policies are NOT restored ──────────────────────────
-- 059 section 5 dropped these to close audit finding M1
-- (docs/security-audit-2026-06.md:66-74), and the drop is INDEPENDENT of the
-- admin boundary: nothing in the repository calls these policies, so nothing
-- breaks by leaving them dropped, and restoring them would re-open an
-- anonymous write to the table that decides who co-owns an event.
--
-- Restoring the anon INSERT while the god-mode `authenticated` policies of
-- section 1 are back is strictly worse than either end state on its own: it is
-- the exact pre-059 posture the June audit filed M1 against.
--
-- The `revoke insert ... from anon` is likewise left in place. Granting it
-- back would change nothing on its own -- with no policy, the insert is still
-- refused -- so the only effect would be to remove a layer for no benefit.
--
-- If a human consciously decides the capability is needed, this is the
-- verbatim DDL from 006:203-216. It is commented out on purpose: restoring it
-- must be a decision somebody makes, not a side effect of running a rollback
-- file.
--
--   grant insert on event_venues, event_organizations, event_areas to anon;
--
--   create policy "Anon can insert event_venues"
--     on event_venues for insert
--     to anon
--     with check (true);
--
--   create policy "Anon can insert event_organizations"
--     on event_organizations for insert
--     to anon
--     with check (true);
--
--   create policy "Anon can insert event_areas"
--     on event_areas for insert
--     to anon
--     with check (true);
--
-- AND THE WINDOW FOR EVEN THAT DECISION CLOSES (ADR §9.2). This rollback is
-- available only until Phase 2 (060) ships. Once a live partner scope exists,
-- restoring the anon INSERT re-opens the orphan-capture escalation of ADR §3.3
-- -- an anonymous caller linking an organization to an event that has no
-- organization links yet, and thereby owning its entire organizer set -- now
-- against a real tenant boundary rather than an unused one. After 060, these
-- three statements are not a rollback option at any hour of the night.

-- ── 5. Restore the four moderation gates (030:136-190) ───────────────────────
-- Verbatim from 030. Note what this gives back: the ORIGINAL gate skips
-- screening for every caller whose JWT role is not exactly 'anon', so a
-- signed-in visitor's submission bypasses content screening entirely. That is
-- a real bug, not a neutral state -- it is the 054/055 bug class. If the
-- rollback is being run for a reason unrelated to moderation, consider keeping
-- 059's widened bodies and reverting only sections 1-3.

create or replace function moderation_screen_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.title, NEW.description, array_to_string(NEW.tags, ' ')));
  if sev is null then return NEW; end if;
  NEW.needs_review := true;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

create or replace function moderation_screen_venue()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.name, NEW.description));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

create or replace function moderation_screen_organization()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.name, NEW.description));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

create or replace function moderation_screen_feedback()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.body, NEW.author_name));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

-- ── 6. Drop is_admin() and admin_users ───────────────────────────────────────
-- Must come LAST. Sections 1, 2 and 5 removed every remaining reference to
-- is_admin(); dropping the function while a policy still referenced it would
-- fail on the dependency.
--
-- Dropping admin_users discards the roster. That is the correct behaviour for
-- a rollback -- the roster means nothing without the boundary -- but note what
-- re-applying 059 afterwards restores and what it does not. Its seed re-runs,
-- so the two administrators it names (byronddelpinal@gmail.com and
-- mac@artxlove.com) come back automatically; anyone added by hand AFTER 059
-- was first applied does not, because the roster is data and lives only in
-- this table. Write down any later additions before running this file.
drop function if exists is_admin();
drop table if exists admin_users;

commit;
