-- The admin save flow does DELETE + INSERT on event_categories to replace categories.
-- Without a DELETE policy for anon, the delete is silently blocked by RLS, and the
-- subsequent INSERT fails with a duplicate key violation.

create policy "Anon can delete event_categories"
  on event_categories for delete to anon
  using (true);
