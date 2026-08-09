-- ════════════════════════════════════════════════════════════════════════════
-- 054_public_writes_allow_authenticated.sql
--
-- BUG FIX: every public write path was silently broken for any SIGNED-IN
-- visitor. Submitting an event, sending feedback, subscribing to the digest,
-- submitting a venue or organization, and requesting an embed all failed with
-- 403 / SQLSTATE 42501 "new row violates row-level security policy" whenever
-- the browser had a Supabase auth session.
--
-- ROOT CAUSE. Every one of these INSERT policies was scoped `to anon` only:
--
--   006  "Anon can insert pending organizations" / "...pending venues"
--   012  "Anon can insert feedback" / "Anon can subscribe"
--   042  "Anon can insert pending events"
--   051  "Anon can request an embed"
--
-- supabase-js sends BOTH an `apikey` header (the anon key) AND an
-- `Authorization: Bearer <jwt>` header. When nobody is signed in, that bearer
-- token IS the anon key, PostgREST assumes role `anon`, and the policies
-- apply. The moment a session exists, supabase-js swaps in the USER's access
-- token, PostgREST assumes role `authenticated` -- and there was no INSERT
-- policy for `authenticated` on any of these tables, so the write was refused
-- with no matching policy.
--
-- This is invisible to every reasonable test: curl with the anon key, psql,
-- the Supabase SQL editor, and a logged-out browser all run as `anon` and all
-- pass. Only a signed-in browser reproduces it. Diagnosed 2026-08-09 by
-- capturing the real request headers off the live page and noticing the
-- Authorization JWT was ES256/811 chars (a user token) rather than the
-- HS256/208-char anon key.
--
-- The maintainer hit this constantly because he is permanently signed in to
-- /admin in his everyday browser.
--
-- FIX: widen each policy to `to anon, authenticated`. The WITH CHECK
-- expressions are untouched, so every column constraint (status pinning,
-- source = 'manual', featured = false, and so on) still binds exactly as
-- before -- a signed-in visitor gets the same restricted write surface as an
-- anonymous one, not a wider one.
--
-- Also extends 053's embed-request intake forcing to cover `authenticated`,
-- since it previously keyed on `= 'anon'` and passed signed-in inserts
-- through untouched. It now forces for everyone EXCEPT service_role (the
-- notifier legitimately claims notified_at, the maintainer triages status).
--
-- See also [feedback: test anon paths via the API, not the DB] -- and note
-- that "via the API" is not sufficient on its own: it must be via the API
-- WITH A SESSION, because the bearer token is what selects the role.
-- ════════════════════════════════════════════════════════════════════════════

begin;

alter policy "Anon can request an embed"             on embed_requests to anon, authenticated;
alter policy "Anon can insert pending events"        on events         to anon, authenticated;
alter policy "Anon can insert feedback"              on feedback_posts to anon, authenticated;
alter policy "Anon can insert pending organizations" on organizations  to anon, authenticated;
alter policy "Anon can subscribe"                    on subscribers    to anon, authenticated;
alter policy "Anon can insert pending venues"        on venues         to anon, authenticated;

create or replace function embed_request_force_intake_defaults()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- service_role must pass through: notify-embed-request claims notified_at
  -- and writes embed_path, and the maintainer moves status during triage.
  if moderation_request_role() = 'service_role' then return NEW; end if;

  NEW.status      := 'new';
  NEW.notified_at := null;
  NEW.embed_path  := null;
  return NEW;
end; $$;

commit;
