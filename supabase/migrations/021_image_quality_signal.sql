-- Adds image quality signals derived at scrape time.
--
-- image_file_size: bytes of the served image (Content-Length).
--   Captured by the scraper alongside dimensions. Pixel-count alone
--   doesn't catch heavily-compressed or upscaled images; the bytes-
--   per-pixel ratio does.
--
-- banner_eligible: generated boolean — true when the image is large
--   enough AND has enough bytes per pixel to look acceptable as a
--   full-bleed banner. Frontend reads this directly instead of
--   recomputing thresholds in component code.

alter table events add column if not exists image_file_size integer;

alter table events add column if not exists banner_eligible boolean
  generated always as (
    image_url       is not null
    and image_width    is not null and image_width    >= 600
    and image_height   is not null and image_height   >= 338
    and image_file_size is not null
    and (image_file_size::float / nullif(image_width::float * image_height::float, 0)) >= 0.04
  ) stored;

-- Helpful index for the frontend's common "give me banner-eligible events" filter,
-- though most reads will be by event id and won't need it.
create index if not exists idx_events_banner_eligible
  on events (banner_eligible) where banner_eligible = true;
