-- Add 'fitness' as a separate category (split from 'sports')
alter table events drop constraint if exists events_category_check;
alter table events add constraint events_category_check
  check (category in (
    'music','art','community','nonprofit',
    'food','sports','fitness','education','other'
  ));
