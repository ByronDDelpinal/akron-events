/**
 * _shared/email.ts — brand design system for subscriber-facing emails.
 *
 * Shared by the subscribe and send-digest edge functions so the
 * masthead, footer, buttons, and palette stay identical across every
 * email we send. Mirrors src/lib/emailTheme.ts (the frontend copy of
 * the brand contract) — update both together when the brand changes.
 *
 * Email-client rules baked in here (don't undo these):
 *   - Table-based layout only. Flexbox/grid silently break in Outlook
 *     desktop and older clients.
 *   - px font sizes only. rem is unsupported in many clients.
 *   - Buttons are "bulletproof": a table cell carries the background
 *     and radius, the anchor carries the padding.
 *   - All dynamic text must go through escapeHtml() — event titles and
 *     venue names come from scrapers and public submissions.
 */

export const THEME = {
  brandName: 'Akron Pulse',
  tagline: 'Everything happening in Akron & Summit County',
  copyrightHolder: 'Akron Pulse',
  location: 'Akron, OH',

  // Sender identity. RESEND_FROM / RESEND_REPLY_TO env overrides keep
  // a future domain migration to a single secret update.
  from: Deno.env.get('RESEND_FROM') || 'Akron Pulse <digest@akronpulse.com>',
  replyTo: Deno.env.get('RESEND_REPLY_TO') || 'byron@akronpulse.com',

  // Masthead logomark: the transparent pulse-line PNG already hosted
  // from public/theme-logos/ (email clients can't load SVG/WEBP, so
  // PNG it stays). Rendered next to a live-text wordmark — the
  // horizontal banner lockup, but the text survives image blocking
  // and needs no background matching. null = text wordmark only.
  logoUrl: (Deno.env.get('PUBLIC_SITE_URL') || 'https://akronpulse.com') + '/theme-logos/AkronPulse_Civic-Teal.png' as string | null,

  // Teal of the logomark's end dot (#59AEC0, sampled from the PNG) —
  // used for the "Pulse" half of the wordmark so text matches the art.
  wordmarkAccent: '#59AEC0',

  // Civic Teal palette — synced with globals.css :root and src/lib/emailTheme.ts
  colors: {
    primary:       '#0E5163',
    primaryHover:  '#0A3E4D',
    primaryPale:   '#D6E8EE',
    background:    '#FCFAF4',
    card:          '#FFFFFF',
    dark:          '#0A3B48',
    textPrimary:   '#1F2A30',
    textSecondary: '#3E5560',
    textMuted:     '#5F7886',
    border:        '#DAD5C8',
    greenMid:      '#2A8A9D',
    coral:         '#BC4F3E',
    freeBg:        '#E4F0E6',
    freeTxt:       '#1A5428',
    white:         '#FFFFFF',
  },

  fonts: {
    display: "'Space Grotesk',system-ui,sans-serif",
    body:    "'DM Sans',system-ui,sans-serif",
  },
} as const

/** Escape untrusted text (event titles, venue/org names) for HTML. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Bulletproof CTA button. The td carries bg + radius (renders in
 * Outlook), the anchor carries padding (renders everywhere else).
 */
export function button(
  href: string,
  label: string,
  opts: { bg?: string; align?: 'left' | 'center' } = {},
): string {
  const bg = opts.bg ?? THEME.colors.primary
  const align = opts.align ?? 'center'
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="margin:${align === 'center' ? '0 auto' : '0'};">
  <tr>
    <td style="background:${bg};border-radius:10px;">
      <a href="${href}" style="display:inline-block;padding:13px 28px;color:${THEME.colors.white};text-decoration:none;font-family:${THEME.fonts.display};font-size:14px;font-weight:700;letter-spacing:0.01em;">${label}</a>
    </td>
  </tr>
</table>`
}

/**
 * Two-tone text wordmark matching the banner lockup: first word in
 * white, the rest in the logomark's teal ("Akron <Pulse>"). Generic
 * split so a forked city brand ("Canton Beat") gets the same effect.
 */
function wordmark(): string {
  const [first, ...rest] = THEME.brandName.split(' ')
  if (rest.length === 0) return first
  return `${first} <span style="color:${THEME.wordmarkAccent};">${rest.join(' ')}</span>`
}

export interface ShellOptions {
  /** Inbox preview snippet. Keep under ~110 chars. */
  preheader: string
  /** Pre-rendered inner HTML, placed inside the white card. */
  content: string
  footer: {
    /** Digest emails: manage-preferences + unsubscribe links. */
    prefsUrl?: string
    unsubUrl?: string
    /** Transactional emails: why-you-got-this line instead of unsub. */
    transactionalNote?: string
    /** Mission moment + submit-an-event line (digest only). */
    showMission?: boolean
  }
}

/**
 * Brand shell: dark-teal canvas matching the masthead, white content
 * card floating on it, light-on-teal mission footer. The canvas color
 * (THEME.colors.dark) and the masthead share one tone so the brand
 * reads as a single full-bleed teal field framing the white card.
 */
export function renderEmailShell({ preheader, content, footer }: ShellOptions): string {
  const c = THEME.colors
  const f = THEME.fonts

  // Footer + canvas text colors: the footer sits directly on the teal
  // canvas (no white card behind it), so every footer color must be a
  // light-on-dark tone, not the dark-on-cream tones used in the card.
  const onCanvasSoft = c.primaryPale            // #D6E8EE — body text on teal
  const onCanvasMuted = '#8FB6C2'               // dimmer teal-tint for fine print

  const footerLinks = footer.prefsUrl && footer.unsubUrl
    ? `
      <a href="${footer.prefsUrl}" style="color:${c.white};font-size:12px;font-weight:600;text-decoration:underline;text-underline-offset:2px;">Manage preferences</a>
      <span style="color:${onCanvasMuted};">&nbsp;&middot;&nbsp;</span>
      <a href="${footer.unsubUrl}" style="color:${onCanvasMuted};font-size:12px;text-decoration:underline;text-underline-offset:2px;">Unsubscribe</a>`
    : footer.transactionalNote
      ? `<span style="color:${onCanvasMuted};font-size:12px;">${footer.transactionalNote}</span>`
      : ''

  const mission = footer.showMission
    ? `
    <tr>
      <td align="center" style="padding:0 8px 12px;">
        <div style="font-family:${f.display};font-size:21px;font-weight:700;color:${c.white};line-height:1.2;letter-spacing:-0.01em;">
          Never miss a beat
        </div>
      </td>
    </tr>
    <tr>
      <td align="center" style="padding:0 14px 14px;">
        <div style="font-family:${f.body};font-size:13px;color:${onCanvasSoft};line-height:1.6;max-width:420px;margin:0 auto;">
          Thanks for checking Akron Pulse, your free, easy, go-to regional events calendar, courtesy of your friendly neighborhood Summit County residents.
        </div>
      </td>
    </tr>
    <tr>
      <td align="center" style="padding:0 8px 14px;">
        <span style="font-family:${f.body};font-size:12px;color:${onCanvasSoft};">
          Have an event? <a href="https://akronpulse.com/submit" style="color:${c.white};font-weight:600;text-decoration:underline;text-underline-offset:2px;">Submit it here</a>, see it live in 24 hours.
        </span>
      </td>
    </tr>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <title>${THEME.brandName}</title>
</head>
<body style="margin:0;padding:0;background:${c.dark};font-family:${f.body};">

<!-- Preheader (inbox snippet, hidden in the rendered body) -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${c.dark};">
  ${preheader}
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.dark}" style="background:${c.dark};">
  <tr>
    <td align="center" style="padding:28px 12px;">

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

        <!-- Masthead: horizontal lockup — pulse logomark + live-text wordmark -->
        <tr>
          <td align="center" style="background:${c.dark};border-radius:14px 14px 0 0;padding:22px 28px 18px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
              <tr>
                ${THEME.logoUrl ? `<td valign="middle" style="padding-right:11px;">
                  <img src="${THEME.logoUrl}" alt="" width="56" height="38" style="display:block;border:0;">
                </td>` : ''}
                <td valign="middle" style="font-family:${f.display};font-size:23px;font-weight:700;letter-spacing:-0.02em;line-height:1;color:${c.white};">
                  ${wordmark()}
                </td>
              </tr>
            </table>
            <div style="font-family:${f.body};font-size:13px;color:${c.primaryPale};margin-top:9px;letter-spacing:0.04em;">
              Never miss a beat
            </div>
          </td>
        </tr>

        <!-- Pulse accent bar -->
        <tr>
          <td style="background:${c.greenMid};height:3px;line-height:3px;font-size:1px;">&nbsp;</td>
        </tr>

        <!-- Content card -->
        <tr>
          <td style="background:${c.card};border:1px solid ${c.border};border-top:none;border-radius:0 0 14px 14px;padding:26px 24px;">
            ${content}
          </td>
        </tr>

      </table>

      <!-- Footer -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td style="height:22px;line-height:22px;font-size:1px;">&nbsp;</td></tr>
        ${mission}
        <tr>
          <td align="center" style="padding:0 8px 10px;">
            ${footerLinks}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 8px;">
            <div style="font-family:${f.body};font-size:11px;color:${onCanvasMuted};">
              &copy; ${new Date().getFullYear()} ${THEME.copyrightHolder} &middot; ${THEME.location}
            </div>
          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>
</body>
</html>`
}
