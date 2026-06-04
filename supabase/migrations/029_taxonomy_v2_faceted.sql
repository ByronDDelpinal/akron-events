-- ============================================================================
-- DRAFT — Option 6 (faceted) taxonomy cutover.  NOT YET APPLIED.
-- ============================================================================
--
-- This file lives in _drafts/ on purpose:
--   • Supabase migrations are applied manually (see README) — nothing here runs
--     until you move this file up to supabase/migrations/ and run it.
--   • The registry↔DB sync test (test-category-constraint-sync.js) only scans
--     the top-level migrations dir, so this draft won't trip CI while we review.
--
-- Pairs with: src/lib/categories.v2.draft.js (the staged registry).
--
-- WHAT THIS DOES
--   1. Creates event_categories — the multi-category join table (the new
--      content axis). OR/any-match filtering, max 2 enforced in app + a trigger.
--   2. Adds facet columns to events: is_family, is_fundraiser. (`free` is
--      derived from price_min = 0; age_restriction already exists.)
--   3. Seeds event_categories + facets from today's single events.category via
--      the V1_TO_V2 map. Scrapers then re-run with the new scored inference to
--      refine multi-category + the family flag.
--   4. RLS so the public can read categories for published events only.
--
-- ⚠️  ONE DECISION FOR YOU (see bottom): keep events.category during a
--     transition deploy, or hard-drop it now. Default below = KEEP (safer);
--     the drop is written but commented out.
-- ============================================================================

begin;

-- ── 1. Content axis: event_categories join table ────────────────────────────
create table if not exists event_categories (
  event_id  uuid not null references events(id) on delete cascade,
  category  text not null check (category in (
              'music','theater','film','comedy','visual-art','food','sports',
              'fitness','outdoors','learning','festival','market','civic','other'
            )),
  primary key (event_id, category)
);

create index if not exists idx_event_categories_category on event_categories (category);
create index if not exists idx_event_categories_event    on event_categories (event_id);

-- Enforce "at most 2 content categories per event" at the DB level so no
-- ingestion path can dilute the signal. (App also soft-caps in admin/scrapers.)
create or replace function enforce_max_two_categories()
returns trigger language plpgsql as $$
begin
  if (select count(*) from event_categories where event_id = new.event_id) > 2 then
    raise exception 'event % would exceed 2 content categories', new.event_id;
  end if;
  return new;
end;
$$;

-- IMPORTANT: this is a PLAIN (non-deferrable) AFTER trigger — NOT a deferrable
-- constraint trigger. A deferrable constraint trigger queues "pending trigger
-- events" that fire at COMMIT, and Postgres refuses to ALTER TABLE
-- event_categories (e.g. `enable row level security` below) while such events
-- are pending in the same transaction (SQLSTATE 55006). A plain AFTER trigger
-- fires immediately per row, so there are never pending events. Our write paths
-- only ever insert 1–2 rows per event, so immediate checking is sufficient.
drop trigger if exists trg_event_categories_max2 on event_categories;
create trigger trg_event_categories_max2
  after insert or update on event_categories
  for each row execute function enforce_max_two_categories();

-- ── 2. RLS: public reads categories for published events only ────────────────
-- Done BEFORE the backfill inserts: all ALTER TABLE on event_categories must
-- happen before any rows are inserted in this transaction (see 55006 note above).
alter table event_categories enable row level security;

drop policy if exists "public reads categories of published events" on event_categories;
create policy "public reads categories of published events"
  on event_categories for select
  using (exists (
    select 1 from events e
    where e.id = event_categories.event_id and e.status = 'published'
  ));
-- Writes happen via the service role (scrapers/admin), which bypasses RLS.

-- ── 3. Facet columns ────────────────────────────────────────────────────────
alter table events add column if not exists is_family     boolean not null default false;
alter table events add column if not exists is_fundraiser boolean not null default false;

create index if not exists idx_events_is_family     on events (is_family)     where status = 'published' and is_family;
create index if not exists idx_events_is_fundraiser on events (is_fundraiser) where status = 'published' and is_fundraiser;

-- ── 4. Backfill from today's single category (V1_TO_V2) ──────────────────────
-- Content: seed one row per event. (Re-inference adds 2nd categories later.)
insert into event_categories (event_id, category)
select id,
  case category
    when 'art'       then 'visual-art'
    when 'education' then 'learning'
    when 'nature'    then 'outdoors'
    when 'nonprofit' then 'other'   -- real content recovered by re-inference
    when 'community' then 'other'   -- routed to festival/market/civic by re-inference
    else category                    -- music, food, sports, fitness, other
  end
from events
on conflict do nothing;

-- Facet: old 'nonprofit' category → fundraiser flag. (Reliable: it was an
-- explicit category, not a fuzzy tag.)
update events set is_fundraiser = true where category = 'nonprofit';

-- Facet: family is intentionally NOT seeded from the old tags — that signal is
-- unreliable and is being re-validated from scratch. is_family stays false here
-- and is set fresh by the rebuilt inference (re-run scrapers) + admin review.

-- ── 5. events.category — HARD CUTOVER (drop now) ─────────────────────────────
-- Decision: hard cutover. Site traffic is negligible, so we drop the legacy
-- single-category column in this same migration rather than running a
-- transition deploy. Every read path (hubs, RSS, schema.org, digest, admin,
-- useEvents) is rewired to event_categories in Phases 4–5 BEFORE this migration
-- is applied — apply this only after that wiring ships.
--
-- Note: this also drops events_category_check (the old constraint) along with
-- the column, so the registry↔DB sync test must, at cutover, be repointed at
-- event_categories' constraint.
alter table events drop column category;

commit;
