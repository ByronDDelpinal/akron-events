/**
 * check-email-flow.js
 *
 * Walks the ENTIRE subscriber lifecycle against production, every night, with
 * a synthetic subscriber, and fails loudly if any leg is broken:
 *
 *   1. signup      — a row lands in `subscribers`, unconfirmed
 *   2. confirm     — the live `preferences` GET flips confirmed
 *   3. eligibility — send-digest's own selection query picks the row up
 *   4. one-click   — an RFC 8058 POST, shaped exactly as Gmail sends it,
 *                    unsubscribes them
 *   5. logging     — the attempt is recorded with outcome 'applied'
 *   6. exclusion   — the unsubscribed row drops out of digest eligibility
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * On 2026-09-17 we discovered one-click unsubscribe had NEVER worked. The
 * List-Unsubscribe header pointed at a client-side React route, so every
 * mailbox provider's unsubscribe button POSTed into a 405 and the subscriber
 * stayed on the list. Nothing caught it for months because nothing ever
 * exercised the flow end to end: the unit suite runs env-less and can't see
 * prod, the digest's own logs only prove mail was handed to Resend, and the
 * page cheerfully rendered "You've been unsubscribed" either way.
 *
 * Every leg here is walked over REAL HTTP against the deployed endpoints, not
 * against imported handlers. A test that calls the function body directly
 * would have passed happily the entire time the header was pointing at a dead
 * route — the bug lived in the wiring between two working pieces, which is
 * exactly the class of failure only an end-to-end walk catches.
 *
 * ── THE ONE SHORTCUT, AND WHY ──────────────────────────────────────────────
 * Step 1 inserts the row with the service role instead of calling the
 * `subscribe` function, because that function sends a real confirmation email
 * through Resend. Mailing a synthetic address nightly would earn us a nightly
 * hard bounce and spend real sender reputation to test our own plumbing. The
 * address uses the reserved .invalid TLD (RFC 2606) so it can never resolve.
 *
 * Usage:
 *   node scripts/check-email-flow.js
 *   node scripts/check-email-flow.js --quiet    (summary line only)
 *
 * Exits 0 when every leg passes, 1 on the first failure, so it can gate the
 * nightly job. Always cleans up its synthetic row, including on failure.
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   VITE_SUPABASE_ANON_KEY    — anon key (the preferences fn still verifies JWT)
 *   SUPABASE_SERVICE_ROLE_KEY — service role, for setup/teardown and assertions
 */

import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from './lib/supabase-admin.js'

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m'
const DIM = '\x1b[2m', R = '\x1b[0m'

const QUIET = process.argv.includes('--quiet')

// Synthetic addresses share this prefix so a leaked row from a crashed run is
// unambiguously ours to delete. .invalid can never receive mail (RFC 2606).
const QA_PREFIX = 'qa-flow-'
const QA_DOMAIN = '@akronpulse.invalid'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY

// The PUBLIC one-click URL — the exact string send-digest publishes in the
// List-Unsubscribe header. The check must exercise what the email advertises,
// not the edge function behind it: the bug this check exists to catch lived
// entirely in the routing between the two, and a check pointed at the
// function would have stayed green throughout.
const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://akronpulse.com'

const steps = []
function pass(name, detail) {
  steps.push({ name, ok: true, detail })
  if (!QUIET) console.log(`${GREEN}✓${R} ${name}${detail ? ` ${DIM}${detail}${R}` : ''}`)
}
function fail(name, detail) {
  steps.push({ name, ok: false, detail })
  console.error(`${RED}✗${R} ${name} ${DIM}—${R} ${detail}`)
  throw new Error(`${name}: ${detail}`)
}

/**
 * Remove synthetic rows from earlier runs before starting.
 *
 * Scoped to the QA prefix and nothing else: this check created every row it
 * deletes here. A cleanup predicate any broader than "rows this task made"
 * is how you turn a health check into an incident.
 */
async function sweepLeftovers() {
  const { data, error } = await supabaseAdmin
    .from('subscribers')
    .delete()
    .like('email', `${QA_PREFIX}%${QA_DOMAIN}`)
    .select('id')
  if (error) fail('sweep leftovers', error.message)
  if (data?.length && !QUIET) {
    console.log(`${YELLOW}!${R} swept ${data.length} leftover synthetic row(s) from a prior run`)
  }
}

async function main() {
  if (!SUPABASE_URL || !ANON_KEY) {
    console.error('check-email-flow: missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
    process.exit(1)
  }

  await sweepLeftovers()

  const email = `${QA_PREFIX}${randomUUID()}${QA_DOMAIN}`
  let subscriberId = null

  try {
    // ── 1. signup ──────────────────────────────────────────────────────────
    // frequency 'daily' keeps step 3 independent of which weekday we run on.
    const { data: created, error: insertErr } = await supabaseAdmin
      .from('subscribers')
      .insert({ email, confirmed: false, frequency: 'daily', lookahead_days: 7 })
      .select('id, token, confirmed, unsubscribed_at')
      .single()
    if (insertErr) fail('signup', insertErr.message)
    subscriberId = created.id

    if (created.confirmed) fail('signup', 'new row should start unconfirmed')
    if (created.unsubscribed_at) fail('signup', 'new row should start subscribed')
    // Real tokens come from gen_random_uuid(). If this ever stops being v4 the
    // unsubscribe function's bot-vs-human telemetry silently inverts.
    if (created.token[14] !== '4') {
      fail('signup', `token is not a v4 uuid (version nibble '${created.token[14]}')`)
    }
    pass('signup', `row created, v4 token`)

    // ── 2. confirm ─────────────────────────────────────────────────────────
    const prefsRes = await fetch(
      `${SUPABASE_URL}/functions/v1/preferences?token=${created.token}`,
      { headers: { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY } },
    )
    if (!prefsRes.ok) fail('confirm', `preferences GET returned ${prefsRes.status}`)
    const prefsBody = await prefsRes.json()
    if (prefsBody.was_just_confirmed !== true) {
      fail('confirm', 'preferences GET did not report the confirmation transition')
    }

    const { data: afterConfirm } = await supabaseAdmin
      .from('subscribers').select('confirmed').eq('id', subscriberId).single()
    if (!afterConfirm?.confirmed) fail('confirm', 'confirmed flag did not flip in the database')
    pass('confirm', 'preferences GET flipped confirmed')

    // ── 3. digest eligibility ──────────────────────────────────────────────
    // Mirrors send-digest's own selection predicate. If these drift, a
    // confirmed subscriber can silently stop receiving mail.
    const { data: eligible, error: eligErr } = await supabaseAdmin
      .from('subscribers')
      .select('id')
      .eq('confirmed', true)
      .is('unsubscribed_at', null)
      .eq('id', subscriberId)
    if (eligErr) fail('eligibility', eligErr.message)
    if (eligible.length !== 1) fail('eligibility', 'confirmed subscriber is not digest-eligible')
    pass('eligibility', 'confirmed subscriber is selectable by the digest')

    // ── 4. one-click unsubscribe ───────────────────────────────────────────
    // Byte-for-byte what a mailbox provider sends: no Authorization header, no
    // apikey, token in the query string, `List-Unsubscribe=One-Click` in a
    // form-encoded body. Any auth requirement on the endpoint fails here, which
    // is precisely the regression that went unnoticed for months.
    const oneClickUrl = `${SITE_URL}/unsubscribe?token=${created.token}`
    const ocRes = await fetch(oneClickUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    })
    if (ocRes.status === 405) {
      fail('one-click', 'POST to the published List-Unsubscribe URL returned 405 — nothing is serving it')
    }
    if (ocRes.status === 401) {
      fail('one-click', 'endpoint demanded auth (401) — the edge function needs --no-verify-jwt')
    }
    if (!ocRes.ok) fail('one-click', `POST returned ${ocRes.status}`)

    const { data: afterUnsub } = await supabaseAdmin
      .from('subscribers').select('unsubscribed_at').eq('id', subscriberId).single()
    if (!afterUnsub?.unsubscribed_at) {
      fail('one-click', 'endpoint answered 200 but unsubscribed_at was never set')
    }
    pass('one-click', 'RFC 8058 POST unsubscribed the row')

    // ── 5. the attempt was recorded ────────────────────────────────────────
    const { data: attempts, error: attErr } = await supabaseAdmin
      .from('unsubscribe_attempts')
      .select('outcome, source')
      .eq('subscriber_id', subscriberId)
    if (attErr) fail('attempt logging', attErr.message)
    const applied = attempts.find(a => a.outcome === 'applied')
    if (!applied) fail('attempt logging', 'no "applied" row in unsubscribe_attempts')
    if (applied.source !== 'one_click') {
      fail('attempt logging', `attempt logged as source '${applied.source}', expected 'one_click'`)
    }
    pass('attempt logging', 'outcome recorded as applied/one_click')

    // ── 6. exclusion ───────────────────────────────────────────────────────
    const { data: stillEligible } = await supabaseAdmin
      .from('subscribers')
      .select('id')
      .eq('confirmed', true)
      .is('unsubscribed_at', null)
      .eq('id', subscriberId)
    if (stillEligible.length !== 0) {
      fail('exclusion', 'unsubscribed row is STILL digest-eligible')
    }
    pass('exclusion', 'unsubscribed row dropped out of digest selection')
    // ── 7. the human page still works ──────────────────────────────────────
    // The POST is routed away by middleware. A GET must still reach the SPA —
    // if this ever returns JSON, we fixed one-click by breaking the page.
    const pageRes = await fetch(`${SITE_URL}/unsubscribe`)
    const pageType = pageRes.headers.get('content-type') || ''
    if (!pageRes.ok || !pageType.includes('text/html')) {
      fail('human page', `GET /unsubscribe returned ${pageRes.status} ${pageType}`)
    }
    pass('human page', 'GET still serves the SPA')
  } finally {
    // Teardown runs even when an assertion threw. A synthetic row left behind
    // confirmed-and-subscribed would be mailed by the 8:30am digest.
    if (subscriberId) {
      const { error } = await supabaseAdmin
        .from('subscribers').delete().eq('id', subscriberId)
      if (error) {
        console.error(`${RED}✗${R} teardown FAILED for ${subscriberId}: ${error.message}`)
      } else if (!QUIET) {
        console.log(`${DIM}· synthetic subscriber removed${R}`)
      }
    }
  }
}

main()
  .then(() => {
    console.log(`${GREEN}EMAIL FLOW OK${R} — ${steps.length}/${steps.length} legs passed`)
    process.exit(0)
  })
  .catch((err) => {
    const failed = steps.filter(s => !s.ok).length
    const passed = steps.filter(s => s.ok).length
    console.error(`${RED}EMAIL FLOW BROKEN${R} — ${passed} passed, ${failed} failed: ${err.message}`)
    process.exit(1)
  })
