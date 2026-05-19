-- Relax banner_eligible threshold based on real-world signals.
--
-- Original (021) required image_file_size IS NOT NULL and bpp >= 0.04.
-- Two issues observed against real data:
--
--   1. Many sources (notably calendar.uakron.edu) serve images via chunked
--      transfer encoding and don't expose Content-Length, so image_file_size
--      is null even when we have valid dimensions. Rejecting those was too
--      conservative — the image is real, we just don't know its byte size.
--
--   2. The 0.04 BPP threshold was calibrated against JPEG photos. PNG
--      web-banner art with large flat-color regions compresses much more
--      efficiently and sits around 0.02–0.03 BPP — well-rendered but
--      below threshold. Lowering to 0.02 still catches the egregious
--      "80x80 source upscaled to 1200x1200" case (BPP ~0.003) without
--      false-rejecting legitimate PNG banners.
--
-- Postgres doesn't allow ALTER COLUMN on generated columns, so we drop
-- and re-add with the new expression. Backfill values are recomputed
-- automatically on the next insert/update of each row.

alter table events drop column if exists banner_eligible;

alter table events add column banner_eligible boolean
  generated always as (
    image_url       is not null
    and image_width    is not null and image_width    >= 600
    and image_height   is not null and image_height   >= 338
    and (
      -- Server doesn't expose Content-Length: trust the dimensions signal.
      image_file_size is null
      -- Server does expose it: require a minimum bytes-per-pixel ratio so
      -- we catch heavily-compressed or upscaled imposters.
      or (image_file_size::float / nullif(image_width::float * image_height::float, 0)) >= 0.02
    )
  ) stored;

create index if not exists idx_events_banner_eligible
  on events (banner_eligible) where banner_eligible = true;
