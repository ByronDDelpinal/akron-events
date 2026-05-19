-- Add 'nature' as a new category. Existing events are unchanged by this
-- migration — a separate backfill script will re-tag park/trail/zoo events
-- once the category is available.
alter table events drop constraint if exists events_category_check;
alter table events add constraint events_category_check
  check (category in (
    'music','art','community','nonprofit',
    'food','sports','fitness','education','nature','other'
  ));
