// unsubscribe — one-click, no guilt, no confirmation needed.
//
// Three callers, one behaviour:
//
//   1. RFC 8058 one-click. Gmail, Outlook, Yahoo and friends render their own
//      "Unsubscribe" control next to the sender name when a message carries
//      `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. They then send:
//
//          POST <the List-Unsubscribe URI>
//          Content-Type: application/x-www-form-urlencoded
//          List-Unsubscribe=One-Click
//
//      with NO Authorization header and NO apikey. The token travels in the
//      query string. This is the single most common way a human unsubscribes
//      from a newsletter, and it is why this function MUST be deployed with
//      --no-verify-jwt (see the note below).
//
//   2. Our own /unsubscribe page: POST { token } as JSON, via supabase-js.
//
//   3. A plain link follow: GET ?token=<uuid>, for clients that just open the
//      List-Unsubscribe URI in a browser instead of POSTing.
//
// ── WHY verify_jwt IS OFF ──────────────────────────────────────────────────
// Until 2026-09-17 this function was deployed with verify_jwt = true, so the
// RFC 8058 POST above — which carries no auth header by design — got a 401
// and the unsubscribe silently never happened. Turning the gate off is not a
// weakening: the anon key ships inside the public client bundle, so requiring
// it never authenticated anybody. The real credential is the unguessable v4
// token, which is exactly what this function checks. Deploy with:
//
//     supabase functions deploy unsubscribe --no-verify-jwt
//
// ── WHY EVERY OUTCOME IS RECORDED ──────────────────────────────────────────
// The old version returned { ok: true } on success, on a token that matched
// nothing, and on an outright database error, and wrote no log line for any of
// them. That is how a dead one-click path survived months of Thursday sends
// unnoticed. Every attempt now lands in `unsubscribe_attempts` with its
// outcome. The RESPONSE stays deliberately uniform — it must not reveal
// whether a token was valid — but the operator can finally see the truth.
//
// The single exception is a genuine server-side failure, which returns 503 so
// the page can stop telling a subscriber they were unsubscribed when the write
// never landed.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Outcome = 'applied' | 'already' | 'no_match' | 'error'
type Source = 'one_click' | 'page' | 'link' | 'unknown'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  const url = new URL(req.url)
  const userAgent = (req.headers.get('user-agent') || '').slice(0, 300)

  let token: string | null = url.searchParams.get('token')
  let source: Source = req.method === 'GET' ? 'link' : 'unknown'

  try {
    if (req.method === 'POST') {
      const contentType = req.headers.get('content-type') || ''
      const raw = await req.text()

      if (contentType.includes('application/x-www-form-urlencoded')) {
        // RFC 8058: the body is the literal `List-Unsubscribe=One-Click` and
        // carries no token — the token is in the URI we published.
        source = 'one_click'
        const form = new URLSearchParams(raw)
        token = token || form.get('token')
      } else if (raw) {
        // Our own page, and anything else that speaks JSON.
        source = 'page'
        try {
          const body = JSON.parse(raw)
          token = body?.token || token
        } catch {
          // Malformed JSON is indistinguishable from a probe; fall through
          // with whatever the query string gave us.
        }
      }
    }
  } catch (err) {
    console.error('[unsubscribe] could not read request body', err)
  }

  if (!token) {
    await record({ outcome: 'no_match', source, userAgent, note: 'missing token' })
    return json({ ok: true })
  }

  // A malformed token is not an error to shout about — it is a bot. Postgres
  // would raise 22P02 on a non-uuid, so screen it here and count it instead.
  if (!UUID_RE.test(token)) {
    await record({ outcome: 'no_match', source, userAgent, note: 'malformed token' })
    return json({ ok: true })
  }

  // uuid version nibble: real subscriber tokens are v4 (gen_random_uuid).
  // Anything else is a fabricated token, which is worth counting separately —
  // link scanners fire a burst of v7-shaped values after every send.
  const tokenVersion = parseInt(token[14], 16)

  try {
    const { data: sub, error: lookupErr } = await supabase
      .from('subscribers')
      .select('id, unsubscribed_at')
      .eq('token', token)
      .maybeSingle()

    if (lookupErr) throw lookupErr

    if (!sub) {
      await record({ outcome: 'no_match', source, userAgent, tokenVersion })
      return json({ ok: true })
    }

    if (sub.unsubscribed_at) {
      // Idempotent by design: one-click may be retried, and a scanner may
      // replay the URI. Already-gone is a success, not a failure.
      await record({
        outcome: 'already', source, userAgent, tokenVersion, subscriberId: sub.id,
      })
      return json({ ok: true })
    }

    const { error: updateErr } = await supabase
      .from('subscribers')
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq('id', sub.id)
      .is('unsubscribed_at', null)

    if (updateErr) throw updateErr

    await record({
      outcome: 'applied', source, userAgent, tokenVersion, subscriberId: sub.id,
    })
    return json({ ok: true })
  } catch (err) {
    // A real failure. Say so — the page needs to stop claiming success.
    console.error('[unsubscribe] failed', err)
    await record({
      outcome: 'error', source, userAgent, tokenVersion, note: String(err).slice(0, 300),
    })
    return json({ ok: false, error: 'Could not process unsubscribe' }, 503)
  }
})

/**
 * Append one row to `unsubscribe_attempts`. Never stores the token itself —
 * it is a live credential for that subscriber's preferences. Best-effort: a
 * logging failure must never turn a successful unsubscribe into an error.
 */
async function record(args: {
  outcome: Outcome
  source: Source
  userAgent: string
  tokenVersion?: number
  subscriberId?: string
  note?: string
}) {
  try {
    const { error } = await supabase.from('unsubscribe_attempts').insert({
      outcome: args.outcome,
      source: args.source,
      subscriber_id: args.subscriberId ?? null,
      token_version: Number.isFinite(args.tokenVersion) ? args.tokenVersion : null,
      user_agent: args.userAgent || null,
      error_message: args.note ?? null,
    })
    if (error) console.error('[unsubscribe] attempt log rejected', error)
  } catch (err) {
    console.error('[unsubscribe] attempt log threw', err)
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}
