-- ============================================================
-- Allow anon role to update and delete all entity tables.
-- This is needed because the admin page uses the anon Supabase
-- client (no auth session). When real auth is added, these
-- policies should be replaced with authenticated-only policies.
-- ============================================================

-- Events
create policy "Anon can update events"
  on events for update to anon
  using (true) with check (true);

create policy "Anon can delete events"
  on events for delete to anon
  using (true);

-- Venues
create policy "Anon can update venues"
  on venues for update to anon
  using (true) with check (true);

create policy "Anon can delete venues"
  on venues for delete to anon
  using (true);

-- Organizations
create policy "Anon can update organizations"
  on organizations for update to anon
  using (true) with check (true);

create policy "Anon can delete organizations"
  on organizations for delete to anon
  using (true);

-- Areas
create policy "Anon can update areas"
  on areas for update to anon
  using (true) with check (true);

create policy "Anon can delete areas"
  on areas for delete to anon
  using (true);

-- Junction tables (delete needed for re-linking)
create policy "Anon can delete event_venues"
  on event_venues for delete to anon
  using (true);

create policy "Anon can delete event_organizations"
  on event_organizations for delete to anon
  using (true);

create policy "Anon can delete event_areas"
  on event_areas for delete to anon
  using (true);
