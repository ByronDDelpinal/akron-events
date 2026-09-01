-- ════════════════════════════════════════════════════════════════════════════
-- 069_event_series_rollback.sql
--
-- Undoes 069_event_series.sql: the three policies, the events.series_id
-- column (its FK and partial index go with it), and the event_series table.
--
-- Rollback scripts live ONLY here, never in supabase/migrations/ - `supabase
-- db push` would otherwise apply this as a migration and instantly undo 069.
-- Byron applies this himself; DO NOT APPLY, do not commit.
--
-- NOTE: occurrence rows are LEFT IN PLACE. They are ordinary events rows the
-- public may already have seen, and they stay identifiable by their
-- source_id prefix ('series:<id>:<YYYY-MM-DD>') if a later data step wants
-- to cancel or delete them. Dropping the column only severs the link.
-- ════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

drop policy if exists "Partner reads own org series"   on event_series;
drop policy if exists "Admin full access event_series" on event_series;
drop policy if exists "Anon can insert manual series"  on event_series;

drop index if exists idx_events_series_id;
alter table events drop column if exists series_id;

-- idx_event_series_active and trg_event_series_updated_at go with the table.
drop table if exists event_series;

commit;
