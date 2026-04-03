-- 010: Allow anon reads on subscribers and email_sends
-- Needed for the admin Email dashboard (stats + send log).
-- Same pattern as events, venues, organizations, scraper_runs —
-- admin auth is client-side, all queries use the anon key.

create policy "Anon can read subscribers"
  on subscribers for select to anon
  using (true);

create policy "Anon can read email_sends"
  on email_sends for select to anon
  using (true);
