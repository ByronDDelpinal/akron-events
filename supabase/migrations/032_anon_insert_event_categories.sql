-- event_venues, event_organizations, and event_areas already had anon INSERT
-- policies in the live DB (applied outside of migrations). event_categories was
-- the only junction table missing an INSERT policy, which caused a save failure
-- in the admin edit page when adding/changing categories.

create policy "Anon can insert event_categories"
  on event_categories for insert to anon
  with check (true);
