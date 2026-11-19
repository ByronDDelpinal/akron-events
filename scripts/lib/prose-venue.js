/**
 * prose-venue.js — find "Venue Name, 123 Some Street, City" in a description.
 *
 * Small organizations hold events in borrowed rooms and say where in a
 * sentence, not a field:
 *
 *   "…light refreshments at the City of Joy Enrichment Center,
 *    610 W. Exchange Street, Akron."
 *   "John S. Knight Center, 77 E. Mill Street, Akron"
 *   "OHIO CHRISTMAS FACTORY
 *    4125 MAHONING ROAD NE, CANTON"
 *
 * This returns the first such place, or null. It is strict on purpose: a
 * venue is only asserted when a NAME, a HOUSE NUMBER with a street suffix,
 * and a CITY appear together, in that order. A bare address with no name, or
 * a name with no street, is not a venue this module will invent.
 *
 * The caller decides what the city means (Summit County or not) with
 * classifySummitLocation, and what to do when nothing is found.
 *
 * Pure: no clock, no I/O.
 */

const SUFFIX = '(?:street|st|road|rd|avenue|ave|parkway|pkwy|boulevard|blvd|drive|dr|way|lane|ln|court|ct|circle|cir|place|pl|highway|hwy)'

// name  — after a line start or "at [the]"; no commas, no newline, and no
//          " at " inside (so the LAST "at" before the address wins)
// sep   — a comma or a line break
// addr  — house number, optional direction, street words, a suffix, optional
//          trailing quadrant ("NE")
// city  — letters, up to the next comma / period / line end / ZIP / "OH"
const VENUE_RE = new RegExp(
  '(?:^|\\n|\\bat\\s+(?:the\\s+)?)' +
  '((?:(?!\\sat\\s)[^,\\n]){3,70}?)' +
  '\\s*(?:,|\\n)\\s*' +
  `(\\d{1,5}\\s+(?:[NSEW]\\.?\\s+)?[A-Za-z0-9.' ]{2,40}?\\s${SUFFIX}\\b\\.?(?:\\s+(?:NE|NW|SE|SW|N|S|E|W)\\b\\.?)?)` +
  '\\s*,\\s*' +
  "([A-Za-z][A-Za-z .'-]{2,30}?)" +
  '(?=\\s*(?:,|\\.|\\n|$|\\d{5})|\\s+(?:OH|Ohio)\\b)',
  'gi',
)

/** "OHIO CHRISTMAS FACTORY" → "Ohio Christmas Factory"; mixed case untouched. */
function tidyCase(s) {
  if (!/[a-z]/.test(s) && /[A-Z]{2}/.test(s)) {
    return s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
  }
  return s
}

/**
 * @param {string} text  plain text (strip HTML first; keep line breaks)
 * @returns {{name: string, address: string, city: string}|null}
 */
export function findAddressedVenue(text) {
  const s = String(text ?? '').replace(/[ \t]+/g, ' ')
  for (const m of s.matchAll(VENUE_RE)) {
    const name = m[1].trim().replace(/^the\s+/i, '')
    // A venue name starts with a capital letter or a digit ("3 Point
    // Brewing"). Lower-case text before an address is a sentence fragment.
    if (!/^[A-Z0-9]/.test(name)) continue
    const address = m[2].replace(/\s+/g, ' ').replace(/\.$/, '').trim()
    const city = m[3].trim()
    return { name: tidyCase(name), address: tidyCase(address), city: tidyCase(city) }
  }
  return null
}
