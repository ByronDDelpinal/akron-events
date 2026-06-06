/**
 * emailTheme.ts
 *
 * Single source of truth for all brand values used in email templates
 * and the subscribe/preference pages. When the brand changes, update
 * this file only — everything else pulls from here.
 */

export interface EmailTheme {
  brandName: string
  tagline: string
  copyrightHolder: string
  location: string
  baseUrl: string
  logoUrl: string | null
  colors: Record<string, string>
  fonts: { display: string; body: string }
  email: { fromName: string; fromAddress: string; replyTo: string }
}

export const EMAIL_THEME: EmailTheme = {
  // Brand identity
  brandName: 'Akron Pulse',
  tagline: 'Everything happening in Akron & Summit County',
  copyrightHolder: 'Akron Pulse',
  location: 'Akron, OH',

  // URLs (update when domain changes)
  baseUrl: 'https://akronpulse.com',     // production domain (May 2026 rebrand from events.supportlocalakron.com)
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
    fromAddress: 'digest@akronpulse.com', // verified in Resend May 2026; the Edge functions also accept a RESEND_FROM env override
    replyTo: 'byron@akronpulse.com',      // replies to digest emails route to the human inbox
  },
}
