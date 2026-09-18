/**
 * /api/unsubscribe — the RFC 8058 one-click unsubscribe endpoint.
 *
 * Mailbox providers (Gmail, Outlook, Yahoo, Apple Mail) render their own
 * "Unsubscribe" control beside the sender name when a message carries
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Clicking it sends:
 *
 *     POST <the List-Unsubscribe URI>
 *     Content-Type: application/x-www-form-urlencoded
 *     List-Unsubscribe=One-Click
 *
 * with no cookies, no auth, and the token carried in the query string.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * Our digest has always published `https://akronpulse.com/unsubscribe?token=…`
 * as that URI. But /unsubscribe is a CLIENT-SIDE React route — there is no
 * server behind it. Every provider that POSTed there got Vercel's bare 405,
 * the subscriber stayed on the list, and nothing anywhere recorded that a
 * person had asked to leave. Found 2026-09-17; it had never once worked.
 *
 * The header is not changed to point somewhere else, deliberately. Keeping
 * the List-Unsubscribe URI on the same domain as the From address is the
 * friendlier signal to receivers, and the send-digest function does not need
 * a redeploy to fix a routing problem. middleware.js routes POST /unsubscribe
 * here; a GET still falls through to the SPA so humans get the real page.
 *
 * This handler holds no credentials. It forwards to the `unsubscribe` edge
 * function, which owns the service role and does the write, the idempotency
 * and the attempt logging.
 */

// Public project URL — the same value that ships in the client bundle. Env
// override first so a preview deployment can point at another project.
const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL || 'https://hadipeqtzikxxsvtqdma.supabase.co'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    // A GET should never reach here — middleware only routes POSTs — but if
    // one does, send it to the page rather than answering with an error.
    res.setHeader('Location', `/unsubscribe${req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`)
    return res.status(302).end()
  }

  const token = typeof req.query?.token === 'string' ? req.query.token : null

  // RFC 8058 says the provider MUST get a 2xx for a successful unsubscribe and
  // will surface a failure to the user. We answer 200 for anything that isn't
  // our own fault — a missing or malformed token means the request didn't come
  // from one of our emails, and telling a caller which tokens are real is a
  // subscriber-enumeration oracle.
  if (!token || !UUID_RE.test(token)) {
    return res.status(200).json({ ok: true })
  }

  try {
    const upstream = await fetch(
      `${SUPABASE_URL}/functions/v1/unsubscribe?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      },
    )

    // Pass the upstream verdict through unchanged. A 503 from the function
    // means the write genuinely failed, and the provider should retry rather
    // than tell the subscriber they are unsubscribed when they are not.
    const body = await upstream.text()
    res.setHeader('Content-Type', 'application/json')
    return res.status(upstream.status).send(body || '{"ok":true}')
  } catch (err) {
    console.error('[api/unsubscribe] upstream call failed', err)
    return res.status(503).json({ ok: false, error: 'Could not process unsubscribe' })
  }
}
