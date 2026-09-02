-- ════════════════════════════════════════════════════════════════════════════
-- 070_slug_uniqueness_sees_hidden_rows.sql
--
-- Make the out-of-band slug uniqueness check see rows that RLS hides from
-- the inserting role. Found while running the ADR-069 slice 3 RLS test
-- against production on 2026-09-02.
--
-- THE BUG. events_slug_set_trigger (turnout_event_slug_trigger, live in prod
-- but in no migration; see the reconstruction note in
-- supabase/tests/scaffold/partner_scaffold_base.sql) fills events.slug on
-- INSERT as slugify(title) || '-' || year, made unique by
-- turnout_unique_slug(), which loops `select count(*) from <table> where
-- slug = $1 and id <> $2`. That query runs AS THE INSERTING ROLE, under RLS.
-- anon can only SELECT published events (038 + 042), so every pending_review
-- row is invisible to it, the count comes back 0, the same slug is minted a
-- second time, and events_slug_uniq raises 23505 on the anonymous submit.
--
-- Reproduced against prod inside a rolled-back transaction: as anon, two
-- single-row inserts of the same title in the same year fail on the second
-- (this is a live bug on the public submit form today), and a multi-row
-- insert of N same-title rows (the slice 3 series submission) fails on row 2.
-- As the service role (RLS bypass) the same inserts succeed, which is why
-- the scrapers and the slice 2 extender never hit it.
--
-- THE FIX. SECURITY DEFINER on turnout_unique_slug so its count runs as the
-- function owner (postgres) and sees every row regardless of the caller's
-- policies. search_path is pinned per the usual definer hygiene (038, 066).
-- Grants are made explicit rather than left to the PUBLIC default, per the
-- 038 pattern: anon and authenticated (the submit forms), service_role (the
-- scrapers, the slice 2 extender and every edge function insert; bypassrls
-- does nothing for EXECUTE, so dropping it would break the nightly scrape).
-- Prod already carried exactly those three explicit grants plus PUBLIC.
--
-- WHAT THIS WIDENS, honestly. The function exposes no row content. It does
-- become a slug-existence oracle for RLS-hidden rows: it is listed under
-- Functions in database.types.ts, so PostgREST serves it at
-- /rest/v1/rpc/turnout_unique_slug, and an anonymous caller can now learn
-- whether a guessed slug (title-year) exists among pending events, venues or
-- organizations by whether the answer comes back suffixed. Yes/no on a
-- guessed slug, no enumeration, no content. Closing it means making the
-- trigger function definer as well and revoking anon's EXECUTE on this one;
-- that is a follow-up, not a reason to hold a fix for a live submit bug.
--
-- Verified against prod in a rolled-back transaction: with this ALTER
-- applied the two anon single inserts, a 3-row anon series batch, and the
-- full supabase/tests/event_series_rls.test.sql all pass. NOTE the scaffold
-- (supabase/tests/scaffold/partner_scaffold_base.sql) reconstructs the slug
-- trigger with an id suffix and no turnout_unique_slug, so it can never mint
-- a duplicate slug and cannot regression-test this; only prod tells the
-- truth here.
--
-- The same function backs venues and organizations slugs (p_table), and the
-- anon submit forms for both insert pending rows anon cannot read, so the
-- fix covers the same latent failure there.
--
-- ── DEPLOY NOTES ────────────────────────────────────────────────────────────
--   * Byron applies via `supabase db push`. Not from an agent.
--   * MUST be applied before slice 3 (the submit form recurrence picker)
--     reaches production: without it every series submission fails.
--   * ALTER FUNCTION takes a brief lock on the function only; no table lock,
--     safe during the scrape window, but lock_timeout is set anyway.
--   * Rollback: supabase/rollbacks/070_slug_uniqueness_sees_hidden_rows_rollback.sql
--   * The ledger `version` MUST match this file's `070` prefix.
--   * database.types.ts is unaffected (function signature unchanged).
-- ════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

alter function public.turnout_unique_slug(text, uuid, text)
  security definer
  set search_path = public;

-- Explicit grants (038 pattern). service_role is load-bearing, see header.
revoke all on function public.turnout_unique_slug(text, uuid, text) from public;
grant execute on function public.turnout_unique_slug(text, uuid, text)
  to anon, authenticated, service_role;

comment on function public.turnout_unique_slug(text, uuid, text) is
  'Unique-ifies a slug for p_table by suffixing -2, -3, ... SECURITY DEFINER '
  '(070) so the uniqueness count sees rows RLS hides from the inserting role; '
  'otherwise anon submits of a repeated title raise 23505 on <table>_slug_uniq.';

commit;
