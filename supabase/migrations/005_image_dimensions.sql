-- ============================================================
-- Add image dimension columns to events table
-- Enables quality gating: only display images >= 600×338px
-- ============================================================

alter table events
  add column if not exists image_width  integer,
  add column if not exists image_height integer;

comment on column events.image_width  is 'Natural width in px of the image at image_url (populated by scrapers / backfill)';
comment on column events.image_height is 'Natural height in px of the image at image_url (populated by scrapers / backfill)';
