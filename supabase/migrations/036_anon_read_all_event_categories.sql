-- The admin save flow (EventEditPage) replaces categories via DELETE + INSERT.
-- The only SELECT policy on event_categories exposed rows for *published* events,
-- and Postgres RLS requires rows to be visible via SELECT to match a DELETE's
-- WHERE clause. For pending_review events the delete silently matched 0 rows and
-- the re-insert hit the primary key:
--   "duplicate key value violates unique constraint event_categories_pkey"
-- Migration 033 added the anon DELETE policy but not read visibility, so the bug
-- only surfaced for non-published events. This also fixes the edit form not
-- showing existing categories for pending events.
--
-- Mirrors 031_anon_read_all_events.sql and the sibling junction tables
-- (event_venues / event_organizations / event_areas), which allow read of all rows.

create policy "Anon can read all event_categories"
  on event_categories for select to anon
  using (true);
