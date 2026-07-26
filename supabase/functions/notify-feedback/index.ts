// notify-feedback — operator notification for feedback-orb submissions.
//
// POST-only. Body: { body: string, page_path?: string }
//
// Fired from FeedbackOrb.tsx immediately after a successful insert into
// feedback_posts. Unlike notify-pending-event (which is handed an event_id
// and re-reads the row with the service role), this function never gets an
// id to look up: the orb's insert is fire-and-forget and never reads the row
// back (see FeedbackOrb.tsx's insert comment — orb rows are is_private=true,
// so anon can't SELECT them either, and the frontend has no service-role
// access to do a privileged read). So the payload carries the note content
// directly instead of a row reference, and this function does no DB read —
// it renders straight from the POST body.
//
// One consequence: this function has no reliable way to confirm the row it's
// notifying about actually made it into the table (the insert and this call
// are two independent fire-and-forget requests from the client). That's an
// accepted tradeoff for a low-stakes internal notification — worst case is a
// notification for a row that failed to insert, which is rare and harmless.
//
// Recipients come from the same ADMIN_NOTIFY_EMAIL env var as
// notify-pending-event and preferences, so one secret controls every
// operator notification stream. Unset = skip sending, still return 200 (the
// orb's insert already succeeded; a missing notify config is not a client
// error).
//
// No publish links, no HMAC tokens — this function only sends mail.

import { Resend } from 'https://esm.sh/resend@4'
import { THEME, escapeHtml, button, renderEmailShell } from '../_shared/email.ts'

const resend = new Resend(Deno.env.get('RESEND_API_KEY')!)

// Cold-start env audit. Same pattern as notify-pending-event / preferences —
// surface missing secrets in the logs instead of debugging a silent failure
// later.
console.log('[notify-feedback] cold start', {
  has_RESEND_API_KEY:     !!Deno.env.get('RESEND_API_KEY'),
  has_ADMIN_NOTIFY_EMAIL: !!Deno.env.get('ADMIN_NOTIFY_EMAIL'),
  PUBLIC_SITE_URL:        Deno.env.get('PUBLIC_SITE_URL') || '(default)',
})

const BASE_URL = Deno.env.get('PUBLIC_SITE_URL') || 'https://akronpulse.com'

// Comma-separated list of operator recipients. Reuses the same env var the
// other operator-notification functions use so a single secret controls
// every stream. Unset = we still return 200 (the client-side insert already
// succeeded); we just never fire the email.
const ADMIN_NOTIFY_EMAIL = (Deno.env.get('ADMIN_NOTIFY_EMAIL') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// Mirrors the DB CHECK constraint in migration 043
// (`char_length(body) between 1 and 1000`) and MAX_LEN in
// src/lib/feedbackOrb.ts. This function can't import that frontend module
// (different Deno/bundler runtime), so the limit is duplicated here as a
// last-line defense: even if some future caller sends a longer string, the
// rendered email never carries more than what the DB itself would accept.
const FEEDBACK_BODY_MAX_LEN = 1000

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

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

// HTML-escape then turn newlines into <br> so line breaks in the note
// survive in an HTML email. escapeHtml() runs first so a literal "<br>"
// typed by the submitter can never smuggle a real tag through — only the
// breaks *we* insert afterward are real markup.
function escapeAndPreserveBreaks(s: string): string {
  return escapeHtml(s).replace(/\r\n|\r|\n/g, '<br>')
}

interface FeedbackPayload {
  body: string
  page_path?: string
}

function buildNotificationHtml(body: string, pagePath: string | null, submittedAt: Date): string {
  const c = THEME.colors
  const f = THEME.fonts

  const capped = body.length > FEEDBACK_BODY_MAX_LEN
    ? body.slice(0, FEEDBACK_BODY_MAX_LEN)
    : body

  const pageUrl = pagePath ? `${BASE_URL}${pagePath}` : null
  const adminUrl = `${BASE_URL}/admin/feedback`

  const content = `
    <p style="font-family:${f.display};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${c.primary};margin:0 0 8px;">
      ${THEME.brandName} &middot; feedback
    </p>
    <h1 style="font-family:${f.display};font-size:20px;color:${c.textPrimary};margin:0 0 14px;line-height:1.3;">
      New feedback from akronpulse.com
    </h1>

    <div style="background:${c.background};border:1px solid ${c.border};border-radius:10px;padding:16px 18px;margin-bottom:18px;">
      <div style="color:${c.textPrimary};font-size:15px;line-height:1.6;white-space:pre-wrap;">${escapeAndPreserveBreaks(capped)}</div>
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:22px;">
      <tr>
        <td style="padding:6px 0;color:${c.textMuted};width:90px;vertical-align:top;">Page</td>
        <td style="padding:6px 0;color:${c.textPrimary};">
          ${pageUrl
            ? `<a href="${escapeHtml(pageUrl)}" style="color:${c.primary};word-break:break-all;">${escapeHtml(pagePath!)}</a>`
            : 'Unknown'}
        </td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:${c.textMuted};vertical-align:top;">Sent</td>
        <td style="padding:6px 0;color:${c.textPrimary};">${escapeHtml(fmtDateTime(submittedAt))}</td>
      </tr>
    </table>

    ${button(adminUrl, 'View all feedback')}

    <p style="color:${c.textMuted};font-size:12px;margin:20px 0 0;line-height:1.5;">
      Sent because this address is set as <code>ADMIN_NOTIFY_EMAIL</code> for ${THEME.brandName}. This note came from the site's feedback widget and was not verified for identity or accuracy.
    </p>
  `

  return renderEmailShell({
    preheader: capped.slice(0, 110),
    content,
    footer: {
      transactionalNote: `Sent because this address is set as ADMIN_NOTIFY_EMAIL for ${THEME.brandName}.`,
    },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    const payload = (await req.json().catch(() => null)) as FeedbackPayload | null
    const rawBody = payload?.body
    if (!rawBody || typeof rawBody !== 'string' || !rawBody.trim()) {
      return json({ error: 'body required' }, 400)
    }

    const pagePath = typeof payload?.page_path === 'string' && payload.page_path
      ? payload.page_path
      : null

    if (ADMIN_NOTIFY_EMAIL.length === 0) {
      console.warn('[notify-feedback] ADMIN_NOTIFY_EMAIL not configured; skipping send')
      return json({ ok: true, skipped: 'no operator email configured' })
    }

    const submittedAt = new Date()
    const emailHtml = buildNotificationHtml(rawBody, pagePath, submittedAt)

    const response = await resend.emails.send({
      from: THEME.from,
      to: ADMIN_NOTIFY_EMAIL,
      replyTo: THEME.replyTo,
      subject: `New feedback from akronpulse.com`,
      html: emailHtml,
    })

    if (response.error) {
      console.error('[notify-feedback] email send rejected', {
        to: ADMIN_NOTIFY_EMAIL,
        error: response.error,
      })
      return json({ error: 'Email send failed' }, 502)
    }

    console.log('[notify-feedback] sent', {
      to: ADMIN_NOTIFY_EMAIL,
      resend_id: response.data?.id,
    })

    return json({ ok: true, resend_id: response.data?.id })
  } catch (err) {
    console.error('[notify-feedback] fatal', err)
    return json({ error: 'Internal error' }, 500)
  }
})
