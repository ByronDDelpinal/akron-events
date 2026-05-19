/**
 * emailTheme.js
 *
 * Single source of truth for all brand values used in email templates
 * and the subscribe/preference pages. When the brand changes, update
 * this file only — everything else pulls from here.
 */

export const EMAIL_THEME = {
  // Brand identity
  brandName: 'Akron Pulse',
  tagline: 'Everything happening in Akron & Summit County',
  copyrightHolder: 'Akron Pulse',
  location: 'Akron, OH',

  // URLs (update when domain changes)
  baseUrl: 'https://events.supportlocalakron.com',      // production domain
  logoUrl: null,                         // set when logo is hosted

  // Colors — synced with the Civic Teal palette in globals.css :root
  colors: {
    primary:       '#0E5163',            // --amber  (deep petrol teal)
    primaryHover:  '#0A3E4D',            // --amber-hover
    primaryPale:   '#D6E8EE',            // --amber-pale
    background:    '#FCFAF4',            // --bg-page
    card:          '#FFFFFF',            // --bg-card
    dark:          '#0A3B48',            // --bg-nav
    textPrimary:   '#1F2A30',            // --text-primary
    textSecondary: '#3E5560',            // --text-secondary
    textMuted:     '#5F7886',            // --text-muted
    border:        '#DAD5C8',            // --border
    greenMid:      '#2A8A9D',            // --green-mid (free badge)
    coral:         '#BC4F3E',            // --coral (errors)
  },

  // Typography
  fonts: {
    display: "'Space Grotesk', system-ui, sans-serif",
    body:    "'DM Sans', system-ui, sans-serif",
  },

  // Email-specific
  email: {
    fromName: 'Akron Pulse',
    fromAddress: 'digest@events.supportlocalakron.com',   // update with verified domain
    replyTo: null,                        // optional
  },
}
