// slack-notify — Tier 1 Slack notification dispatcher.
//
// Fired by three DB triggers (supabase/migrations/045_slack_triggers.sql):
// a published feedback-orb note, a new subscriber signup, and a subscriber's
// confirmation. No LLM in the loop — this is a fixed fetch -> claim ->
// re-read -> render -> post -> settle pipeline over three known event shapes.
//
// Deploy with `verify_jwt = false` (see README's Slack section) — pg_net
// triggers call this function directly and cannot attach a user JWT, so the
// gateway's JWT check must be off. That makes the function reachable by
// anyone on the internet who has the URL, which is why the FIRST thing this
// handler does — before parsing the body, before touching the database — is
// verify the `X-Slack-Notify-Secret` header against a shared secret that
// only this function and the DB triggers know (see the auth gate below and
// 045's header comment for the full threat model this replaces).
//
// Protocol per request:
//   0. Verify the shared-secret header. Reject unauthenticated callers
//      before any Supabase call is made.
//   1. Parse + validate the discriminated body.
//   2. Claim the dedupe_key: INSERT ... ON CONFLICT (dedupe_key) DO NOTHING
//      RETURNING id (via .upsert(..., { ignoreDuplicates: true })). Zero
//      rows back means some earlier call (a retried trigger, a replayed
//      request from a holder of the shared secret) already claimed this
//      event: return 200 {ok:true,skipped:'duplicate'} and post nothing.
//   3. Re-read the referenced row with the service role, through a
//      HARDCODED COLUMN ALLOWLIST. No select('*'), no spreading the row into
//      the renderer, no JSON.stringify(sub) anywhere — subscribers.token is
//      the unsubscribe secret; if it reached Slack, anyone in the channel
//      could unsubscribe that person.
//   4. Render plain mrkdwn text (./render.ts — pure, unit-tested).
//   5. Post to Slack (../_shared/slack.ts).
//   6. Settle the ledger row to 'sent' (with slack_ts) or 'failed' (with an
//      error string).
//
// Extension point for Tiers 2/3: an arbitrary `{channel, text, dedupe_key}`
// arm would let any caller post free-text to any channel, so unlike the
// three fixed-shape arms below (whose bodies can only ever reference a real
// row id and re-read it server-side) it needs its own caller secret before
// it can be wired up. NOT implemented in Tier 1 — see the commented-out
// union member below.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal'
import { postMessage, type ChannelKey } from '../_shared/slack.ts'
import {
  renderFeedback,
  renderSignup,
  renderConfirmed,
  stringArray,
  type ResolvedNames,
  type Preferences,
} from './render.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// The shared secret the DB triggers send as X-Slack-Notify-Secret (set via
// `supabase secrets set SLACK_NOTIFY_SECRET=...`, matching the Vault value
// Byron creates by hand per 045's header — never committed to a migration).
// Read once at cold start, not per-request, so a missing secret is visible
// in the cold-start log line below rather than only surfacing on first call.
const SLACK_NOTIFY_SECRET = Deno.env.get('SLACK_NOTIFY_SECRET') || null

// Cold-start env audit. Same pattern as notify-feedback/index.ts:37-41 (the
// Slack-specific secrets are audited in ../_shared/slack.ts, which every
// caller of postMessage() imports).
console.log('[slack-notify] cold start', {
  has_SUPABASE_URL: !!Deno.env.get('SUPABASE_URL'),
  has_SUPABASE_SERVICE_ROLE_KEY: !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  has_SLACK_NOTIFY_SECRET: !!SLACK_NOTIFY_SECRET,
})

/**
 * Constant-time string comparison for the shared-secret header. Deno's
 * std timingSafeEqual operates on equal-length buffers (it throws on a
 * length mismatch), so a length check runs first as a fast, non-secret-value
 * reject — the byte length of a secret is not itself sensitive, and this is
 * the same shape of comparison Node's `crypto.timingSafeEqual` callers use
 * (see notify-pending-event/index.ts for this function's `crypto.subtle`
 * HMAC-verify sibling, which gets constant-time comparison for free from the
 * WebCrypto API; there is no equivalent single-call primitive for a plain
 * shared-secret compare, hence this helper).
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const bufA = enc.encode(a)
  const bufB = enc.encode(b)
  if (bufA.byteLength !== bufB.byteLength) return false
  return timingSafeEqual(bufA, bufB)
}

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

// Discriminated request body. Tier 1 implements exactly these three arms.
type Req =
  | { event: 'feedback'; id: number }
  | { event: 'subscriber_signup'; id: string }
  | { event: 'subscriber_confirmed'; id: string }
  // Tier 2/3 extension point — NOT implemented:
  // | { event: 'custom'; channel: string; text: string; dedupe_key: string; secret: string }

interface Plan {
  dedupeKey: string
  kind: 'feedback' | 'subscriber_signup' | 'subscriber_confirmed'
  channelKey: ChannelKey
}

function parseRequest(body: unknown): Req | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.event === 'feedback' && typeof b.id === 'number' && Number.isFinite(b.id)) {
    return { event: 'feedback', id: b.id }
  }
  if (b.event === 'subscriber_signup' && typeof b.id === 'string' && b.id) {
    return { event: 'subscriber_signup', id: b.id }
  }
  if (b.event === 'subscriber_confirmed' && typeof b.id === 'string' && b.id) {
    return { event: 'subscriber_confirmed', id: b.id }
  }
  return null
}

// Dedupe keys: feedback:{id}, subscriber_signup:{uuid}, subscriber_confirmed:{uuid}.
function planFor(req: Req): Plan {
  switch (req.event) {
    case 'feedback':
      return { dedupeKey: `feedback:${req.id}`, kind: 'feedback', channelKey: 'public-feedback' }
    case 'subscriber_signup':
      return { dedupeKey: `subscriber_signup:${req.id}`, kind: 'subscriber_signup', channelKey: 'public-new-email-subscribers' }
    case 'subscriber_confirmed':
      return { dedupeKey: `subscriber_confirmed:${req.id}`, kind: 'subscriber_confirmed', channelKey: 'public-new-email-subscribers' }
  }
}

async function settle(
  rowId: number,
  status: 'sent' | 'failed',
  extra: { slack_ts?: string; error?: string },
): Promise<void> {
  const { error } = await supabase
    .from('slack_notifications')
    .update({ status, completed_at: new Date().toISOString(), ...extra })
    .eq('id', rowId)
  if (error) {
    console.error('[slack-notify] failed to settle ledger row', { rowId, status, error })
  }
}

/**
 * Batched id -> name resolution for the signup renderer's Organizations /
 * Venues bullets. Only issues a query when the corresponding id array is
 * non-empty. Missing ids (deleted rows) simply have no entry in the
 * returned map — render.ts turns that into "(removed organizer)" /
 * "(removed venue)", never the raw id.
 */
// Cap on how many org/venue ids this function will ever pass into an
// `.in('id', …)` query for name resolution. render.ts's capList only shows
// the first 6 of these in the final message anyway, so anything past a
// generous margin above that is pure query-cost with no rendering benefit —
// see the comment at this constant's one call site for the two concrete
// failure modes (UUID cast failure poisoning the whole batch, and Kong 414)
// this closes.
const MAX_RESOLVE_IDS = 200

async function resolveOrgAndVenueNames(orgIds: string[], venueIds: string[]): Promise<ResolvedNames> {
  const orgNames = new Map<string, string>()
  const venueNames = new Map<string, string>()

  if (orgIds.length > 0) {
    const { data, error } = await supabase.from('organizations').select('id, name').in('id', orgIds)
    if (error) {
      console.error('[slack-notify] org name resolve failed', error)
    } else {
      for (const row of data ?? []) orgNames.set(row.id, row.name)
    }
  }

  if (venueIds.length > 0) {
    const { data, error } = await supabase.from('venues').select('id, name').in('id', venueIds)
    if (error) {
      console.error('[slack-notify] venue name resolve failed', error)
    } else {
      for (const row of data ?? []) venueNames.set(row.id, row.name)
    }
  }

  return { orgNames, venueNames }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  // ── Auth gate ── runs before body parsing and before any Supabase call.
  // This function is deployed with verify_jwt = false (pg_net triggers can't
  // attach a JWT), which is what makes it publicly reachable in the first
  // place — this header check is the entire authentication boundary.
  //
  // Fail closed if the function's own secret isn't configured: a missing
  // SLACK_NOTIFY_SECRET is a deploy-time misconfiguration (`supabase secrets
  // set` never ran, or ran against the wrong project), not something a
  // caller can trigger — log it distinguishably from a bad/forged header so
  // Byron can tell "the function is broken" from "someone is probing it"
  // at a glance in the function logs.
  if (!SLACK_NOTIFY_SECRET) {
    console.error('[slack-notify] SLACK_NOTIFY_SECRET is not configured on this function — rejecting all requests until it is set')
    return json({ error: 'Not configured' }, 401)
  }

  const provided = req.headers.get('X-Slack-Notify-Secret') ?? ''
  if (!provided || !timingSafeEqualStrings(provided, SLACK_NOTIFY_SECRET)) {
    console.warn('[slack-notify] rejected request: missing or invalid X-Slack-Notify-Secret header')
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const rawBody = await req.json().catch(() => null)
    const parsed = parseRequest(rawBody)
    if (!parsed) {
      return json({ error: 'invalid request body' }, 400)
    }

    const plan = planFor(parsed)

    // ── Claim ── INSERT ... ON CONFLICT (dedupe_key) DO NOTHING RETURNING id.
    // ignoreDuplicates:true is supabase-js's spelling of ON CONFLICT DO
    // NOTHING (PostgREST Prefer: resolution=ignore-duplicates) — a
    // conflicting row comes back as zero rows, not an error.
    //
    // This RETURNING only works because `supabase` above is built with
    // SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS entirely. The only RLS
    // policy on slack_notifications (044_slack_notifications.sql) grants
    // `select` to `authenticated`, nothing to `anon` and no `insert` policy
    // at all — an anon-keyed client would have its INSERT rejected outright.
    // Per this repo's own RLS history (see the "RLS DELETE needs SELECT
    // visibility" incident this project has hit before), swapping this
    // client for anything less than service-role would make every claim
    // silently return zero rows: `claimed` would always be falsy, every
    // request would look like a 'duplicate', and every Slack notification
    // would stop firing with no error anywhere — the failure mode is
    // silent, not a loud 403.
    const { data: claimed, error: claimErr } = await supabase
      .from('slack_notifications')
      .upsert(
        { dedupe_key: plan.dedupeKey, kind: plan.kind, channel_key: plan.channelKey },
        { onConflict: 'dedupe_key', ignoreDuplicates: true },
      )
      .select('id')
      .maybeSingle()

    if (claimErr) {
      console.error('[slack-notify] claim insert failed', { dedupe_key: plan.dedupeKey, claimErr })
      return json({ error: 'claim failed' }, 500)
    }

    if (!claimed) {
      return json({ ok: true, skipped: 'duplicate' })
    }

    const rowId = claimed.id as number

    try {
      let text: string

      if (parsed.event === 'feedback') {
        const { data: fb, error: fbErr } = await supabase
          .from('feedback_posts')
          .select('id, body, page_path, created_at')
          .eq('id', parsed.id)
          .maybeSingle()

        if (fbErr || !fb) {
          console.error('[slack-notify] feedback row not found', { id: parsed.id, fbErr })
          await settle(rowId, 'failed', { error: 'row not found' })
          return json({ ok: true, skipped: 'row not found' })
        }

        text = renderFeedback(fb)
      } else {
        // subscriber_signup | subscriber_confirmed — same re-read.
        //
        // HARD REQUIREMENT: this select list is a hardcoded literal column
        // allowlist. Never select('*'), never spread this row into the
        // renderer, never JSON.stringify(sub) anywhere — subscribers.token
        // is the unsubscribe token and must never reach Slack.
        const { data: sub, error: subErr } = await supabase
          .from('subscribers')
          .select('id, email, confirmed, frequency, lookahead_days, preferences, created_at')
          .eq('id', parsed.id)
          .maybeSingle()

        if (subErr || !sub) {
          console.error('[slack-notify] subscriber row not found', { id: parsed.id, subErr })
          await settle(rowId, 'failed', { error: 'row not found' })
          return json({ ok: true, skipped: 'row not found' })
        }

        if (parsed.event === 'subscriber_confirmed') {
          text = renderConfirmed(sub.email)
        } else {
          const prefs = (sub.preferences ?? {}) as Preferences
          // stringArray (imported from render.ts, same coercion the renderer
          // itself uses) instead of a bare Array.isArray check: a single
          // non-string element (e.g. `org_ids: [123]` or `[{a:1}]`) used to
          // sail straight into `.in('id', …)` below, which Postgres rejects
          // wholesale with "invalid input syntax for type uuid" — caught and
          // logged, so no crash, but the query never runs at all, so EVERY
          // org/venue in the list (including the valid ones) renders as
          // "(removed organizer)"/"(removed venue)" instead of just the bad
          // entry being skipped. Capped at MAX_RESOLVE_IDS for the same
          // reason render.ts's capList caps every other list-shaped facet:
          // an unbounded id array also builds a multi-megabyte `.in(...)`
          // query string that Kong rejects outright with 414 before this
          // query even reaches Postgres.
          const orgIds = stringArray(prefs.org_ids).slice(0, MAX_RESOLVE_IDS)
          const venueIds = stringArray(prefs.venue_ids).slice(0, MAX_RESOLVE_IDS)
          const resolved = await resolveOrgAndVenueNames(orgIds, venueIds)
          text = renderSignup(
            {
              email: sub.email,
              frequency: sub.frequency,
              lookahead_days: sub.lookahead_days,
              preferences: prefs,
            },
            resolved,
          )
        }
      }

      const result = await postMessage(plan.channelKey, text)

      if (!result.ok) {
        console.error('[slack-notify] post failed', { dedupe_key: plan.dedupeKey, error: result.error })
        await settle(rowId, 'failed', { error: result.error })
        return json({ error: 'Slack send failed' }, 502)
      }

      await settle(rowId, 'sent', { slack_ts: result.ts })
      console.log('[slack-notify] sent', { dedupe_key: plan.dedupeKey, channel_key: plan.channelKey, slack_ts: result.ts })
      return json({ ok: true, slack_ts: result.ts })
    } catch (err) {
      console.error('[slack-notify] render/post fatal', err)
      await settle(rowId, 'failed', { error: err instanceof Error ? err.message : String(err) })
      return json({ error: 'Internal error' }, 500)
    }
  } catch (err) {
    console.error('[slack-notify] fatal', err)
    return json({ error: 'Internal error' }, 500)
  }
})
