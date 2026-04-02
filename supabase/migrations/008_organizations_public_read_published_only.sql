-- Fix: only allow public reads of published organizations.
-- Previously the policy allowed reading all orgs regardless of status,
-- which exposed pending_review / cancelled organizations in search results.
-- This matches the pattern used for events in 001_initial_schema.sql.

drop policy if exists "Public can read organizations" on organizations;
create policy "Public can read published organizations"
  on organizations for select
  using (status = 'published');
