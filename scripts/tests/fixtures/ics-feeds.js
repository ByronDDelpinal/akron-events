/**
 * Fixture iCalendar feeds for testing the shared ICS parser.
 * Each fixture is a plain string representing a complete or partial VCALENDAR.
 */

/** Minimal valid VCALENDAR with two VEVENTs. */
export const SIMPLE_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Akron Symphony//Calendar//EN',
  'BEGIN:VEVENT',
  'UID:concert-42@akronsymphony.org',
  'SUMMARY:Mozart & Vivaldi',
  'DESCRIPTION:An evening of classical favorites.',
  'DTSTART;TZID=America/New_York:20260307T190000',
  'DTEND;TZID=America/New_York:20260307T213000',
  'LOCATION:E.J. Thomas Performing Arts Hall',
  'URL:https://akronsymphony.org/event/mozart-vivaldi',
  'CATEGORIES:Classical,Symphony',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:concert-43@akronsymphony.org',
  'SUMMARY:Carmina Burana',
  'DESCRIPTION:Featuring full orchestra and choir.',
  'DTSTART:20260509T200000Z',
  'DTEND:20260509T223000Z',
  'URL:https://akronsymphony.org/event/carmina-burana',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

/** Feed with folded lines (long description continues on next line with leading space). */
export const FOLDED_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:folded-1',
  'SUMMARY:Folded Summary',
  'DESCRIPTION:This is the first part of a long description that continues',
  ' on the next line per RFC 5545 line folding rules\\, with escapes.',
  'DTSTART:20260101T120000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

/** All-day event (VALUE=DATE with 8-char date). */
export const ALL_DAY_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:allday-1',
  'SUMMARY:Independence Day',
  'DTSTART;VALUE=DATE:20260704',
  'DTEND;VALUE=DATE:20260705',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

/** Feed containing a VALARM block nested inside VEVENT (should be ignored). */
export const FEED_WITH_ALARM = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:with-alarm-1',
  'SUMMARY:Reminder Event',
  'DTSTART:20260101T100000Z',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Event starting soon',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

/** Feed where escape sequences are present in SUMMARY/DESCRIPTION. */
export const ESCAPED_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:escaped-1',
  'SUMMARY:Wine\\, Cheese\\, & Chocolate',
  'DESCRIPTION:Line one.\\nLine two.\\nSemi\\; colon.',
  'DTSTART:20260215T180000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

/**
 * Feed exercising the custom X-… image properties. The first event carries both
 * X-ALT-IMAGE (preferred) and X-IMAGE; the second only X-IMAGE; the third only
 * X-APPLE-STRUCTURED-LOCATION, which is a geo payload and must never be treated
 * as an image.
 */
export const IMAGE_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:image-1',
  'SUMMARY:Gallery Opening',
  'DTSTART:20260301T180000Z',
  'X-ALT-IMAGE:https://cdn.example.com/alt.jpg',
  'X-IMAGE:https://cdn.example.com/main.jpg',
  'X-APPLE-STRUCTURED-LOCATION:geo:41.08\\,-81.52',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:image-2',
  'SUMMARY:Second Gallery',
  'DTSTART:20260302T180000Z',
  'X-IMAGE:https://cdn.example.com/second.jpg',
  'X-APPLE-STRUCTURED-LOCATION:geo:41.08\\,-81.52',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:image-3',
  'SUMMARY:Geo Only',
  'DTSTART:20260303T180000Z',
  'X-APPLE-STRUCTURED-LOCATION:geo:41.08\\,-81.52',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

/** A non-ICS body that should be rejected by the parser. */
export const NOT_ICS = '<html><body>Sorry, this page has no calendar feed</body></html>'
