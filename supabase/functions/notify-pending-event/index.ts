// notify-pending-event — operator notification + one-click publish for
// user-submitted events.
//
// Two endpoints, same function (single deploy):
//
//   POST /
//     Body: { event_id, organizer_name?, organizer_email?,
//             venue_name?, venue_address? }
//     Fired from SubmitPage.jsx immediately after a successful insert
//     of a manual, pending_review event. Looks up the row, renders an
//     operator email with the full event detail + a "Publish now"
//     button (HMAC-signed URL) and a deep link to the admin edit page,
//     and sends via Resend.
//
//   GET /?event_id=<uuid>&exp=<unix>&sig=<base64url>
//     Hit when the operator clicks the "Publish now" button in the
//     email. Verifies the HMAC, checks expiry, and flips status from
//     pending_review → published. Returns a tiny HTML confirmation
//     page so the operator sees feedback in the browser. Idempotent:
//     replaying a token does NOT republish — the SQL is constrained to
//     rows still in pending_review, and we render a friendly "already
//     published" page in that case.
//
// Why one-click instead of an admin-edit deep link only? The whole
// goal is for the operator (currently a single human) to clear
// submissions in seconds from their phone. A signed URL is unforgeable,
// time-bound (PUBLISH_TOKEN_TTL_HOURS), and scoped to a single event,
// which is the safe minimum bar for a publish-without-login path. The
// admin edit deep link is still in the email as a secondary CTA when
// the operator needs to inspect or edit before approving.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resend } from 'https://esm.sh/resend@4'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)
const resend = new Resend(Deno.env.get('RESEND_API_KEY')!)

// Cold-start env audit. Same pattern as the subscribe / preferences
// functions — surface missing secrets in the logs instead of debugging
// a silent failure later.
console.log('[notify-pending-event] cold start', {
  has_SUPABASE_URL:              !!Deno.env.get('SUPABASE_URL'),
  has_SUPABASE_SERVICE_ROLE_KEY: !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  has_RESEND_API_KEY:            !!Deno.env.get('RESEND_API_KEY'),
  has_ADMIN_NOTIFY_EMAIL:        !!Deno.env.get('ADMIN_NOTIFY_EMAIL'),
  has_PUBLISH_TOKEN_SECRET:      !!Deno.env.get('PUBLISH_TOKEN_SECRET'),
  PUBLIC_SITE_URL:               Deno.env.get('PUBLIC_SITE_URL') || '(default)',
})

const BASE_URL = Deno.env.get('PUBLIC_SITE_URL') || 'https://akronpulse.com'

// Comma-separated list of operator recipients. Reuses the same env
// var the preferences function uses for new-subscriber notifications
// so a single secret controls both operator email streams. Unset =
// the function still publishes correctly via the GET path; it just
// never fires the notification email.
const ADMIN_NOTIFY_EMAIL = (Deno.env.get('ADMIN_NOTIFY_EMAIL') || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// HMAC secret used to sign the one-click publish URL. Must be a
// strong random string (>= 32 bytes recommended). If unset we refuse
// to send the email — better to noisy-fail than ship an unsigned
// publish link.
const PUBLISH_TOKEN_SECRET = Deno.env.get('PUBLISH_TOKEN_SECRET') || ''

// One-click link lifetime. 7 days is comfortably longer than the
// "usually within 24 hours" promise on SubmitPage; if a submission
// sits longer than that the operator can still publish from /admin.
const PUBLISH_TOKEN_TTL_HOURS = Number(
  Deno.env.get('PUBLISH_TOKEN_TTL_HOURS') || '168',
)

// Brand theme — mirrors the other functions so an operator email is
// visually consistent with subscriber-facing mail. Update all three
// (subscribe / preferences / notify-pending-event) together if the
// palette ever shifts.
const THEME = {
  brandName: 'Akron Pulse',
  from: Deno.env.get('RESEND_FROM') || 'Akron Pulse <digest@akronpulse.com>',
  replyTo: Deno.env.get('RESEND_REPLY_TO') || 'byron@akronpulse.com',
  colors: {
    primary:       '#0E5163',
    background:    '#FCFAF4',
    card:          '#FFFFFF',
    dark:          '#0A3B48',
    textPrimary:   '#1F2A30',
    textSecondary: '#3E5560',
    textMuted:     '#5F7886',
    border:        '#DAD5C8',
    accent:        '#1A5428',
    accentBg:      '#E4F0E6',
    white:         '#FFFFFF',
  },
  fonts: {
    display: "'Space Grotesk', system-ui, sans-serif",
    body:    "'DM Sans', system-ui, sans-serif",
  },
} as const

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── HMAC helpers ────────────────────────────────────────────────
//
// Signed payload = `<event_id>.<exp>` where exp is unix-seconds.
// Putting exp inside the signed payload (not just the URL) means a
// tampered exp invalidates the signature, so we don't need to trust
// the URL's exp at all — we just recompute the HMAC.

function base64urlEncode(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes))
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Returns Uint8Array<ArrayBuffer> (not the default Uint8Array<ArrayBufferLike>)
// so the result satisfies BufferSource at the crypto.subtle.verify call below.
// The array really is ArrayBuffer-backed — `new Uint8Array(len)` always is —
// so this narrows the type to the truth rather than casting past it.
function base64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

async function signPublishToken(eventId: string, expUnix: number): Promise<string> {
  if (!PUBLISH_TOKEN_SECRET) {
    throw new Error('PUBLISH_TOKEN_SECRET not configured')
  }
  const key = await importHmacKey(PUBLISH_TOKEN_SECRET)
  const payload = `${eventId}.${expUnix}`
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return base64urlEncode(new Uint8Array(sig))
}

async function verifyPublishToken(eventId: string, expUnix: number, token: string): Promise<boolean> {
  if (!PUBLISH_TOKEN_SECRET) return false
  try {
    const key = await importHmacKey(PUBLISH_TOKEN_SECRET)
    const payload = `${eventId}.${expUnix}`
    const sig = base64urlDecode(token)
    return await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(payload))
  } catch (err) {
    console.error('[notify-pending-event] verify error', err)
    return false
  }
}

// ── Helpers ────────────────────────────────────────────────────

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
    })
  } catch {
    return iso
  }
}

function priceLabel(min: number | null, max: number | null): string {
  if (min == null && max == null) return '—'
  if ((min == null || min === 0) && (!max || max === 0)) return 'Free'
  if (max && max > (min ?? 0)) return `$${min}–$${max}`
  if (min != null) return `$${min}`
  return '—'
}

function functionsBaseUrl(): string {
  // Edge functions are served at `${SUPABASE_URL}/functions/v1/<name>`.
  // We build the publish URL off this so a project move (URL change)
  // takes effect via secret rotation, not a code change.
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/notify-pending-event`
}

// ── Email template ─────────────────────────────────────────────

interface EventRow {
  id: string
  title: string
  description: string | null
  start_at: string
  end_at: string | null
  event_categories?: { category: string }[]
  tags: string[] | null
  price_min: number | null
  price_max: number | null
  age_restriction: string
  ticket_url: string | null
  source: string
  status: string
}

interface SubmitterContext {
  organizer_name?: string | null
  organizer_email?: string | null
  venue_name?: string | null
  venue_address?: string | null
}

function buildNotificationHtml(
  event: EventRow,
  ctx: SubmitterContext,
  publishUrl: string,
  adminEditUrl: string,
): string {
  const c = THEME.colors
  const f = THEME.fonts

  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: 'Title',       value: escapeHtml(event.title) },
    { label: 'Categories',  value: escapeHtml((event.event_categories ?? []).map((ec) => ec.category).join(', ') || '—') },
    { label: 'Starts',      value: escapeHtml(fmtDateTime(event.start_at)) },
  ]
  if (event.end_at) rows.push({ label: 'Ends', value: escapeHtml(fmtDateTime(event.end_at)) })

  const venueLine = [ctx.venue_name, ctx.venue_address].filter(Boolean).join(' — ')
  if (venueLine) rows.push({ label: 'Venue', value: escapeHtml(venueLine) })

  rows.push({ label: 'Price', value: escapeHtml(priceLabel(event.price_min, event.price_max)) })
  if (event.age_restriction && event.age_restriction !== 'not_specified') {
    rows.push({ label: 'Age',  value: escapeHtml(event.age_restriction) })
  }
  if (event.tags && event.tags.length > 0) {
    rows.push({ label: 'Tags', value: escapeHtml(event.tags.join(', ')) })
  }
  if (event.ticket_url) {
    rows.push({
      label: 'Ticket / RSVP',
      value: `<a href="${escapeHtml(event.ticket_url)}" style="color:${c.primary};word-break:break-all;">${escapeHtml(event.ticket_url)}</a>`,
      mono: true,
    })
  }

  // Submitter contact (stored in DB) is intentionally outside the
  // event row — these fields ride along on the function call from
  // SubmitPage so the operator has a way to reach the submitter
  // without us persisting PII in the events table.
  if (ctx.organizer_name)  rows.push({ label: 'Submitted by', value: escapeHtml(ctx.organizer_name) })
  if (ctx.organizer_email) {
    rows.push({
      label: 'Contact',
      value: `<a href="mailto:${escapeHtml(ctx.organizer_email)}" style="color:${c.primary};">${escapeHtml(ctx.organizer_email)}</a>`,
    })
  }

  const description = event.description?.trim()

  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:${c.background};font-family:${f.body};">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;">

  <p style="font-family:${f.display};font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${c.primary};margin:0 0 8px;">
    ${THEME.brandName} · pending review
  </p>
  <h1 style="font-family:${f.display};font-size:1.35rem;color:${c.textPrimary};margin:0 0 6px;line-height:1.25;">
    New event submission
  </h1>
  <p style="color:${c.textSecondary};font-size:0.92rem;margin:0 0 24px;">
    A visitor submitted an event for review. Verify the details and publish, or open it in admin to edit first.
  </p>

  <div style="background:${c.card};border:1px solid ${c.border};border-radius:12px;padding:20px 22px;margin-bottom:24px;">
    <table style="width:100%;border-collapse:collapse;font-size:0.92rem;">
      ${rows.map(r => `
      <tr>
        <td style="padding:7px 0;color:${c.textMuted};width:120px;vertical-align:top;">${r.label}</td>
        <td style="padding:7px 0;color:${c.textPrimary};${r.mono ? `font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.85rem;` : ''}">${r.value}</td>
      </tr>`).join('')}
    </table>
    ${description ? `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid ${c.border};">
      <div style="color:${c.textMuted};font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:6px;">Description</div>
      <div style="color:${c.textPrimary};font-size:0.92rem;line-height:1.5;white-space:pre-wrap;">${escapeHtml(description)}</div>
    </div>` : ''}
  </div>

  <div style="text-align:center;margin:28px 0 14px;">
    <a href="${escapeHtml(publishUrl)}" style="display:inline-block;padding:14px 32px;background:${c.primary};color:${c.white};text-decoration:none;border-radius:10px;font-family:${f.display};font-size:0.95rem;font-weight:700;letter-spacing:0.01em;">
      Publish now &rarr;
    </a>
  </div>
  <p style="text-align:center;color:${c.textMuted};font-size:0.78rem;margin:0 0 24px;">
    One-click. Link expires in ${PUBLISH_TOKEN_TTL_HOURS} hours.
  </p>

  <div style="text-align:center;margin:0 0 32px;">
    <a href="${escapeHtml(adminEditUrl)}" style="color:${c.primary};font-size:0.88rem;font-weight:600;text-decoration:underline;text-underline-offset:2px;">
      Review in admin first &rarr;
    </a>
  </div>

  <div style="border-top:1px solid ${c.border};padding-top:16px;color:${c.textMuted};font-size:0.74rem;line-height:1.55;">
    Sent because this address is set as <code>ADMIN_NOTIFY_EMAIL</code> for ${THEME.brandName}. The one-click link is HMAC-signed and bound to event <code>${escapeHtml(event.id)}</code> only — anyone with the link can publish this single event until it expires.
  </div>

</div>
</body></html>`
}

// Tiny HTML pages returned by the GET handler. Plain inline styles
// so this works in any browser including operator phones.
function renderResultPage(opts: {
  title: string
  heading: string
  message: string
  href?: string
  hrefLabel?: string
  variant?: 'success' | 'info' | 'error'
}): string {
  const c = THEME.colors
  const f = THEME.fonts
  const accent =
    opts.variant === 'error'   ? '#B0413E' :
    opts.variant === 'info'    ? c.primary :
                                 c.accent
  return `
<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:${c.background};font-family:${f.body};min-height:100vh;display:flex;align-items:center;justify-content:center;">
  <div style="max-width:480px;margin:0 auto;padding:48px 24px;text-align:center;">
    <div style="font-family:${f.display};font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${accent};margin-bottom:14px;">${THEME.brandName}</div>
    <h1 style="font-family:${f.display};font-size:1.5rem;color:${c.textPrimary};margin:0 0 12px;">${escapeHtml(opts.heading)}</h1>
    <p style="color:${c.textSecondary};font-size:1rem;line-height:1.55;margin:0 0 24px;">${escapeHtml(opts.message)}</p>
    ${opts.href ? `
    <a href="${escapeHtml(opts.href)}" style="display:inline-block;padding:12px 28px;background:${c.primary};color:${c.white};text-decoration:none;border-radius:10px;font-family:${f.display};font-size:0.9rem;font-weight:700;">${escapeHtml(opts.hrefLabel || 'Continue')}</a>` : ''}
  </div>
</body></html>`
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
  })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// ── Main handler ──────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    if (req.method === 'GET') {
      return await handlePublishClick(req)
    }
    if (req.method === 'POST') {
      return await handleNotify(req)
    }
    return json({ error: 'Method not allowed' }, 405)
  } catch (err) {
    console.error('[notify-pending-event] fatal', err)
    return json({ error: 'Internal error' }, 500)
  }
})

// ── POST: send operator email ─────────────────────────────────

async function handleNotify(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null)
  const eventId = body?.event_id
  if (!eventId || typeof eventId !== 'string') {
    return json({ error: 'event_id required' }, 400)
  }

  // Fetch the event. Service role bypasses RLS so a pending_review row
  // is readable here even when the public anon read policy excludes it.
  const { data: event, error: fetchErr } = await supabase
    .from('events')
    .select('id, title, description, start_at, end_at, tags, price_min, price_max, age_restriction, ticket_url, source, status, event_categories(category)')
    .eq('id', eventId)
    .single()

  if (fetchErr || !event) {
    console.error('[notify-pending-event] event not found', { eventId, fetchErr })
    return json({ error: 'Event not found' }, 404)
  }

  // We only notify for genuine user submissions. Anything else is
  // either a scraped row (the admin's review queue already covers
  // those) or an already-published row (no work to do). This is a
  // defense-in-depth check — SubmitPage is the only documented
  // caller, but the function URL is reachable from anywhere so we
  // refuse to broadcast on rows that don't look like submissions.
  if (event.source !== 'manual' || event.status !== 'pending_review') {
    console.log('[notify-pending-event] skipping non-manual or non-pending row', {
      eventId, source: event.source, status: event.status,
    })
    return json({ ok: true, skipped: 'not a manual pending submission' })
  }

  if (ADMIN_NOTIFY_EMAIL.length === 0) {
    console.warn('[notify-pending-event] ADMIN_NOTIFY_EMAIL not configured; skipping send')
    return json({ ok: true, skipped: 'no operator email configured' })
  }
  if (!PUBLISH_TOKEN_SECRET) {
    console.error('[notify-pending-event] PUBLISH_TOKEN_SECRET not configured; refusing to send')
    return json({ error: 'PUBLISH_TOKEN_SECRET not configured' }, 500)
  }

  const expUnix = Math.floor(Date.now() / 1000) + PUBLISH_TOKEN_TTL_HOURS * 3600
  const token = await signPublishToken(event.id, expUnix)
  const publishUrl = `${functionsBaseUrl()}?event_id=${encodeURIComponent(event.id)}&exp=${expUnix}&sig=${encodeURIComponent(token)}`
  const adminEditUrl = `${BASE_URL}/admin/events/${event.id}/edit`

  const ctx: SubmitterContext = {
    organizer_name:  typeof body?.organizer_name  === 'string' ? body.organizer_name  : null,
    organizer_email: typeof body?.organizer_email === 'string' ? body.organizer_email : null,
    venue_name:      typeof body?.venue_name      === 'string' ? body.venue_name      : null,
    venue_address:   typeof body?.venue_address   === 'string' ? body.venue_address   : null,
  }

  const emailHtml = buildNotificationHtml(event as EventRow, ctx, publishUrl, adminEditUrl)
  const subject = `[${THEME.brandName}] Submission needs review: ${event.title}`

  const response = await resend.emails.send({
    from: THEME.from,
    to: ADMIN_NOTIFY_EMAIL,
    // replyTo (camelCase) is the Resend SDK's field name; it maps this to
    // the API's `reply_to` on the wire. Passing snake_case here is NOT an
    // alias — the SDK ignores unknown keys, so the header is dropped
    // silently and replies fall back to `from`. That's what happened here:
    // "reply to the organizer" was landing back on digest@ instead.
    replyTo: ctx.organizer_email || THEME.replyTo,
    subject,
    html: emailHtml,
  })

  if (response.error) {
    console.error('[notify-pending-event] email send rejected', {
      to: ADMIN_NOTIFY_EMAIL,
      error: response.error,
    })
    return json({ error: 'Email send failed' }, 502)
  }

  console.log('[notify-pending-event] sent', {
    event_id: event.id,
    to: ADMIN_NOTIFY_EMAIL,
    resend_id: response.data?.id,
  })

  return json({ ok: true, resend_id: response.data?.id })
}

// ── GET: verify token + publish ───────────────────────────────

async function handlePublishClick(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const eventId = url.searchParams.get('event_id')
  const expStr  = url.searchParams.get('exp')
  const sig     = url.searchParams.get('sig')

  if (!eventId || !expStr || !sig) {
    return html(renderResultPage({
      title: 'Invalid link',
      heading: 'Invalid publish link',
      message: 'This link is missing required parameters. Use the button in the original notification email, or publish from the admin dashboard.',
      href: `${BASE_URL}/admin/events`,
      hrefLabel: 'Open admin',
      variant: 'error',
    }), 400)
  }

  const exp = Number(expStr)
  if (!Number.isFinite(exp)) {
    return html(renderResultPage({
      title: 'Invalid link',
      heading: 'Invalid publish link',
      message: 'The expiration on this link is malformed.',
      variant: 'error',
    }), 400)
  }

  const nowUnix = Math.floor(Date.now() / 1000)
  if (exp < nowUnix) {
    return html(renderResultPage({
      title: 'Link expired',
      heading: 'This publish link expired',
      message: `One-click publish links are valid for ${PUBLISH_TOKEN_TTL_HOURS} hours. Open the event in the admin dashboard to publish it manually.`,
      href: `${BASE_URL}/admin/events/${encodeURIComponent(eventId)}/edit`,
      hrefLabel: 'Open in admin',
      variant: 'info',
    }), 410)
  }

  const valid = await verifyPublishToken(eventId, exp, sig)
  if (!valid) {
    return html(renderResultPage({
      title: 'Invalid signature',
      heading: 'Could not verify this link',
      message: 'The signature on this publish link is invalid. Use the original notification email or publish from the admin dashboard.',
      href: `${BASE_URL}/admin/events`,
      hrefLabel: 'Open admin',
      variant: 'error',
    }), 401)
  }

  // Idempotent publish: only flip rows still in pending_review. If
  // the row was already published (replayed token, or operator
  // already approved via admin), the update simply matches zero rows
  // and we render an "already published" page.
  const { data: updated, error: updateErr } = await supabase
    .from('events')
    .update({ status: 'published' })
    .eq('id', eventId)
    .eq('status', 'pending_review')
    .select('id, title')
    .maybeSingle()

  if (updateErr) {
    console.error('[notify-pending-event] publish update error', updateErr)
    return html(renderResultPage({
      title: 'Error',
      heading: 'Could not publish',
      message: 'The database refused the update. Try publishing from the admin dashboard.',
      href: `${BASE_URL}/admin/events/${encodeURIComponent(eventId)}/edit`,
      hrefLabel: 'Open in admin',
      variant: 'error',
    }), 500)
  }

  if (!updated) {
    // Either the row no longer exists or it's already past pending_review.
    const { data: existing } = await supabase
      .from('events')
      .select('id, title, status')
      .eq('id', eventId)
      .maybeSingle()

    if (!existing) {
      return html(renderResultPage({
        title: 'Not found',
        heading: 'Event not found',
        message: 'This event no longer exists. It may have been deleted.',
        href: `${BASE_URL}/admin/events`,
        hrefLabel: 'Open admin',
        variant: 'error',
      }), 404)
    }

    return html(renderResultPage({
      title: 'Already published',
      heading: 'Already taken care of',
      message: `“${existing.title}” is currently in ${existing.status}. No further action needed.`,
      href: `${BASE_URL}/events/${encodeURIComponent(eventId)}`,
      hrefLabel: 'View on site',
      variant: 'info',
    }), 200)
  }

  console.log('[notify-pending-event] published via one-click', { event_id: eventId })

  return html(renderResultPage({
    title: 'Published',
    heading: 'Published',
    message: `“${updated.title}” is now live on Akron Pulse.`,
    href: `${BASE_URL}/events/${encodeURIComponent(eventId)}`,
    hrefLabel: 'View on site',
    variant: 'success',
  }), 200)
}
