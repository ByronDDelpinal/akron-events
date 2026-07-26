import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

/**
 * Service role client — bypasses RLS, server-side only, never expose to browser.
 *
 * Lazily initialized: credentials are read and validated on FIRST USE, not at
 * import. Importing this module (or anything that transitively imports it,
 * like a scraper's parse functions in tests) must never require credentials
 * or perform side effects. CI runs the test suite with no env at all.
 */
let _client = null

function getClient() {
  if (_client) return _client

  const url = process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error(
      'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env'
    )
  }

  _client = createClient(url, key, {
    auth: { persistSession: false },
  })
  return _client
}

/**
 * Test-only seam: inject a fake client (or reset with `null`) so unit tests can
 * exercise DB-touching code paths offline without hitting the network. The
 * lazy Proxy below already routes every `supabaseAdmin.*` access through the
 * cached `_client`, so setting it here mocks the whole client in one place.
 * Never called in production code.
 */
export function __setClientForTests(client) {
  _client = client
}

// Proxy keeps the existing `supabaseAdmin.from(...)` call sites working
// unchanged while deferring client creation until a property is touched.
export const supabaseAdmin = new Proxy(
  {},
  {
    get(_target, prop) {
      const client = getClient()
      const value = client[prop]
      return typeof value === 'function' ? value.bind(client) : value
    },
  }
)
