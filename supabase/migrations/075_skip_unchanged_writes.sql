-- ============================================================
-- Stop rewriting events that did not change
--
-- Incident 2026-11-14/15 (database starved on Micro compute). The nightly
-- scrape rewrote every event it re-saw, changed or not, about three times:
-- once for the upsert, then once per category row deleted and once per
-- category row re-inserted, because event_categories_sync_slugs ran an
-- unconditional UPDATE on the parent row each time. Roughly 15,000 row
-- versions a night into a 19,672-row table, each one also written into two
-- trigram indexes that nothing has read since migration 074 replaced them.
--
-- This migration is the database half. The scraper half is in
-- scripts/lib/normalize.js (per-source snapshot, content hash, category
-- difference); it needs the two columns added here.
--
--   1. events.content_hash: fingerprint of the last scraper payload written
--      for the row. The scraper compares it before writing and skips the
--      write when it matches. NULL means "never written by a hashing
--      scraper", which never matches, so the first run after deploy rewrites
--      everything once and stores the hashes.
--   2. scraper_runs.events_unchanged: how many re-seen events were skipped.
--      A subset of events_updated, which keeps its meaning.
--   3. sync_event_category_slugs only touches the events row when the slugs
--      really differ.
--   4. events.updated_at only moves when the row really changed. It feeds the
--      ICS export SEQUENCE, which was incrementing for every event every
--      night. content_hash is ignored in the comparison so that storing or
--      re-versioning a hash is not reported as a change to the event.
--      Events only: the other tables sharing set_updated_at are untouched.
--      The trigger is renamed so it sorts after every other BEFORE UPDATE
--      trigger on events and therefore compares the row as it will be stored.
--   5. The two trigram indexes are dropped (35 MB + 7 MB of a 146 MB
--      database). No query in scripts/, src/, supabase/functions, any SQL
--      function or any policy reads title_normalized/description_normalized
--      except search_events, which uses events_search_tsv_idx.
--
-- Deliberately NOT done: suppress_redundant_updates_trigger. A suppressed
-- UPDATE returns no row, so every `.upsert(...).select().single()` caller
-- (the scrapers, the admin and partner forms) would see "0 rows" as an error.
-- ============================================================

alter table public.events       add column if not exists content_hash text;
alter table public.scraper_runs add column if not exists events_unchanged integer;

comment on column public.events.content_hash is
  'Fingerprint of the last scraper payload written (scripts/lib/normalize.js computeEventContentHash). Not a hash of the stored row.';
comment on column public.scraper_runs.events_unchanged is
  'Re-seen events skipped because their payload was identical. Subset of events_updated.';

create or replace function public.sync_event_category_slugs(p_event_id uuid)
returns void
language sql
as $function$
  UPDATE events e
  SET category_slugs = n.slugs
  FROM (
    SELECT COALESCE(
      (SELECT array_agg(ec.category ORDER BY ec.category)
         FROM event_categories ec
        WHERE ec.event_id = p_event_id),
      '{}'::text[]
    ) AS slugs
  ) n
  WHERE e.id = p_event_id
    AND e.category_slugs IS DISTINCT FROM n.slugs;
$function$;

create or replace function public.events_set_updated_at_if_changed()
returns trigger
language plpgsql
as $function$
begin
  if (to_jsonb(new) - 'updated_at' - 'content_hash')
     is distinct from (to_jsonb(old) - 'updated_at' - 'content_hash') then
    new.updated_at = now();
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_events_updated_at on public.events;
drop trigger if exists zz_events_updated_at on public.events;
create trigger zz_events_updated_at
  before update on public.events
  for each row execute function public.events_set_updated_at_if_changed();

drop index if exists public.events_description_normalized_trgm_idx;
drop index if exists public.events_title_normalized_trgm_idx;

notify pgrst, 'reload schema';
