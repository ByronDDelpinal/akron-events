// notify-embed-request — operator notification (email + Slack) for
// "request an embed" submissions from /embed-builder.
//
// POST-only. Body: { request_id: uuid }
//
// Deployed WITH JWT verification (default) — unlike slack-notify, this is
// called from the browser via supabase.functions.invoke(), which attaches
// the anon JWT, same as notify-feedback.
//
// Fired fire-and-forget from EmbedRequestForm.tsx AFTER a successful anon
// insert into embed_requests (no .select() on that insert — there is no
// anon SELECT policy on the table, so a readback would return zero rows;
// the client generates the row's id itself with crypto.randomUUID() and
// hands it to this function instead). A notifier failure must never surface
// to the visitor — the row is already saved regardless of what happens here.
//
// Protocol (docs/embed-request-capture.md §4.2):
//   1. Validate request_id is a UUID shape, else 400.
//   2. Re-read the row (service role, hardcoded column allowlist).
//   3. Derive embed_path from the row's config (normalizeConfig + buildEmbedPath).
//   4. CLAIM: UPDATE ... SET notified_at = now(), embed_path = $path
//        WHERE id = $1 AND notified_at IS NULL RETURNING id.
//      Zero rows back -> some earlier call already claimed this row (a
//      replayed invoke) -> { ok:true, skipped:'duplicate' }, no send.
//   5. Send the operator email via Resend. On failure: RELEASE the claim
//      (set notified_at/embed_path back to null) and return 502 so a retry
//      can work. Log loudly.
//   6. POST slack-notify with X-Slack-Notify-Secret and { event:
//      'embed_request', id }. AWAITED but failure-tolerant: log, never fail
//      the response — the email already went, which is the delivery that
//      matters.
//
// ADMIN_NOTIFY_EMAIL unset: log a warning, RELEASE the claim (so a later
// deploy with the secret set can still notify), still return 200 — the
// row is already saved; a missing notify config is not a client error.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resend } from 'https://esm.sh/resend@4'
import { THEME } from '../_shared/email.ts'
import { normalizeConfig, buildEmbedPath, buildEmbedUrl, buildIframeSnippet } from '../_shared/embedSnippet.ts'
import { sanitizeSubjectPart, buildEmbedRequestEmailHtml, buildEmbedRequestEmailText, type EmbedRequestEmailRow } from './email.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)
const resend = new Resend(Deno.env.get('RESEND_API_KEY')!)

// Cold-start env audit. Same pattern as notify-feedback / notify-pending-event.
console.log('[notify-embed-request] cold start', {
  has_SUPABASE_URL:              !!Deno.env.get('SUPABASE_URL'),
  has_SUPABASE_SERVICE_ROLE_KEY: !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  has_RESEND_API_KEY:            !!Deno.env.get('RESEND_API_KEY'),
  has_ADMIN_NOTIFY_EMAIL:        !!Deno.env.get('ADMIN_NOTIFY_EMAIL'),
  has_SLACK_NOTIFY_SECRET:       !!Deno.env.get('SLACK_NOTIFY_SECRET'),
  PUBLIC_SITE_URL:               Deno.env.get('PUBLIC_SITE_URL') || '(default)',
})

// Server constant for the embed URL's origin. NEVER derived from client
// input or a request header (see _shared/embedSnippet.ts's buildIframeSnippet
// docstring for why: a Host-header-derived origin would let a caller rewrite
// the script src in the maintainer's own email).
const BASE_URL = Deno.env.get('PUBLIC_SITE_URL') || 'https://akronpulse.com'

// Same env var every other operator-notification function uses — one
// secret controls every stream. Unset = we still return 200 (the client's
// insert already succeeded); we just never fire the email, and we release
// the claim so a later deploy with the secret set can still notify.
const ADMIN_NOTIFY_EMAIL = (Deno.env.get('ADMIN_NOTIFY_EMAIL') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// Project-wide secret slack-notify's DB triggers already use — this
// function needs no secret of its own to call slack-notify (D2: no new
// secret is needed for this integration beyond the channel id below).
const SLACK_NOTIFY_SECRET = Deno.env.get('SLACK_NOTIFY_SECRET') || ''

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

function functionsBaseUrl(name: string): string {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/${name}`
}

/** Best-effort release of a claim this function itself just took — never throws. */
async function releaseClaim(id: string): Promise<void> {
  const { error } = await supabase
    .from('embed_requests')
    .update({ notified_at: null, embed_path: null })
    .eq('id', id)
  if (error) {
    console.error('[notify-embed-request] failed to release claim', { id, error })
  }
}

/**
 * Fire-and-forget-but-awaited call into slack-notify. Failure is logged and
 * swallowed — the email already sent, which is the delivery that matters
 * (docs/embed-request-capture.md §4.2 step f).
 */
async function notifySlack(id: string): Promise<void> {
  if (!SLACK_NOTIFY_SECRET) {
    console.warn('[notify-embed-request] SLACK_NOTIFY_SECRET not configured; skipping Slack notification')
    return
  }
  try {
    const res = await fetch(functionsBaseUrl('slack-notify'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Notify-Secret': SLACK_NOTIFY_SECRET,
      },
      body: JSON.stringify({ event: 'embed_request', id }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      console.error('[notify-embed-request] slack-notify call failed', { id, status: res.status, body })
    } else {
      console.log('[notify-embed-request] slack-notify call ok', { id, body })
    }
  } catch (err) {
    console.error('[notify-embed-request] slack-notify call threw', { id, err })
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    const body = await req.json().catch(() => null)
    const requestId = body?.request_id
    if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
      return json({ error: 'request_id (uuid) required' }, 400)
    }

    // Re-read the row. Hardcoded column allowlist — never select('*').
    const { data: row, error: fetchErr } = await supabase
      .from('embed_requests')
      .select('id, name, email, organization, website, note, config, notified_at, embed_path, created_at')
      .eq('id', requestId)
      .maybeSingle()

    if (fetchErr) {
      console.error('[notify-embed-request] row fetch failed', { requestId, fetchErr })
      return json({ error: 'Internal error' }, 500)
    }
    if (!row) {
      // A forged or replayed id with no matching row is a logged no-op —
      // see migration 051's comment on this exact property.
      console.log('[notify-embed-request] no matching row', { requestId })
      return json({ ok: true, skipped: 'row not found' })
    }

    const cfg = normalizeConfig(row.config)
    const path = buildEmbedPath(cfg)

    // CLAIM: conditional UPDATE. Zero rows back means some earlier call
    // (a retried/replayed invoke) already claimed this row.
    const { data: claimed, error: claimErr } = await supabase
      .from('embed_requests')
      .update({ notified_at: new Date().toISOString(), embed_path: path })
      .eq('id', requestId)
      .is('notified_at', null)
      .select('id')
      .maybeSingle()

    if (claimErr) {
      console.error('[notify-embed-request] claim failed', { requestId, claimErr })
      return json({ error: 'claim failed' }, 500)
    }
    if (!claimed) {
      console.log('[notify-embed-request] duplicate invoke, already claimed', { requestId })
      return json({ ok: true, skipped: 'duplicate' })
    }

    if (ADMIN_NOTIFY_EMAIL.length === 0) {
      console.warn('[notify-embed-request] ADMIN_NOTIFY_EMAIL not configured; releasing claim and skipping send')
      await releaseClaim(requestId)
      return json({ ok: true, skipped: 'no operator email configured' })
    }

    const url = buildEmbedUrl(BASE_URL, cfg)
    const snippet = buildIframeSnippet(BASE_URL, cfg)
    const emailRow: EmbedRequestEmailRow = {
      name: row.name,
      email: row.email,
      organization: row.organization,
      website: row.website,
      note: row.note,
      created_at: row.created_at,
    }

    const html = buildEmbedRequestEmailHtml({ row: emailRow, cfg, snippet, url })
    const text = buildEmbedRequestEmailText({ row: emailRow, cfg, snippet, url })
    const subject = `Embed request: ${sanitizeSubjectPart(row.organization)}`

    const response = await resend.emails.send({
      from: THEME.from,
      to: ADMIN_NOTIFY_EMAIL,
      // Reply-To deliberately stays THEME.replyTo, NOT the visitor's
      // address — Reply-To is dropped on every email this project sends
      // (see project_replyto_dropped_bug), so relying on it here would
      // silently not work. The visitor's address is instead a
      // `mailto:` button in the body, which is reliable regardless.
      replyTo: THEME.replyTo,
      subject,
      html,
      text,
    })

    if (response.error) {
      console.error('[notify-embed-request] email send rejected', { requestId, to: ADMIN_NOTIFY_EMAIL, error: response.error })
      await releaseClaim(requestId)
      return json({ error: 'Email send failed' }, 502)
    }

    console.log('[notify-embed-request] sent', { requestId, to: ADMIN_NOTIFY_EMAIL, resend_id: response.data?.id })

    // Awaited but failure-tolerant — the email already went, which is the
    // delivery that matters.
    await notifySlack(requestId)

    return json({ ok: true, resend_id: response.data?.id })
  } catch (err) {
    console.error('[notify-embed-request] fatal', err)
    return json({ error: 'Internal error' }, 500)
  }
})
