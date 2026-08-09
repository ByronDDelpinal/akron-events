/**
 * notify-embed-request/email.ts — pure email-rendering helpers for the
 * embed-request operator notification.
 *
 * Split out of index.ts for the same reason render.ts is split out of
 * slack-notify/index.ts: index.ts calls `Deno.serve`, builds a Supabase
 * client and a Resend client from required env vars at module scope, so
 * importing it directly (as a test would need to) starts a live listener
 * and throws in any environment without those env vars set. This file has
 * none of that — no Deno.serve, no client construction — so
 * email.test.ts can import it directly.
 *
 * `website` is the sharpest injection risk in this whole feature (bigger
 * than the snippet): an anon-supplied string turning into a clickable
 * `<a href>` in the maintainer's inbox is a working phishing primitive
 * (`javascript:`, `data:`, a lookalike domain). `linkifyWebsite` is the one
 * function that decides whether that happens — see its own docstring.
 */

import { THEME, escapeHtml, button, renderEmailShell } from '../_shared/email.ts'
import { describeConfig, type NormalizedConfig } from '../_shared/embedSnippet.ts'

export interface EmbedRequestEmailRow {
  name: string
  email: string
  organization: string
  website: string | null
  note: string | null
  created_at: string
}

// ── Subject sanitization ───────────────────────────────────────────────

// `organization` is untrusted text landing in an email Subject header.
// Resend takes JSON, so classic SMTP header-splitting via a raw CRLF isn't
// the wire-level risk it would be over SMTP directly, but stripping control
// characters and clamping length is cheap defense-in-depth regardless.
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g
export const MAX_SUBJECT_PART_LEN = 78

/** Strip control characters and clamp (by code point) for use in a Subject header. */
export function sanitizeSubjectPart(raw: string): string {
  const stripped = raw.replace(CONTROL_CHARS_RE, '').trim()
  const chars = [...stripped]
  return chars.length > MAX_SUBJECT_PART_LEN ? `${chars.slice(0, MAX_SUBJECT_PART_LEN).join('')}…` : stripped
}

// ── Website linkification (the sharp edge) ──────────────────────────────

export interface LinkifiedWebsite {
  /** Non-null ONLY when safe to render as a clickable `<a href>`. */
  href: string | null
  /** Display text — always the raw (unescaped) value; callers escape it. */
  label: string
}

/**
 * `website` only becomes a clickable link when it parses as an absolute URL
 * whose protocol is `http:` or `https:` AND carries no userinfo component.
 * Anything else — not provided, malformed, a non-http(s) scheme like
 * `javascript:`/`data:`/`file:`, or a `user[:pass]@host` authority — renders
 * as escaped PLAIN TEXT, never a link. The client also normalizes and
 * checks this before submit, but the client check is advisory only; this is
 * the real boundary.
 *
 * The userinfo check closes the classic `trusted@evil-host` phishing
 * primitive: `https://akronpulse.com@evil.com/phish` parses as protocol
 * `https:`, host `evil.com`, `username` `akronpulse.com` — a
 * protocol-and-scheme check alone lets it through, and the maintainer
 * scanning the visible label sees `akronpulse.com` up front and reasonably
 * assumes it names the destination, when the link actually navigates to
 * `evil.com`. `URL` only ever populates `username`/`password` from an
 * actual `user[:pass]@` authority segment — an `@` appearing later, inside
 * the path or query, is not treated as userinfo and does not trip this
 * check.
 */
export function linkifyWebsite(website: string | null): LinkifiedWebsite {
  if (!website) return { href: null, label: 'Not provided' }

  try {
    const url = new URL(website)
    const isHttpish = url.protocol === 'http:' || url.protocol === 'https:'
    const hasUserinfo = url.username !== '' || url.password !== ''
    if (isHttpish && !hasUserinfo) {
      return { href: url.toString(), label: website }
    }
  } catch {
    // Malformed URL — fall through to plain text.
  }
  return { href: null, label: website }
}

// ── Email body ────────────────────────────────────────────────────────

function fmtDateTime(d: Date): string {
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  })
}

// HTML-escape then turn newlines into <br> — same helper shape as
// notify-feedback/index.ts's escapeAndPreserveBreaks. escapeHtml runs
// first so a literal "<br>" typed by the submitter can never smuggle a
// real tag through.
function escapeAndPreserveBreaks(s: string): string {
  return escapeHtml(s).replace(/\r\n|\r|\n/g, '<br>')
}

export interface BuildEmbedRequestEmailArgs {
  row: EmbedRequestEmailRow
  cfg: NormalizedConfig
  snippet: string
  url: string
}

/**
 * The operator notification HTML. Table-based layout, inline styles only,
 * every dynamic field through escapeHtml() — same rules
 * `_shared/email.ts`'s header states and notify-feedback already follows.
 */
export function buildEmbedRequestEmailHtml({ row, cfg, snippet, url }: BuildEmbedRequestEmailArgs): string {
  const c = THEME.colors
  const f = THEME.fonts

  const { href, label } = linkifyWebsite(row.website)
  const websiteCell = href
    ? `<a href="${escapeHtml(href)}" style="color:${c.primary};word-break:break-all;">${escapeHtml(label)}</a>`
    : escapeHtml(label)

  const configRows = describeConfig(cfg)
    .map((line) => `<li style="margin:0 0 4px;">${escapeHtml(line)}</li>`)
    .join('')

  const noteBlock = row.note
    ? `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid ${c.border};">
      <div style="color:${c.textMuted};font-size:12px;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:6px;">Their note</div>
      <div style="color:${c.textPrimary};font-size:14px;line-height:1.5;white-space:pre-wrap;">${escapeAndPreserveBreaks(row.note)}</div>
    </div>`
    : ''

  const content = `
    <p style="font-family:${f.display};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${c.primary};margin:0 0 8px;">
      ${THEME.brandName} &middot; embed request
    </p>
    <h1 style="font-family:${f.display};font-size:20px;color:${c.textPrimary};margin:0 0 14px;line-height:1.3;">
      Embed request from ${escapeHtml(row.organization)}
    </h1>

    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:18px;">
      <tr>
        <td style="padding:6px 0;color:${c.textMuted};width:90px;vertical-align:top;">Name</td>
        <td style="padding:6px 0;color:${c.textPrimary};">${escapeHtml(row.name)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:${c.textMuted};vertical-align:top;">Email</td>
        <td style="padding:6px 0;color:${c.textPrimary};"><a href="mailto:${escapeHtml(row.email)}" style="color:${c.primary};">${escapeHtml(row.email)}</a></td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:${c.textMuted};vertical-align:top;">Site</td>
        <td style="padding:6px 0;color:${c.textPrimary};word-break:break-all;">${websiteCell}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:${c.textMuted};vertical-align:top;">Submitted</td>
        <td style="padding:6px 0;color:${c.textPrimary};">${escapeHtml(fmtDateTime(new Date(row.created_at)))}</td>
      </tr>
    </table>

    <div style="background:${c.background};border:1px solid ${c.border};border-radius:10px;padding:16px 18px;margin-bottom:18px;">
      <div style="color:${c.textMuted};font-size:12px;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:8px;">What they configured</div>
      <ul style="margin:0;padding-left:18px;color:${c.textPrimary};font-size:14px;line-height:1.5;">
        ${configRows}
      </ul>
      ${noteBlock}
    </div>

    <p style="color:${c.textSecondary};font-size:13px;margin:0 0 8px;">Embed URL</p>
    <p style="color:${c.textPrimary};font-size:13px;word-break:break-all;margin:0 0 18px;">
      <a href="${escapeHtml(url)}" style="color:${c.primary};">${escapeHtml(url)}</a>
    </p>

    <p style="color:${c.textSecondary};font-size:13px;margin:0 0 8px;">Ready-to-paste snippet</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
      <tr>
        <td style="background:${c.dark};border-radius:10px;padding:14px 16px;">
          <pre style="margin:0;color:${c.white};font-family:Menlo,Consolas,'Courier New',monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;">${escapeHtml(snippet)}</pre>
        </td>
      </tr>
    </table>

    ${button(`mailto:${escapeHtml(row.email)}`, `Reply to ${escapeHtml(row.name)}`)}

    <p style="color:${c.textMuted};font-size:12px;margin:20px 0 0;line-height:1.5;">
      Sent because this address is set as <code>ADMIN_NOTIFY_EMAIL</code> for ${THEME.brandName}. This request came from the embed builder's request form and was not verified for identity or accuracy.
    </p>
  `

  return renderEmailShell({
    // escapeHtml even though this lands inside a `display:none` div — it is
    // still real HTML the mail client's DOM parses (just visually hidden),
    // so it is not exempt from this feature's "every untrusted field gets
    // escaped" rule regardless of what any other function in this codebase
    // currently does with its own preheader text.
    preheader: `Embed request from ${escapeHtml(row.organization)}`,
    content,
    footer: {
      transactionalNote: `Sent because this address is set as ADMIN_NOTIFY_EMAIL for ${THEME.brandName}.`,
    },
  })
}

/**
 * Plain-text alternative — by far the most reliable way to copy a clean
 * snippet on a phone. notify-feedback sends HTML only; this function is
 * this feature's addition to that pattern.
 */
export function buildEmbedRequestEmailText({ row, cfg, snippet, url }: BuildEmbedRequestEmailArgs): string {
  const { label } = linkifyWebsite(row.website)
  const lines: string[] = [
    `Embed request from ${row.organization}`,
    '',
    `Name: ${row.name}`,
    `Email: ${row.email}`,
    `Site: ${label}`,
    `Submitted: ${fmtDateTime(new Date(row.created_at))}`,
    '',
    'What they configured:',
    ...describeConfig(cfg).map((line) => `- ${line}`),
  ]

  if (row.note) {
    lines.push('', "Their note:", row.note)
  }

  lines.push('', `Embed URL: ${url}`, '', 'Snippet:', snippet, '', `Reply to ${row.name}: mailto:${row.email}`)

  return lines.join('\n')
}
