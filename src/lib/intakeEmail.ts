/**
 * Pre-filled mailto for the no-form event intake path. The intake@
 * inbox is monitored by the email pipeline (links, flyers, and photos
 * all work), so a one-line email is a complete submission.
 *
 * Single source of truth — used by the Submit page card and the
 * footer's "Email Your Event" link.
 */
export const INTAKE_MAILTO =
  'mailto:intake@akronpulse.com' +
  `?subject=${encodeURIComponent('New Event(s) For The Calendar')}` +
  `&body=${encodeURIComponent('I found a new event that should be on your calendar, check it out!')}`
