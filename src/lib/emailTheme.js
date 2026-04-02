/**
 * emailTheme.js
 *
 * Single source of truth for all brand values used in email templates
 * and the subscribe/preference pages. When the brand changes, update
 * this file only — everything else pulls from here.
 */

export const EMAIL_THEME = {
  // Brand identity
  brandName: 'Turnout',
  tagline: 'Everything happening in Akron & Summit County',
  copyrightHolder: 'Turnout',
  location: 'Akron, OH',

  // URLs (update when domain changes)
  baseUrl: 'https://turnout.com',      // production domain
  logoUrl: null,                         // set when logo is hosted

  // Colors (matches CSS variables in globals.css)
  colors: {
    primary:       '#D4922A',            // --amber
    primaryHover:  '#BC7E20',            // --amber-hover
    primaryPale:   '#FDF2DC',            // --amber-pale
    background:    '#FAF6EF',            // --bg-page
    card:          '#FFFFFF',            // --bg-card
    dark:          '#1D2B1F',            // --bg-nav
    textPrimary:   '#17200F',            // --text-primary
    textSecondary: '#3A4E30',            // --text-secondary
    textMuted:     '#7A9068',            // --text-muted
    border:        '#E0D9CA',            // --border
    greenMid:      '#3A6B4A',            // --green-mid (free badge)
    coral:         '#C4532A',            // --coral (errors)
  },

  // Typography
  fonts: {
    display: "'Space Grotesk', system-ui, sans-serif",
    body:    "'DM Sans', system-ui, sans-serif",
  },

  // Email-specific
  email: {
    fromName: 'Turnout',
    fromAddress: 'digest@turnout.com',   // update with verified domain
    replyTo: null,                        // optional
  },
}
