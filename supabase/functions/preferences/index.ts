// preferences — token-gated read/update of subscriber preferences
// GET  ?token=<uuid>  → returns current preferences
// POST { token, preferences, frequency?, lookahead_days?, send_day? }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

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
        .select('id, email, preferences, frequency, lookahead_days, send_day, confirmed')
        .eq('token', token)
        .is('unsubscribed_at', null)
        .single()

      if (error || !sub) {
        return json({ error: 'Invalid or expired link' }, 404)
      }

      // If this is the first time they're visiting via the confirmation link,
      // mark them as confirmed (double opt-in complete)
      if (!sub.confirmed) {
        await supabase
          .from('subscribers')
          .update({ confirmed: true })
          .eq('id', sub.id)
      }

      return json({
        ok: true,
        preferences: sub.preferences,
        frequency: sub.frequency,
        lookahead_days: sub.lookahead_days,
        send_day: sub.send_day,
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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}
