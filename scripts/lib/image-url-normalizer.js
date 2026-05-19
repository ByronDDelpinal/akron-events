/**
 * image-url-normalizer.js
 *
 * Transforms a scraped image URL into its highest-resolution variant.
 *
 * Many sources we scrape from serve resized/cropped variants by default —
 * fine for their own listing pages but bad as event banners on Turnout.
 * Each per-source transform here un-resizes the URL so the scraper stores
 * the full-fidelity image. Verified bytes-gain notes are in comments.
 *
 * Sources NOT listed here are pass-through: either the source serves
 * full-res by default, or no reliable transform is known yet.
 *
 * Usage:
 *   import { normalizeImageUrl } from './image-url-normalizer.js'
 *   const url = normalizeImageUrl(rawUrl, 'uakron_calendar')
 */

const TRANSFORMS = {
  // calendar.uakron.edu/live/image/gid/N/width/80/height/80/crop/1/[src_region/...]/file.jpg
  // The endpoint accepts any width/height/crop combo; max-out the resize.
  // Verified gain: 6KB thumb → 73KB at width=2000 (~12×).
  uakron_calendar:        uakronCalendarLive,
  uakron_myers_art:       uakronCalendarLive,
  ejthomas_hall:          uakronCalendarLive,

  // akronkids.org/sites/default/files/styles/<style>/public/<path>?itok=<token>
  // Drupal's image style routing. Strip /styles/.../public/ to reach the
  // original. The ?itok= token is only meaningful for the style URL.
  // Verified gain: 84KB thumb → 1.2MB original (~14×).
  akron_childrens_museum: drupalImageStyle,

  // WordPress serves resized variants with a -WxH suffix before the
  // extension (e.g., image-300x300.jpg). Strip the suffix for the original.
  // Verified gain: 15-22KB thumb → 133-335KB original (~6-22×).
  summit_artspace:        wordpressResizedSuffix,
  torchbearers:           wordpressResizedSuffix,

  // img.evbuc.com is Eventbrite's resize proxy. The path after the host
  // is a URL-encoded source URL on cdn.evbuc.com. Use the source directly.
  // The scrape-eventbrite scraper now prefers ev.image.original.url at
  // scrape time, but pre-existing rows still point at the proxy variant
  // and need backfill via this transform.
  eventbrite:             eventbriteProxy,
}

/**
 * Returns the normalized URL for `url` given its `source`, or `url`
 * unchanged when no transform applies / the transform fails.
 */
export function normalizeImageUrl(url, source) {
  if (!url || typeof url !== 'string') return url
  const fn = TRANSFORMS[source]
  if (!fn) return url
  try {
    const next = fn(url)
    return next || url
  } catch {
    return url
  }
}

// ── Per-source transforms ────────────────────────────────────────────────

function uakronCalendarLive(url) {
  if (!/calendar\.uakron\.edu/.test(url)) return null
  // Strip both the /width/N/height/N/crop/N/ block AND any /src_region/.../
  // segment. The endpoint 404s if requested width/height exceed src_region
  // dimensions, so the only reliably-safe move is to drop them all and let
  // the server serve the natural source image.
  //   /gid/9/width/80/height/80/crop/1/src_region/0,0,1200,1200/file.jpg
  //   → /gid/9/file.jpg
  let next = url.replace(/\/width\/\d+\/height\/\d+\/crop\/\d+/, '')
  next = next.replace(/\/src_region\/[^/]+/, '')
  return next
}

function drupalImageStyle(url) {
  // Strip /styles/<style>/public/ to reach the file's natural location
  // and drop any ?itok=<token> cache-buster (it's keyed to the style URL).
  let next = url.replace(/\/styles\/[^/]+\/public\//, '/')
  next = next.split('?')[0]
  return next
}

function wordpressResizedSuffix(url) {
  // Match -WxH right before the final extension (.jpg, .png, .webp, etc.)
  // Examples:
  //   foo-300x169.jpg         → foo.jpg
  //   foo-bar-1024x768.webp   → foo-bar.webp
  return url.replace(/(-\d{2,4}x\d{2,4})(\.[a-zA-Z]{3,4})$/, '$2')
}

function eventbriteProxy(url) {
  // img.evbuc.com URLs have the form:
  //   https://img.evbuc.com/<encoded source URL>?...resize-params...
  if (!/img\.evbuc\.com/.test(url)) return null
  const match = url.match(/^https?:\/\/img\.evbuc\.com\/(.+?)(?:\?|$)/)
  if (!match) return null
  try {
    const decoded = decodeURIComponent(match[1])
    // Only accept the decoded result if it parses as an http(s) URL.
    return /^https?:\/\//i.test(decoded) ? decoded : null
  } catch {
    return null
  }
}
