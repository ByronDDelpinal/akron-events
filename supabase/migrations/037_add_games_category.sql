-- Add the 'games' content category (Games & Hobbies) to the taxonomy.
--
-- Covers tabletop, social, and video gaming: D&D and other RPGs, board/card
-- game nights, Magic: The Gathering, chess, mahjong, trivia/pub quiz, bingo,
-- video-game tournaments, jigsaw/puzzle nights, etc. These previously fell to
-- 'other' because the 14-category taxonomy had no home for them — they were the
-- single largest bucket clogging the admin Review Queue (2026-06-11).
--
-- Registry source of truth: src/lib/categories.js (CATEGORY_SLUGS). The
-- test-category-constraint-sync.js test fails CI if this list and the registry
-- ever drift, so keep both in lockstep.

ALTER TABLE event_categories DROP CONSTRAINT IF EXISTS event_categories_category_check;

ALTER TABLE event_categories
  ADD CONSTRAINT event_categories_category_check
  CHECK (category in (
    'music', 'theater', 'film', 'comedy', 'visual-art', 'food', 'sports',
    'fitness', 'outdoors', 'learning', 'festival', 'market', 'civic', 'games',
    'other'
  ));
