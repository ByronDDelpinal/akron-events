-- Add a needs_review flag to events.
-- Set to true by scrapers when category falls back to 'other' (low confidence).
-- Cleared to false when an admin approves a category in the Review Queue.
-- Protected by manual_overrides: once category is manually locked, the scraper
-- won't touch category OR needs_review for that event.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;

-- Back-fill: any existing 'other' event without a manual category override
-- should appear in the queue immediately.
UPDATE events
SET needs_review = true
WHERE category = 'other'
  AND (manual_overrides->>'category') IS NULL;

-- Index so the admin queue query is fast.
CREATE INDEX IF NOT EXISTS idx_events_needs_review
  ON events (needs_review, start_at)
  WHERE needs_review = true;
