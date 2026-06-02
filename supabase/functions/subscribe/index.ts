// subscribe — handles new signups and re-sends confirmation emails
// POST { email, intents?, frequency?, lookahead_days? }
// POST { email, resend_confirmation: true }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resend } from 'https://esm.sh/resend@4'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)
const resend = new Resend(Deno.env.get('RESEND_API_KEY')!)

// Surface the env shape at cold-start so a missing key is obvious in
// the Supabase function logs without leaking the values themselves.
// Catching this once is a lot cheaper than tracing a silent send
// failure later.
console.log('[subscribe] cold start', {
  has_SUPABASE_URL:              !!Deno.env.get('SUPABASE_URL'),
  has_SUPABASE_SERVICE_ROLE_KEY: !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  has_RESEND_API_KEY:            !!Deno.env.get('RESEND_API_KEY'),
  PUBLIC_SITE_URL:               Deno.env.get('PUBLIC_SITE_URL') || '(default)',
})
// Operator notifications live in the `preferences` function (sent
// on confirmation, not signup), so subscribe doesn't need its own
// ADMIN_NOTIFY_EMAIL secret. The analytics events on SubscribePage
// cover signup-side funnel reporting.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BASE_URL = Deno.env.get('PUBLIC_SITE_URL') || 'https://akronpulse.com'

// ── Brand theme (mirrors src/lib/emailTheme.js — update both together) ──
// `from` can be overridden via RESEND_FROM env var so a future domain
// migration is a single secret update instead of a redeploy. Default
// is the verified `akronpulse.com` apex domain (the old
// `events.supportlocalakron.com` was retired May 2026). `replyTo`
// routes replies to a real human inbox; overridable via RESEND_REPLY_TO.
const THEME = {
  brandName: 'Akron Pulse',
  from: Deno.env.get('RESEND_FROM') || 'Akron Pulse <digest@akronpulse.com>',
  replyTo: Deno.env.get('RESEND_REPLY_TO') || 'byron@akronpulse.com',
  colors: {
    primary:       '#0E5163',
    textPrimary:   '#1F2A30',
    textSecondary: '#3E5560',
    textMuted:     '#5F7886',
    white:         '#FFFFFF',
  },
  fonts: {
    display: "'Space Grotesk', system-ui, sans-serif",
    body:    "'DM Sans', system-ui, sans-serif",
  },
} as const

Deno.serve(async (req) => {
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const body = await req.json()
    const email = body.email?.trim().toLowerCase()

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Valid email required' }, 400)
    }

    // ── Re-send confirmation flow ──
    if (body.resend_confirmation) {
      const { data: existing } = await supabase
        .from('subscribers')
        .select('id, token, confirmed')
        .eq('email', email)
        .single()

      if (!existing) {
        // Don't reveal whether email exists — just say "check your inbox"
        return json({ ok: true, message: 'If that email is subscribed, a link has been sent.' })
      }

      if (existing.confirmed) {
        // Already confirmed — send them their preferences link
        await sendPreferencesEmail(email, existing.token)
      } else {
        await sendConfirmationEmail(email, existing.token)
      }

      return json({ ok: true, message: 'If that email is subscribed, a link has been sent.' })
    }

    // ── New signup flow ──
    const { data: existing } = await supabase
      .from('subscribers')
      .select('id, confirmed')
      .eq('email', email)
      .single()

    if (existing) {
      // Already exists. We never tell the client which branch we took
      // (that would let someone probe whether an email is subscribed),
      // but we DO log it so the function stops behaving like a black
      // box — silent no-ops here were what made the email-delivery
      // debugging painful in May 2026.
      if (!existing.confirmed) {
        console.log('[subscribe] existing unconfirmed subscriber — resending confirmation', { email })
        const { data: sub } = await supabase
          .from('subscribers')
          .select('token')
          .eq('id', existing.id)
          .single()
        if (sub) await sendConfirmationEmail(email, sub.token)
      } else {
        console.log('[subscribe] existing CONFIRMED subscriber — no email sent', { email })
      }
      return json({ ok: true })
    }

    console.log('[subscribe] new subscriber — creating + sending confirmation', { email })

    // Build initial preferences from signup form
    const preferences: Record<string, unknown> = {
      intents: body.intents || ['all'],
      categories: [],
      venue_ids: [],
      org_ids: [],
      price_max: null,
      age_restriction: null,
      event_days: [0, 1, 2, 3, 4, 5, 6],
      location: null,
      keywords: [],
      keywords_title_only: false,
    }

    const frequency = ['daily', 'weekly', 'monthly'].includes(body.frequency)
      ? body.frequency
      : 'weekly'

    const lookahead_days = [1, 7, 30].includes(body.lookahead_days)
      ? body.lookahead_days
      : 7

    const { data: newSub, error: insertErr } = await supabase
      .from('subscribers')
      .insert({
        email,
        frequency,
        lookahead_days,
        preferences,
      })
      .select('token')
      .single()

    if (insertErr) {
      console.error('Insert error:', insertErr)
      return json({ error: 'Could not create subscription' }, 500)
    }

    await sendConfirmationEmail(email, newSub.token)

    // No admin notification here — operators are notified on
    // CONFIRMATION (in the preferences fn), not on initial signup, so
    // the inbox only fills with real opted-in subscribers, not
    // abandoned half-signups. The analytics on the SubscribePage
    // still capture every signup attempt for funnel analysis.

    return json({ ok: true })
  } catch (err) {
    console.error('Subscribe error:', err)
    return json({ error: 'Internal error' }, 500)
  }
})

// ── Email helpers ──

/**
 * Wraps resend.emails.send and treats a non-null `error` field on the
 * response as a hard failure. The Resend v4 SDK does NOT throw on API
 * errors — it returns `{ data: null, error: { ... } }`. The previous
 * implementation awaited the call and ignored the return shape, so an
 * unverified sender domain, invalid API key, exceeded quota, or any
 * other 4xx/5xx from Resend silently turned into a 200 response from
 * this function and a "Check your inbox!" success state on the
 * client. No email ever left Resend.
 *
 * This helper:
 *   - Logs a single structured line for both success and failure so
 *     Supabase function logs are useful at a glance.
 *   - Throws on failure so the outer try/catch in `Deno.serve` returns
 *     500 to the client and the user sees a real error instead of a
 *     fake confirmation screen.
 *
 * `label` is a short human tag used in log lines ("confirmation",
 * "preferences") so we can tell which template failed.
 */
async function sendEmail(
  label: string,
  payload: Parameters<typeof resend.emails.send>[0],
  options?: Parameters<typeof resend.emails.send>[1],
) {
  const response = await resend.emails.send(payload, options ?? {})

  if (response.error) {
    console.error(`[subscribe] ${label} email failed`, {
      to: payload.to,
      from: payload.from,
      error: response.error,
    })
    throw new Error(
      `Resend ${label} send failed: ${response.error.name || ''} ${response.error.message || JSON.stringify(response.error)}`,
    )
  }

  console.log(`[subscribe] ${label} email sent`, {
    to: payload.to,
    resend_id: response.data?.id,
  })
}

async function sendConfirmationEmail(email: string, token: string) {
  const confirmUrl = `${BASE_URL}/subscribe/preferences?token=${token}`
  const c = THEME.colors
  const f = THEME.fonts

  await sendEmail('confirmation', {
    from: THEME.from,
    to: [email],
    reply_to: THEME.replyTo,
    subject: `Confirm your ${THEME.brandName} subscription`,
    html: `
      <div style="font-family: ${f.body}; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h1 style="font-family: ${f.display}; font-size: 1.5rem; color: ${c.textPrimary}; margin-bottom: 16px;">
          Welcome to ${THEME.brandName}!
        </h1>
        <p style="color: ${c.textSecondary}; line-height: 1.6; margin-bottom: 24px;">
          Click the button below to confirm your subscription and set up your preferences.
        </p>
        <a href="${confirmUrl}" style="display: inline-block; padding: 14px 28px; background: ${c.primary}; color: ${c.white}; text-decoration: none; border-radius: 10px; font-weight: 700; font-family: ${f.display};">
          Confirm &amp; Set Preferences
        </a>
        <p style="color: ${c.textMuted}; font-size: 0.78rem; margin-top: 24px; line-height: 1.5;">
          If you didn't sign up for ${THEME.brandName}, you can ignore this email.
        </p>
      </div>
    `,
  }, {
    idempotencyKey: `confirm-${email}`,
  })
}

async function sendPreferencesEmail(email: string, token: string) {
  const prefsUrl = `${BASE_URL}/subscribe/preferences?token=${token}`
  const c = THEME.colors
  const f = THEME.fonts

  await sendEmail('preferences', {
    from: THEME.from,
    to: [email],
    reply_to: THEME.replyTo,
    subject: `Your ${THEME.brandName} preferences link`,
    html: `
      <div style="font-family: ${f.body}; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h1 style="font-family: ${f.display}; font-size: 1.5rem; color: ${c.textPrimary}; margin-bottom: 16px;">
          Here's your preferences link
        </h1>
        <p style="color: ${c.textSecondary}; line-height: 1.6; margin-bottom: 24px;">
          Click below to manage your ${THEME.brandName} email preferences.
        </p>
        <a href="${prefsUrl}" style="display: inline-block; padding: 14px 28px; background: ${c.primary}; color: ${c.white}; text-decoration: none; border-radius: 10px; font-weight: 700; font-family: ${f.display};">
          Manage Preferences
        </a>
      </div>
    `,
  })
}

// ── Helpers ──

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}
