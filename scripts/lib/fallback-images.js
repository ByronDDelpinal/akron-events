/**
 * fallback-images.js
 *
 * Static per-source fallback images, for sources whose platform structurally
 * cannot provide a per-event photo (a calendar feed with no image field, an
 * iCal export, RecDesk detail pages with no photo, etc. — verified in the
 * 2026-07-02 data-quality audit; see docs of that plan for the source list
 * and per-source verification notes).
 *
 * Applied in normalize.js's enrichWithImageDimensions() when a scraper's row
 * has no image_url of its own — a mechanism-only change. Every value below
 * is a TODO until Byron supplies a real, rights-cleared photo per source; a
 * source with no configured fallback (null) behaves exactly as it does
 * today (image_url stays null). Filling in a URL here requires no scraper
 * changes — it takes effect on the next scrape.
 */
export const SOURCE_FALLBACK_IMAGE = {
  full_grip_games:        null, // TODO(Byron): storefront / game-night photo
  cuyahoga_falls_library:  null, // TODO(Byron): Taylor Memorial branch photo
  city_of_hudson:          null, // TODO(Byron): city seal or downtown Hudson photo
  akron_rec_parks:         null, // TODO(Byron): rec center / park photo
  city_of_cuyahoga_falls:  null, // TODO(Byron): city seal or downtown photo
  indivisible_akron:       null, // TODO(Byron): org logo
  city_of_green:           null, // TODO(Byron): city seal
  city_of_stow:            null, // TODO(Byron): city seal
  city_of_tallmadge:       null, // TODO(Byron): city seal
  akron_zips:              null, // TODO(Byron): Zips athletics logo
  city_of_new_franklin:    null, // TODO(Byron): city seal
}

/** The configured fallback image URL for a source, or null. */
export function fallbackImageFor(source) {
  return SOURCE_FALLBACK_IMAGE[source] ?? null
}
