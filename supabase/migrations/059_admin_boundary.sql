-- ════════════════════════════════════════════════════════════════════════════
-- 059_admin_boundary.sql
--
-- SECURITY FIX: introduce a real admin boundary. Closes audit findings H1 and
-- M1 in docs/security-audit-2026-06.md.
--
-- WHAT THIS IS. Migration 038 moved the admin boundary off `anon` and onto the
-- `authenticated` role, and reused the "full access to authenticated" policies
-- already sitting in 001 and 006 as the admin surface. That was the right move
-- at the time, but it left the project with exactly one authorization
-- dimension: "is there a session." Sixteen policies grant `authenticated`
-- unscoped access; nine of them are FOR ALL god-mode. Creating ANY new
-- Supabase Auth user today produces another full administrator, including
-- read of `subscribers` (email + the secret unsubscribe token) and
-- `email_sends`. The only control is a dashboard checkbox, which is exactly
-- finding H1 (docs/security-audit-2026-06.md:18).
--
-- This migration replaces the "is there a session" test with an explicit
-- membership test, `is_admin()`, backed by an RLS-protected `admin_users`
-- table. Fifteen policies are rewritten against it. The sixteenth
-- (`scraper_runs`, 003:46-48) is deliberately left alone: 004:14-21 already
-- grants the identical read to `anon` and /technical renders scraper_health
-- publicly, so narrowing it buys nothing and risks the admin Scraper Runs
-- page.
--
-- It also closes finding M1 (docs/security-audit-2026-06.md:66-74) by dropping
-- the three `anon` INSERT policies on the junction tables. 038 dropped their
-- DELETE twins (038:48-50) and left the INSERTs standing, because the god-mode
-- `authenticated` policies made the asymmetry invisible. See section 5.
--
-- The debt this pays is already visible in the migration history: 051:126-130
-- declined to add an `authenticated` UPDATE policy at all because "038 makes
-- ANY authenticated user an admin," and 055 had to drop two policies 052 had
-- just added for the same reason. This is the third bill for the same debt.
--
-- ⚠️  LOCKOUT WARNING. `admin_users` must contain both administrators'
--     user_ids BEFORE any policy references is_admin(), or this migration
--     locks them out of /admin the instant it commits. The seed is in section
--     2 below, inside the same begin;/commit; as everything else, for exactly
--     that reason. Do not move it to a follow-up script and do not reorder it
--     after section 3.
--
-- ⚠️  DEPLOY PREREQUISITE. Before applying, dump the live policy set and diff
--     it against what this migration drops BY NAME:
--
--       select schemaname, tablename, policyname, roles, cmd, qual, with_check
--         from pg_policies where schemaname = 'public'
--        order by tablename, policyname;
--
--     A policy created outside the migration history (the database contains at
--     least one such object already -- source_priority(src), in
--     database.types.ts:925 and in no migration) would survive this migration
--     completely untouched. Verified against production on 2026-08-21: the
--     live set matches, with one drift noted in section 3 under `areas`.
--
--     Check that dump BEFORE applying for a second reason: the three
--     `alter policy ... to anon, authenticated` statements in section 4b have
--     no `IF EXISTS` form -- PostgreSQL does not offer one. If production has
--     drifted and any of those three target policies is missing, 059 aborts
--     the whole transaction on that line. That is the CORRECT failure (a
--     silently-skipped widen is how a public submit path 403s in production),
--     but it is a failure you want to find in the dump, not at apply time.
--
--     EYEBALL THE SEED BEFORE APPLYING. Section 2 seeds TWO administrators --
--     the complete admin roster as of 2026-08-21:
--
--       byronddelpinal@gmail.com   c5b809ab-8ad0-4e2e-a985-cc709726c12b
--       mac@artxlove.com           5c30e2be-fb56-4b29-923d-71cce9722d80
--
--     Check both rows against `select id, email from auth.users` first. Both
--     uuids are FK-checked against auth.users, so a wrong one aborts the whole
--     transaction rather than committing half a roster -- which is the correct
--     failure, and another one you want to find in the dump rather than at
--     apply time. Anyone NOT on that list is, after this commits, a signed-in
--     stranger with exactly the anon surface and nothing more.
--
--     Also confirm public email sign-up is DISABLED in the Supabase Auth
--     settings and enumerate auth.users. This migration makes an unexpected
--     auth user harmless rather than an administrator, but an unexpected user
--     is still an incident.
--
--     DO NOT APPLY DURING THE NIGHTLY SCRAPE WINDOW. The nightly scrape runs
--     from GitHub Actions on `0 2 * * *` UTC
--     (.github/workflows/nightly-scrape.yml:158), and its upserts hold row
--     locks on `events` and `venues`. This migration takes ACCESS EXCLUSIVE on
--     fifteen tables in one transaction, so overlapping the two means 059
--     blocks on the scraper while already holding ACCESS EXCLUSIVE on every
--     table it has processed -- a site-wide stall, not a slow migration. Apply
--     well clear of 02:00 UTC.
--
-- ROLLBACK: 059_admin_boundary_rollback.sql, written at the same time as this
-- file. Read its header before using it -- it deliberately does NOT restore
-- the section 5 drops.
--
-- DO NOT APPLY THIS MIGRATION. The maintainer applies migrations himself.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Fail fast instead of stalling the site: every statement below waits at most
-- 5s for its lock rather than queueing behind a live writer while already
-- holding ACCESS EXCLUSIVE on the tables above it.
set local lock_timeout = '5s';

-- ── 1. The admin roster ──────────────────────────────────────────────────────
-- No policies of any kind, and the table grants are revoked outright: anon and
-- authenticated get zero rows and cannot reach the table through PostgREST at
-- all. Mirrors the shape 030:40-44 uses for moderation_terms.
create table if not exists admin_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  note       text,
  created_at timestamptz not null default now()
);

alter table admin_users enable row level security;

-- Deliberately NOT forced. is_admin() below is SECURITY DEFINER and owned by
-- this table's owner, and a table owner is exempt from its own RLS unless
-- FORCE is set. That exemption is the only thing stopping the boundary from
-- recursing into itself: a policy on `events` calls is_admin(), which reads
-- admin_users, which -- if it needed a policy -- would have to consult
-- admin_users. `alter table admin_users force row level security` would not
-- deadlock anything -- it would SILENTLY LOCK EVERYONE OUT. With FORCE set and
-- no policy on the table, is_admin()'s `select exists (...)` returns false for
-- every caller including the definer, so every policy in section 4 evaluates
-- to false and the admin UI goes dark with no error anywhere. QA measured
-- exactly this. Do not add it.
revoke all on admin_users from anon, authenticated;

-- ── 2. SEED FIRST -- read the lockout warning in the header ──────────────────
-- The complete admin roster as of 2026-08-21. Both principals are full
-- administrators and both go in HERE, in one seed, before section 4 creates
-- the first policy that references is_admin():
--
--   Byron Delpinal  byronddelpinal@gmail.com  c5b809ab-8ad0-4e2e-a985-cc709726c12b
--   Mac             mac@artxlove.com          5c30e2be-fb56-4b29-923d-71cce9722d80
--
-- Both accounts are full administrators under 038 today, and both stay full
-- administrators after this commits. What changes is that the grant is now an
-- explicit row rather than a side effect of having a session: a THIRD auth
-- user, expected or not, is a signed-in stranger with exactly the anon surface
-- and nothing more.
--
-- The literal VALUES list is deliberate. user_id is FK'd to auth.users(id), so
-- a mistyped uuid raises foreign_key_violation and aborts the whole
-- transaction. The tempting alternative -- `insert ... select id, email from
-- auth.users where email in (...)` -- fails the other way: a typo there
-- matches zero rows, commits a short roster, and locks out whoever was missed,
-- silently. Keep the literals.
--
-- THE ROSTER IS DATA, NOT SCHEMA. This seed is only the starting roster;
-- nothing downstream assumes it stays at two. Adding or removing an admin
-- later is a statement against the live database, NOT a migration:
--
--   insert into admin_users (user_id, email, note)
--   values ('<auth.users.id>', '<email>', '<who and why>');
--
--   delete from admin_users where user_id = '<auth.users.id>';
--
-- A delete takes effect on that principal's next query -- is_admin() reads the
-- table live -- and leaves them a signed-in stranger, not a locked-out one.
insert into admin_users (user_id, email, note)
values
  ('c5b809ab-8ad0-4e2e-a985-cc709726c12b', 'byronddelpinal@gmail.com', 'maintainer; admin at 059'),
  ('5c30e2be-fb56-4b29-923d-71cce9722d80', 'mac@artxlove.com',         'business partner; admin at 059')
on conflict (user_id) do nothing;

-- ── 3. is_admin() ────────────────────────────────────────────────────────────
-- SECURITY DEFINER is load-bearing, not stylistic: without it the policy on
-- `events` would evaluate this as the caller, who has no way to read the
-- RLS-protected admin_users. Definer rights break the cycle. 038:60-63
-- documents the identical reasoning for event_is_pending_review.
--
-- `set search_path = public` is the counterweight. A definer function with an
-- unpinned search path is a privilege-escalation primitive -- a caller can
-- prepend a schema they control and hijack the unqualified admin_users
-- reference. Every definer function in this repo already pins it (038:69,
-- 043:48, 049:27, 052:189, 053:48, 054:61).
--
-- `stable`, not `volatile`, so the planner may hoist it out of per-row
-- evaluation instead of calling it once per candidate row.
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from admin_users a where a.user_id = auth.uid())
$$;

revoke all on function is_admin() from public;
grant execute on function is_admin() to anon, authenticated;

-- ── 4. Narrow the fifteen unscoped `authenticated` policies ──────────────────
-- Nine FOR ALL, then six SELECT-only. In every case the predicate goes from
-- `true` to `is_admin()`; nothing else about the policy changes.
--
-- The sixteenth, "Authenticated users can read scraper_runs" (003:46-48), is
-- NOT touched: it has no TO clause (it is a PUBLIC-role policy whose predicate
-- is auth.role() = 'authenticated'), 004:14-21 grants the same read to anon
-- anyway, and TechnicalPage.tsx:125 renders scraper_health to the public.

-- events
drop policy if exists "Authenticated users have full event access" on events;
create policy "Admin full access events"
  on events for all to authenticated
  using (is_admin()) with check (is_admin());

-- venues
drop policy if exists "Authenticated users have full venue access" on venues;
create policy "Admin full access venues"
  on venues for all to authenticated
  using (is_admin()) with check (is_admin());

-- organizations
drop policy if exists "Authenticated users have full organization access" on organizations;
create policy "Admin full access organizations"
  on organizations for all to authenticated
  using (is_admin()) with check (is_admin());

-- areas
-- DRIFT NOTE, verified against production 2026-08-21: the live policy carries
-- roles {authenticated, supabase_admin}, not {authenticated} as 006:101-104
-- checked in. Dropping and recreating it here drops supabase_admin from the
-- role list, which costs that role nothing: supabase_admin is a superuser with
-- BYPASSRLS, so it was never gated by this policy in the first place. The
-- rollback file restores the live shape, not the file shape.
drop policy if exists "Authenticated users have full area access" on areas;
create policy "Admin full access areas"
  on areas for all to authenticated
  using (is_admin()) with check (is_admin());

-- event_venues
drop policy if exists "Authenticated users have full event_venues access" on event_venues;
create policy "Admin full access event_venues"
  on event_venues for all to authenticated
  using (is_admin()) with check (is_admin());

-- event_areas
drop policy if exists "Authenticated users have full event_areas access" on event_areas;
create policy "Admin full access event_areas"
  on event_areas for all to authenticated
  using (is_admin()) with check (is_admin());

-- event_organizations -- this table IS the authorization edge for any future
-- partner scope. A principal that can write it can grant itself scope over an
-- event it never owned. Admin only, no exceptions.
drop policy if exists "Authenticated users have full event_organizations access" on event_organizations;
create policy "Admin full access event_organizations"
  on event_organizations for all to authenticated
  using (is_admin()) with check (is_admin());

-- event_categories
drop policy if exists "Authenticated full access event_categories" on event_categories;
create policy "Admin full access event_categories"
  on event_categories for all to authenticated
  using (is_admin()) with check (is_admin());

-- feedback_posts
drop policy if exists "Authenticated full access feedback_posts" on feedback_posts;
create policy "Admin full access feedback_posts"
  on feedback_posts for all to authenticated
  using (is_admin()) with check (is_admin());

-- subscribers -- the highest-value row set in the database: email plus the
-- secret unsubscribe token. This is the row H1 is really about.
drop policy if exists "Authenticated can read subscribers" on subscribers;
create policy "Admin can read subscribers"
  on subscribers for select to authenticated
  using (is_admin());

-- email_sends
drop policy if exists "Authenticated can read email_sends" on email_sends;
create policy "Admin can read email_sends"
  on email_sends for select to authenticated
  using (is_admin());

-- embed_requests -- partner contact details; 051:126-130 already said this
-- table should not be readable by "any authenticated user."
drop policy if exists "Authenticated can read embed_requests" on embed_requests;
create policy "Admin can read embed_requests"
  on embed_requests for select to authenticated
  using (is_admin());

-- slack_notifications
drop policy if exists "Authenticated can read slack_notifications" on slack_notifications;
create policy "Admin can read slack_notifications"
  on slack_notifications for select to authenticated
  using (is_admin());

-- event_aliases
drop policy if exists "Authenticated can read event_aliases" on public.event_aliases;
create policy "Admin can read event_aliases"
  on public.event_aliases for select to authenticated
  using (is_admin());

-- venue_aliases
drop policy if exists "Authenticated can read venue_aliases" on public.venue_aliases;
create policy "Admin can read venue_aliases"
  on public.venue_aliases for select to authenticated
  using (is_admin());

-- ── 4b. Widen the TWO masked anon INSERT policies, and one masked anon READ ──
-- READ THIS BEFORE EDITING SECTION 5. Five anon-only INSERT policies survived
-- 054. TWO of them get widened here and THREE get dropped below. All five look
-- identical on the page and the difference is not cosmetic.
--
-- These two are widened because they have live public callers and are masked
-- today by the god-mode policies section 4 just narrowed:
--   "Anon can insert areas for pending venues" (006:196-199)
--       -- VenueSubmitPage.tsx:100, OrganizationSubmitPage.tsx:150
--   "Anon can insert event_categories for pending events" (038:83-85)
--       -- SubmitPage.tsx:91-93
--
-- A signed-in visitor hitting either form is role `authenticated`, so neither
-- `to anon` policy applies -- the insert lands today ONLY because of the
-- god-mode policies on `areas` and `event_categories`. The moment those became
-- is_admin() above, both paths would 403. This is precisely the bug 054 was
-- written to fix, one table over, and it must happen in the SAME transaction.
--
-- Both failures would be silent. SubmitPage.tsx:93, VenueSubmitPage.tsx:101
-- and OrganizationSubmitPage.tsx:151 all swallow the error into a
-- console.warn, so a signed-in visitor's submission would appear to succeed
-- while losing every category or area they typed. Neither psql, nor curl, nor
-- the SQL editor, nor a logged-out browser can reproduce it (054:25-27).
--
-- WITH CHECK expressions are untouched, so a signed-in visitor gets exactly
-- the anon write surface and not a wider one. Same one-line shape as 054:53-58.
alter policy "Anon can insert areas for pending venues"            on areas            to anon, authenticated;
alter policy "Anon can insert event_categories for pending events" on event_categories to anon, authenticated;

-- AND THE SAME HAZARD ON THE READ SIDE, which is easy to miss because 054 was
-- a write-side fix. `feedback_posts` has exactly two SELECT policies:
--   "Authenticated full access feedback_posts" (038:128-130) -- narrowed to
--       is_admin() in section 4 above;
--   "Public read published non-private feedback" (038:118-120) -- `to anon`
--       ONLY, `using (status = 'published' and is_private = false)`.
-- Policies are OR'd within a role, but a `to anon` policy contributes nothing
-- to a caller whose role is `authenticated`. So the moment section 4 narrows
-- the first one, a SIGNED-IN NON-ADMIN reading the Town Square goes from
-- seeing every published public post to seeing ZERO ROWS -- and, being a read,
-- it fails as an empty page rather than as an error. Widening the public read
-- to `authenticated` restores exactly the anon read surface and nothing wider:
-- the USING clause is untouched, so private posts stay invisible to them.
alter policy "Public read published non-private feedback"          on feedback_posts   to anon, authenticated;

-- ── 5. Drop the THREE anon junction INSERT policies (audit finding M1) ───────
-- docs/security-audit-2026-06.md:66-74. These date to 006:201-216 and were
-- justified in that file's comment as being "for the submit event form."
--
-- DO NOT "complete the sweep" from 4b by widening these to `anon,
-- authenticated`. That is the most natural possible mistake here, since all
-- five policies look the same, and it would hand every signed-in user on the
-- internet a self-grantable authorization edge. These three go the other way.
--
-- WHY DROP RATHER THAN SCOPE. The audit offers the 038:79-85 alternative --
-- `with check (event_is_pending_review(event_id))`, the shape that kept the
-- public Submit form working for event_categories. Rejected: 042:36-42 lets
-- any anon insert an `events` row with status in ('pending_review',
-- 'cancelled'), so an attacker simply creates their own pending_review event
-- and links whatever organization they like to it. That is legal under the
-- scoped policy. It converts a direct write into a slightly slower direct
-- write, and it preserves a capability with no caller.
--
-- CALLER VERIFICATION -- re-done for this migration on 2026-08-21, by
-- enumeration, not by search-and-hope:
--   • src/  -- the ONLY writes are EventEditPage.tsx:171-184 (three
--     delete-then-insert pairs). That page is behind the /admin session gate,
--     runs as `authenticated`, and is covered by the three "Admin full access"
--     policies created in section 4. The only other reference in src/ is
--     useEvents.ts:546, a nested SELECT.
--   • The three public submit forms do not touch these tables AT ALL.
--     SubmitPage.tsx, VenueSubmitPage.tsx and OrganizationSubmitPage.tsx
--     contain zero references to event_venues, event_organizations or
--     event_areas. The 006 comment describes a form that no longer does this.
--   • api/ and supabase/functions/ -- zero writes; every reference is a
--     nested select.
--   • scripts/ -- linkEventVenue() (normalize.js:1918-1923),
--     linkEventOrganization() (:1948-1982) and linkEventArea() (:1988-1994),
--     plus dedupe-cross-source.js, geocode-venues.js, source-tiers.js,
--     check-venue-duplicates.js, verify-eventbrite-coverage.js,
--     check-attribution.js and debug-smp-org.js, ALL write through
--     supabaseAdmin (scripts/lib/supabase-admin.js -- SUPABASE_SERVICE_ROLE_KEY).
--     Service role bypasses RLS entirely; 038:26-27 states exactly this.
--   • supabase/tests/ -- day_plan_rls.test.sql:94 inserts event_venues from
--     _dp_test_make_event(), which every caller invokes after `reset role`,
--     i.e. as the file owner. No test asserts that anon CAN insert here.
-- Zero callers lose anything.
drop policy if exists "Anon can insert event_venues"        on event_venues;
drop policy if exists "Anon can insert event_organizations" on event_organizations;
drop policy if exists "Anon can insert event_areas"         on event_areas;

-- Belt and braces. There are no table-level GRANTs or REVOKEs on these three
-- anywhere in 001-058 (the only ones in the history are 004:20-21 and
-- 030:43-44), so Supabase's default schema grants apply and the policy was the
-- only gate. Revoking the grant outright is the shape 030:43-44 uses for the
-- moderation tables. `authenticated` keeps its INSERT grant -- the admin
-- editor needs it.
revoke insert on event_venues, event_organizations, event_areas from anon;

-- ── 6. Widen the four moderation gates ───────────────────────────────────────
-- Found while reading, and in scope of this boundary rather than of the
-- original ask. All four moderation_screen_* trigger functions gate on
-- `moderation_request_role() is distinct from 'anon' -> return NEW`, so a
-- SIGNED-IN visitor's submission bypasses content screening entirely. That is
-- the same bug class 054 fixed for embed_request_force_intake_defaults and 055
-- fixed for moderation_screen_day_plan, one table at a time; these four were
-- never swept.
--
-- There are FOUR, not three. moderation_screen_feedback() (030:181-190) has
-- the identical gate at 030:185 and its trigger is live (030:208-211).
--
-- To be precise about WHY it belongs in the sweep, because the obvious reason
-- is wrong: free text submitted through the Town Square orb does NOT land on a
-- published page. "Anon can insert feedback" (043:32-42) pins
-- `is_private = true`, and "Public read published non-private feedback"
-- (038:118-120) requires `is_private = false`, so a publicly-submitted post is
-- structurally unreadable by the public no matter what its status is. The
-- reason to widen this gate is the same as for the other three: the screen is
-- what puts a matching post in front of the admin at all. Under the 030 gate a
-- signed-in visitor's post is never screened, so it never gets flagged, never
-- lands in triage, and sits unread in a table nobody looks at -- and it is the
-- admin, reviewing and then publishing, who decides whether text reaches a
-- page. Widening the gate feeds triage; it is not the last line before
-- publication.
--
-- THE NEW GATE IS NOT 055's SHAPE, AND THAT IS DELIBERATE. 055:55 skips only
-- service_role. Copying that here would ship a regression, for a reason
-- specific to these four triggers and absent from 055's:
--
--   trg_moderation_events fires `before insert or update of title,
--   description, tags`; trg_moderation_feedback fires `before insert or update
--   of body, author_name, status`. THOSE ARE THE ADMIN'S TRIAGE ACTIONS.
--   Today the admin is skipped, because the admin is `authenticated` and the
--   gate is "only screen anon." Under a service_role-only gate, an admin who
--   cleans up a flagged event's title, or who moves a flagged feedback post
--   from pending_review to published, re-runs the matcher on the same text and
--   gets the row shoved straight back to pending_review -- or to cancelled, if
--   the match is 'extreme'. Triage would silently fail to stick, on exactly
--   the rows that most need triaging. 055's day-plan trigger had no admin
--   write path at all, so its two-way gate was never exercised against this
--   population.
--
-- Hence `is_admin()`.
--
-- AND HENCE THE NULL CARVE-OUT, which is the same argument one door over.
-- Verified against production on 2026-08-21:
--   • In the Supabase SQL editor, current_user is `postgres`,
--     request.jwt.claims is NULL, moderation_request_role() is NULL and
--     auth.uid() is NULL -- so is_admin() is FALSE there.
--   • A NULL role is not reachable through the live API. Probed three ways --
--     apikey + Authorization, apikey alone with no Authorization header, and
--     the new sb_publishable_ key alone -- and moderation_request_role()
--     returned 'anon' in all three.
--
--     BE CLEAR ABOUT WHY, because the tempting explanation is wrong. It is NOT
--     a property of PostgREST that request.jwt.claims always carries a role.
--     PostgREST propagates the JWT payload verbatim, and
--     moderation_request_role() is `claims ->> 'role'`, which is NULL for any
--     payload without a string `role` -- `{}`, `{"sub":...}` and
--     `{"role":null}` all return NULL, verified. What actually closes the door
--     is INFRASTRUCTURE, not the database: Supabase's gateway rejects a
--     request with no `apikey`, and Supabase's own key JWTs (anon, publishable,
--     service_role) always carry a `role` claim. So every request that reaches
--     PostgREST at all arrives with a role, and NULL still means "direct
--     database connection" -- but it means that because of the gateway in
--     front, which is where a future change could quietly move the line.
--
--   • THE NULL EXEMPTION IS INHERITED, NOT NEW. The 030 gate was
--     `moderation_request_role() is distinct from 'anon' -> return NEW`, and
--     NULL is distinct from 'anon', so a NULL-role caller was ALREADY exempt
--     at 030:140. Every caller this migration exempts was exempt before it;
--     the new gate is a strict subset of 030's, screening strictly more
--     traffic. Nothing here grants anything that was not already granted.
--
--   • It is nonetheless a DELIBERATE DEVIATION FROM ADR §6.1, which specified
--     two exemptions (`service_role or is_admin()`) and no NULL carve-out.
--     Recorded here rather than silently shipped: the third exemption is what
--     keeps SQL-editor triage working, per the paragraph below, and it is the
--     one place 059 does not do what the ADR wrote.
-- Without the NULL carve-out, SQL-editor triage would bounce rows back to
-- pending_review even though /admin triage no longer does -- which is the very
-- regression the is_admin() exemption exists to prevent, reintroduced through
-- the door the admin actually uses for the tables that have no admin UI
-- (051:126-130). The carve-out costs nothing: a caller already on a direct
-- database connection is past every RLS boundary in this file anyway.
--
-- Partners, when they exist, are deliberately on the SCREENED side of this
-- gate: a semi-trusted principal writing free text onto a public community
-- calendar is precisely the population the screen exists for.
--
-- Only the gate line changes in each function; the field lists and the
-- severity handling below it are copied verbatim from 030:136-190.

create or replace function moderation_screen_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  -- [059] Was: `if moderation_request_role() is distinct from 'anon' then
  -- return NEW; end if;` -- which let every signed-in visitor past the screen.
  -- See section 6 of 059 for why the exemption list is these three and not
  -- 055's single service_role test.
  if moderation_request_role() is null                    -- direct DB / SQL editor / migration
     or moderation_request_role() = 'service_role'        -- scraper ingest, screened in JS (049:18-21)
     or is_admin()                                        -- admin triage IS an update of these columns
  then return NEW; end if;
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
  if moderation_request_role() is null
     or moderation_request_role() = 'service_role'
     or is_admin()
  then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.name, NEW.description));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

create or replace function moderation_screen_organization()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is null
     or moderation_request_role() = 'service_role'
     or is_admin()
  then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.name, NEW.description));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

create or replace function moderation_screen_feedback()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is null
     or moderation_request_role() = 'service_role'
     or is_admin()
  then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.body, NEW.author_name));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

commit;
