-- The admin page uses the anon Supabase client (no auth session — see migration 007).
-- Migration 001 only created a SELECT policy for published events, so the admin
-- edit page silently received null when loading pending_review (or cancelled) events.
-- This policy allows the anon role to read all events regardless of status, matching
-- the existing anon UPDATE and DELETE permissions from migration 007.

create policy "Anon can read all events"
  on events for select to anon
  using (true);
