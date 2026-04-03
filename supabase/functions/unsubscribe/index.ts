// unsubscribe — one-click, no guilt, no confirmation needed
// POST { token }
// Also supports GET ?token=<uuid> for List-Unsubscribe-Post header compliance

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
    let token: string | null = null

    if (req.method === 'GET') {
      const url = new URL(req.url)
      token = url.searchParams.get('token')
    } else if (req.method === 'POST') {
      const body = await req.json()
      token = body.token
    }

    if (!token) {
      return json({ error: 'Token required' }, 400)
    }

    // Immediately unsubscribe — no "are you sure?", no survey
    const { data: sub, error } = await supabase
      .from('subscribers')
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq('token', token)
      .is('unsubscribed_at', null)
      .select('id')
      .single()

    if (error || !sub) {
      // Already unsubscribed or invalid token — still return success
      // (idempotent, don't expose whether the token was valid)
      return json({ ok: true })
    }

    return json({ ok: true })
  } catch (err) {
    console.error('Unsubscribe error:', err)
    return json({ error: 'Internal error' }, 500)
  }
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}
