-- ════════════════════════════════════════════════════════════════════════════
-- 055_day_plan_authenticated_select.sql
--
-- day-plan-audit.md P0-7 / Decision 2 (maintainer-approved 2026-08-09):
-- "Any `authenticated` role can read every plan and every bearer code."
--
-- ROOT CAUSE, two sub-bugs sharing one root: 038 made "any signed-in
-- Supabase Auth user" a de-facto admin, with no role system to narrow that
-- down (memory: "Partner reports need role system; 038 = any authed user is
-- admin"). Migration 052 leaned on that posture twice:
--
--   a. `create policy "Authenticated can read day_plans" ... for select to
--      authenticated using (true)` (and its day_plan_items twin), intended
--      as the maintainer's forensics path. But an RLS USING clause cannot
--      see the client's WHERE clause, so `using (true)` means exactly what
--      it says: ANY authenticated caller can `select code from day_plans`
--      and enumerate every plan's bearer code on the site. If Supabase Auth
--      signup is enabled on this project, that's anyone with an email
--      address -- precisely the enumeration hole 052's own header (lines
--      24-28) says a policy here would open, reopened through the
--      `authenticated` door instead of `anon`.
--
--   b. moderation_screen_day_plan() gated on `moderation_request_role() =
--      'anon'`, so a signed-in visitor's plan title bypassed moderation
--      screening entirely -- the exact class of bug 054 already fixed for
--      embed_request_force_intake_defaults, one table over.
--
-- FIX, per the maintainer's ruling (Decision 2): drop the two SELECT
-- policies outright rather than gate them behind disabling public signup in
-- the Supabase dashboard. The two are not equivalent -- dropping the
-- policies is unconditional, while "disable signup" depends on a dashboard
-- setting a future Supabase default change or a misclick can silently flip
-- back on. The service role in the SQL editor bypasses RLS regardless, so
-- the maintainer's forensics/recovery path (052's own recovery recipe,
-- lines 33-40) loses nothing these policies were providing.
--
-- moderation_screen_day_plan is widened to the exact shape 054 already
-- established for embed_request_force_intake_defaults: skip screening only
-- for service_role (the one role with a legitimate reason to write an
-- unscreened title -- none exists today, but the shape stays consistent
-- with 054 rather than inventing a new one), so anon AND authenticated
-- titles are both screened.
--
-- DO NOT APPLY THIS MIGRATION. The maintainer applies migrations himself.
-- ════════════════════════════════════════════════════════════════════════════

begin;

drop policy if exists "Authenticated can read day_plans" on day_plans;
drop policy if exists "Authenticated can read day_plan_items" on day_plan_items;

create or replace function moderation_screen_day_plan()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if moderation_request_role() = 'service_role' then return NEW; end if;
  if NEW.title is not null and moderation_severity(NEW.title) is not null then
    NEW.title := null;   -- drop the title, keep the plan; never lose the items
  end if;
  return NEW;
end; $$;

commit;
