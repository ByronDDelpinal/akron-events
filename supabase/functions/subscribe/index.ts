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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BASE_URL = Deno.env.get('PUBLIC_SITE_URL') || 'https://events.supportlocalakron.com'

// ── Brand theme (mirrors src/lib/emailTheme.js — update both together) ──
const THEME = {
  brandName: 'Turnout',
  from: 'Turnout <digest@events.supportlocalakron.com>',
  colors: {
    primary:       '#D4922A',
    textPrimary:   '#17200F',
    textSecondary: '#3A4E30',
    textMuted:     '#7A9068',
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
      // Already exists — silently re-send confirmation (don't reveal to client)
      if (!existing.confirmed) {
        const { data: sub } = await supabase
          .from('subscribers')
          .select('token')
          .eq('id', existing.id)
          .single()
        if (sub) await sendConfirmationEmail(email, sub.token)
      }
      return json({ ok: true })
    }

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

    return json({ ok: true })
  } catch (err) {
    console.error('Subscribe error:', err)
    return json({ error: 'Internal error' }, 500)
  }
})

// ── Email helpers ──

async function sendConfirmationEmail(email: string, token: string) {
  const confirmUrl = `${BASE_URL}/subscribe/preferences?token=${token}`
  const c = THEME.colors
  const f = THEME.fonts

  await resend.emails.send({
    from: THEME.from,
    to: [email],
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

  await resend.emails.send({
    from: THEME.from,
    to: [email],
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
