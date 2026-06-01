// preferences — token-gated read/update of subscriber preferences
// GET  ?token=<uuid>  → returns current preferences (also performs
//                       the unconfirmed→confirmed transition on first
//                       visit via the confirmation link).
// POST { token, preferences, frequency?, lookahead_days?, send_day? }
//
// First-visit confirmation also sends an operator notification email
// (when ADMIN_NOTIFY_EMAIL is set) so the admin learns about real
// opt-ins — not abandoned half-signups. The GET response includes a
// `was_just_confirmed` flag the frontend uses to fire a one-time GA
// event on the confirmation page.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resend } from 'https://esm.sh/resend@4'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)
const resend = new Resend(Deno.env.get('RESEND_API_KEY')!)

console.log('[preferences] cold start', {
  has_SUPABASE_URL:              !!Deno.env.get('SUPABASE_URL'),
  has_SUPABASE_SERVICE_ROLE_KEY: !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  has_RESEND_API_KEY:            !!Deno.env.get('RESEND_API_KEY'),
  has_ADMIN_NOTIFY_EMAIL:        !!Deno.env.get('ADMIN_NOTIFY_EMAIL'),
})

// Comma-separated list of recipients for the operator notification
// fired on first-visit confirmation. Unset = no admin email (silent).
const ADMIN_NOTIFY_EMAIL = (Deno.env.get('ADMIN_NOTIFY_EMAIL') || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// Brand theme — kept minimal here since the operator notification is
// the only thing this function emails. If we ever send user-facing
// mail from preferences, lift these into a shared module.
const THEME = {
  brandName: 'Akron Pulse',
  from: Deno.env.get('RESEND_FROM') || 'Akron Pulse <digest@akronpulse.com>',
  colors: {
    primary:       '#0E5163',
    textPrimary:   '#1F2A30',
    textMuted:     '#5F7886',
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    // ── GET: read preferences ──
    if (req.method === 'GET') {
      const url = new URL(req.url)
      const token = url.searchParams.get('token')

      if (!token) return json({ error: 'Token required' }, 400)

      const { data: sub, error } = await supabase
        .from('subscribers')
        .select('id, email, preferences, frequency, lookahead_days, send_day, confirmed, created_at')
        .eq('token', token)
        .is('unsubscribed_at', null)
        .single()

      if (error || !sub) {
        return json({ error: 'Invalid or expired link' }, 404)
      }

      // First-time confirmation. The frontend uses
      // `was_just_confirmed` to fire its analytics event exactly once,
      // and we use it to fire the operator notification.
      const wasJustConfirmed = !sub.confirmed
      if (wasJustConfirmed) {
        console.log('[preferences] confirming subscriber', { id: sub.id, email: sub.email })
        const { error: updateErr } = await supabase
          .from('subscribers')
          .update({ confirmed: true })
          .eq('id', sub.id)

        if (updateErr) {
          console.error('[preferences] confirm update error', updateErr)
          // Don't fail the request — the user has a valid token; we
          // can retry the confirm flag next time. But skip the admin
          // notification so we don't claim "confirmed" when the DB
          // didn't actually flip.
        } else {
          // Fire the admin notification. Wrapped so a Resend hiccup
          // never breaks the user-facing confirmation flow.
          try {
            await sendAdminConfirmedNotification({
              email: sub.email,
              frequency: sub.frequency,
              lookahead_days: sub.lookahead_days,
              intents: (sub.preferences?.intents as string[] | undefined) || ['all'],
              signedUpAt: sub.created_at,
            })
          } catch (err) {
            console.error('[preferences] admin notification failed', err)
          }
        }
      }

      return json({
        ok: true,
        preferences: sub.preferences,
        frequency: sub.frequency,
        lookahead_days: sub.lookahead_days,
        send_day: sub.send_day,
        // Frontend fires `newsletter_confirm` analytics event only
        // when this flips true. Stays false on subsequent visits.
        was_just_confirmed: wasJustConfirmed,
      })
    }

    // ── POST: update preferences ──
    if (req.method === 'POST') {
      const body = await req.json()
      const token = body.token

      if (!token) return json({ error: 'Token required' }, 400)

      // Look up subscriber by token
      const { data: sub, error: lookupErr } = await supabase
        .from('subscribers')
        .select('id')
        .eq('token', token)
        .is('unsubscribed_at', null)
        .single()

      if (lookupErr || !sub) {
        return json({ error: 'Invalid or expired link' }, 404)
      }

      // Build the update object — only include fields that were sent
      const update: Record<string, unknown> = {}

      if (body.preferences !== undefined) {
        // Validate keyword limit
        const kw = body.preferences?.keywords
        if (Array.isArray(kw) && kw.length > 5) {
          return json({ error: 'Maximum 5 keyword alerts allowed' }, 400)
        }
        update.preferences = body.preferences
      }

      if (body.frequency !== undefined) {
        if (!['daily', 'weekly', 'monthly'].includes(body.frequency)) {
          return json({ error: 'Invalid frequency' }, 400)
        }
        update.frequency = body.frequency
      }

      if (body.lookahead_days !== undefined) {
        if (![1, 7, 30].includes(body.lookahead_days)) {
          return json({ error: 'Invalid lookahead' }, 400)
        }
        update.lookahead_days = body.lookahead_days
      }

      if (body.send_day !== undefined) {
        if (body.send_day !== null && (body.send_day < 0 || body.send_day > 6)) {
          return json({ error: 'Invalid send day' }, 400)
        }
        update.send_day = body.send_day
      }

      if (Object.keys(update).length === 0) {
        return json({ error: 'No fields to update' }, 400)
      }

      const { error: updateErr } = await supabase
        .from('subscribers')
        .update(update)
        .eq('id', sub.id)

      if (updateErr) {
        console.error('Update error:', updateErr)
        return json({ error: 'Could not save preferences' }, 500)
      }

      return json({ ok: true })
    }

    return json({ error: 'Method not allowed' }, 405)
  } catch (err) {
    console.error('Preferences error:', err)
    return json({ error: 'Internal error' }, 500)
  }
})

// ── Admin notification on confirmation ──

/**
 * Notify operators when a subscriber confirms (the unconfirmed →
 * confirmed transition). Fired from the GET handler when a fresh
 * confirmation-link visit flips the `confirmed` flag for the first
 * time. Best-effort: any failure here is logged but does NOT break
 * the user's confirmation flow.
 */
async function sendAdminConfirmedNotification(args: {
  email: string
  frequency: string
  lookahead_days: number
  intents: string[]
  signedUpAt?: string | null
}) {
  if (ADMIN_NOTIFY_EMAIL.length === 0) return
  const c = THEME.colors
  const f = THEME.fonts
  const intentsLabel = args.intents && args.intents.length > 0
    ? args.intents.join(', ')
    : 'all'

  const response = await resend.emails.send({
    from: THEME.from,
    to: ADMIN_NOTIFY_EMAIL,
    subject: `[${THEME.brandName}] Subscriber confirmed`,
    html: `
      <div style="font-family: ${f.body}; max-width: 520px; margin: 0 auto; padding: 32px 20px;">
        <p style="font-family: ${f.display}; font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: ${c.primary}; margin: 0 0 8px;">
          ${THEME.brandName} · operator notification
        </p>
        <h1 style="font-family: ${f.display}; font-size: 1.35rem; color: ${c.textPrimary}; margin: 0 0 18px;">
          New confirmed subscriber
        </h1>
        <table style="width: 100%; border-collapse: collapse; font-size: 0.95rem;">
          <tr>
            <td style="padding: 8px 0; color: ${c.textMuted}; width: 130px;">Email</td>
            <td style="padding: 8px 0; color: ${c.textPrimary};"><code>${escapeHtml(args.email)}</code></td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: ${c.textMuted};">Frequency</td>
            <td style="padding: 8px 0; color: ${c.textPrimary};">${escapeHtml(args.frequency)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: ${c.textMuted};">Lookahead</td>
            <td style="padding: 8px 0; color: ${c.textPrimary};">${args.lookahead_days} days</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: ${c.textMuted};">Intents</td>
            <td style="padding: 8px 0; color: ${c.textPrimary};">${escapeHtml(intentsLabel)}</td>
          </tr>
          ${args.signedUpAt ? `
          <tr>
            <td style="padding: 8px 0; color: ${c.textMuted};">Signed up</td>
            <td style="padding: 8px 0; color: ${c.textPrimary};">${escapeHtml(args.signedUpAt)}</td>
          </tr>` : ''}
          <tr>
            <td style="padding: 8px 0; color: ${c.textMuted};">Confirmed</td>
            <td style="padding: 8px 0; color: ${c.textPrimary};">${new Date().toISOString()}</td>
          </tr>
        </table>
        <p style="color: ${c.textMuted}; font-size: 0.78rem; margin-top: 28px; line-height: 1.5;">
          They'll receive their first digest on the next scheduled
          send. To stop these operator notifications, unset
          <code>ADMIN_NOTIFY_EMAIL</code>.
        </p>
      </div>
    `,
  })

  if (response.error) {
    console.error('[preferences] admin notification email rejected', {
      to: ADMIN_NOTIFY_EMAIL,
      error: response.error,
    })
    throw new Error(
      `Resend admin notification failed: ${response.error.name || ''} ${response.error.message || JSON.stringify(response.error)}`,
    )
  }

  console.log('[preferences] admin notification sent', {
    to: ADMIN_NOTIFY_EMAIL,
    resend_id: response.data?.id,
  })
}

// Minimal HTML-escape so a subscriber's email address can't smuggle
// markup into the operator notification template.
function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}
