-- 041: enable RLS on event_aliases
--
-- Security advisor flagged event_aliases as the only public table with RLS
-- disabled (ERROR level, 2026-07-03): exposed through PostgREST, the anon key
-- could read AND write it. Nothing in the app or scripts references the table
-- (writers use the service role, which bypasses RLS), so the lockdown is
-- side-effect free.
--
-- Policy surface:
--   • anon           — no access
--   • authenticated  — read-only (admin session debugging; admin runs
--                      authenticated per migration 038)
--   • service_role   — unaffected (bypasses RLS)

alter table public.event_aliases enable row level security;

drop policy if exists "Authenticated can read event_aliases" on public.event_aliases;
create policy "Authenticated can read event_aliases"
  on public.event_aliases
  for select
  to authenticated
  using (true);
