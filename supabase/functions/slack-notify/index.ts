// slack-notify — Tier 1 + Tier 2 Slack notification dispatcher.
//
// Tier 1 (`feedback` / `subscriber_signup` / `subscriber_confirmed`) is fired
// by three DB triggers (supabase/migrations/045_slack_triggers.sql): a
// published feedback-orb note, a new subscriber signup, and a subscriber's
// confirmation. No LLM in the loop — this is a fixed fetch -> claim ->
// re-read -> render -> post -> settle pipeline over three known event shapes,
// and the text posted always comes from a server-side re-read of a real row,
// never from the request body's own fields.
//
// Tier 2 (`agent_post`) is fired by our own role agents (.claude/agents/) to
// post `daily_report` / `night_crew` updates to #daily-reports /
// #the-night-crew. Unlike Tier 1, the text IS caller-authored — there is no
// row to re-read — so its safety comes from three things instead:
// escapeSlackText applied unconditionally (see request.ts's
// buildAgentPostText), a channel allowlist a caller cannot escape (planFor in
// request.ts derives the channel from a fixed `kind`, never from caller
// input), and a dedupe key namespaced by that same fixed `kind` so an
// agent-secret holder can never pre-burn a Tier 1 dedupe key (see planFor's
// header comment for that exact exploit).
//
// Deploy with `verify_jwt = false` (see README's Slack section) — pg_net
// triggers call this function directly and cannot attach a user JWT, so the
// gateway's JWT check must be off. That makes the function reachable by
// anyone on the internet who has the URL, which is why the FIRST thing this
// handler does — before parsing the body, before touching the database — is
// classify the caller from a shared-secret header (see the auth gate below).
//
// Protocol per request:
//   0. Classify the caller (request.ts's classifyCaller, unit-tested
//      directly): 'trigger' (X-Slack-Notify-Secret), 'agent'
//      (X-Slack-Agent-Secret), or reject with 401. Both secrets are compared
//      timing-safe. If SLACK_NOTIFY_SECRET and SLACK_AGENT_SECRET are ever
//      set to the same value, the split is void (either secret classifies as
//      either caller) — classifyCaller fails closed on the agent arm only in
//      that case; see the SECRETS_COLLIDE check below. Reject unauthenticated
//      callers before any Supabase call.
//   1. Parse + validate the discriminated body (request.ts's parseRequest).
//   2. Plan the event (request.ts's planFor) — this also enforces the
//      capability split (trigger -> Tier 1 arms only, agent -> agent_post
//      only); a mismatch is a 403, logged distinguishably from a 401.
//   3. Claim the dedupe_key: INSERT ... ON CONFLICT (dedupe_key) DO NOTHING
//      RETURNING id (via .upsert(..., { ignoreDuplicates: true })). Zero
//      rows back means some earlier call (a retried trigger, a replayed
//      request) already claimed this event: re-read that row's slack_ts and
//      return 200 {ok:true,skipped:'duplicate',slack_ts} — a retry needs the
//      root ts to thread under, so this is no longer a bare skip.
//   4. Tier 1: re-read the referenced row with the service role, through a
//      HARDCODED COLUMN ALLOWLIST (no select('*'), no spreading the row into
//      the renderer — subscribers.token is the unsubscribe secret and must
//      never reach Slack), then render plain mrkdwn text (./render.ts).
//      Tier 2: escape the caller's own text (request.ts's buildAgentPostText)
//      and resolve its posted identity from the server-side AGENT_IDENTITIES
//      registry (request.ts's buildAgentPostOpts) — never from caller input.
//   5. Post to Slack (../_shared/slack.ts), passing the identity/thread
//      options for Tier 2.
//   6. Settle the ledger row to 'sent' (with slack_ts, and thread_ts if the
//      request carried one) or 'failed' (with an error string).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal'
import { postMessage, type PostOpts } from '../_shared/slack.ts'
import { normalizeConfig, buildEmbedUrl, buildIframeSnippet } from '../_shared/embedSnippet.ts'
import {
  renderFeedback,
  renderSignup,
  renderConfirmed,
  renderEmbedRequest,
  stringArray,
  type ResolvedNames,
  type Preferences,
  type EmbedRequestRow,
} from './render.ts'
import { parseRequest, planFor, buildAgentPostText, buildAgentPostOpts, classifyCaller, normalizeSecret, type Req, type Plan, type Caller } from './request.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// Server constant for the embed URL's origin — same pattern as
// notify-feedback's BASE_URL. NEVER derived from a request header (a
// Host-header-derived origin would let a caller rewrite the script src in
// the posted message).
const PUBLIC_SITE_URL = Deno.env.get('PUBLIC_SITE_URL') || 'https://akronpulse.com'

// The shared secret the DB triggers send as X-Slack-Notify-Secret (set via
// `supabase secrets set SLACK_NOTIFY_SECRET=...`, matching the Vault value
// Byron creates by hand per 045's header — never committed to a migration).
// Read once at cold start, not per-request, so a missing secret is visible
// in the cold-start log line below rather than only surfacing on first call.
// normalizeSecret (request.ts) trims whitespace before the falsy-check —
// see its docstring for why: HTTP strips optional leading/trailing
// whitespace from header VALUES, but Deno.env.get() does not, so without
// this an operator slip in `supabase secrets set` (a trailing space or
// newline picked up by copy-paste) would silently void the SECRETS_COLLIDE
// guard below.
const SLACK_NOTIFY_SECRET = normalizeSecret(Deno.env.get('SLACK_NOTIFY_SECRET'))

// The shared secret Tier 2 agent callers send as X-Slack-Agent-Secret —
// task-side, deliberately distinct from SLACK_NOTIFY_SECRET (see
// .env.example / README's Slack section). Missing/unset is NOT itself an
// error at cold start: it just means the agent_post arm 401s on every call
// while the three Tier 1 arms keep working off SLACK_NOTIFY_SECRET alone —
// see the auth gate below for how that fail-closed-per-tier behavior is
// implemented.
// Same whitespace-normalization reasoning as SLACK_NOTIFY_SECRET above.
const SLACK_AGENT_SECRET = normalizeSecret(Deno.env.get('SLACK_AGENT_SECRET'))

// Cold-start env audit. Same pattern as notify-feedback/index.ts:37-41 (the
// Slack-specific secrets are audited in ../_shared/slack.ts, which every
// caller of postMessage() imports).
console.log('[slack-notify] cold start', {
  has_SUPABASE_URL: !!Deno.env.get('SUPABASE_URL'),
  has_SUPABASE_SERVICE_ROLE_KEY: !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  has_SLACK_NOTIFY_SECRET: !!SLACK_NOTIFY_SECRET,
  has_SLACK_AGENT_SECRET: !!SLACK_AGENT_SECRET,
})

// A shared value would silently void the capability split entirely: a holder
// of either secret could move it to the other header slot and be classified
// as the other caller. Fail closed on Tier 2 only — Tier 1 must not break.
// (classifyCaller in request.ts independently enforces this at classification
// time; this cold-start check exists so the misconfiguration is loud in the
// logs the moment the function boots, not only discoverable by noticing every
// agent_post call quietly 401ing.)
const SECRETS_COLLIDE =
  !!SLACK_NOTIFY_SECRET && SLACK_NOTIFY_SECRET === SLACK_AGENT_SECRET
if (SECRETS_COLLIDE) {
  console.error('[slack-notify] SLACK_NOTIFY_SECRET and SLACK_AGENT_SECRET are set to the SAME value — the capability split is void. Disabling the agent arm until they differ.')
}

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

async function settle(
  rowId: number,
  status: 'sent' | 'failed',
  extra: { slack_ts?: string; error?: string; thread_ts?: string },
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
  // Classification itself lives in request.ts's classifyCaller (unit-tested
  // directly there against the full matrix: both unset, notify-only,
  // agent-only, both set, both set to the SAME value, empty-string header,
  // empty-string secret, secret in the wrong header slot, both headers sent
  // at once) — this is the outermost auth boundary on a verify_jwt=false
  // endpoint, so it gets its own module and its own tests rather than living
  // inline here where it previously had none:
  //   caller = 'trigger' if X-Slack-Notify-Secret matches SLACK_NOTIFY_SECRET
  //          = 'agent'   if X-Slack-Agent-Secret  matches SLACK_AGENT_SECRET
  //            AND the two secrets are not equal (see SECRETS_COLLIDE above)
  //          = null      otherwise -> 401
  // Both compares are timing-safe. PRECEDENCE: the notify header is checked
  // first and wins on a match — a caller sending both correct headers at
  // once always classifies 'trigger', never 'agent' (see classifyCaller's
  // docstring for why that tie-break is the safe default). A caller sending
  // only its own header still classifies correctly by that header alone.
  //
  // FAIL CLOSED, PER TIER: if SLACK_AGENT_SECRET is unset (or collides with
  // SLACK_NOTIFY_SECRET), no header can ever classify as 'agent', so
  // agent_post 401s on every call — but the three Tier 1 arms keep working
  // off SLACK_NOTIFY_SECRET alone. A Tier 2 misconfiguration must never break
  // Tier 1; this is what makes that true structurally rather than by
  // convention. Symmetric if SLACK_NOTIFY_SECRET is the one that's unset.
  // Only if NEITHER secret is configured at all do we log a distinct "not
  // configured" error (a deploy-time misconfiguration, not something a
  // caller can trigger) before rejecting everything.
  if (!SLACK_NOTIFY_SECRET && !SLACK_AGENT_SECRET) {
    console.error('[slack-notify] neither SLACK_NOTIFY_SECRET nor SLACK_AGENT_SECRET is configured on this function — rejecting all requests until at least one is set')
    return json({ error: 'Not configured' }, 401)
  }

  const caller: Caller | null = classifyCaller(
    {
      notify: req.headers.get('X-Slack-Notify-Secret'),
      agent: req.headers.get('X-Slack-Agent-Secret'),
    },
    { notify: SLACK_NOTIFY_SECRET, agent: SLACK_AGENT_SECRET },
    timingSafeEqualStrings,
  )
  if (!caller) {
    console.warn('[slack-notify] rejected request: no matching X-Slack-Notify-Secret or X-Slack-Agent-Secret header')
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const rawBody = await req.json().catch(() => null)
    const parsed: Req | null = parseRequest(rawBody)
    if (!parsed) {
      return json({ error: 'invalid request body' }, 400)
    }

    const planResult = planFor(parsed, caller)
    if (!planResult.ok) {
      // Distinguishable from the 401 above: this caller authenticated fine,
      // but with the wrong secret for the event type it's asking for (a
      // notify-secret holder attempting agent_post, or an agent-secret
      // holder attempting a Tier 1 arm). Logged separately so a burst of
      // these reads as "someone/something is using the wrong credential for
      // this event," not "someone is probing with no credential at all."
      console.warn('[slack-notify] rejected request: caller not permitted for this event', { caller, event: parsed.event })
      return json({ error: 'Forbidden' }, 403)
    }
    const plan: Plan = planResult.plan

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
      // Re-read the conflicting row's slack_ts (rather than returning a bare
      // skip, as before) — a retry needs the root message's ts to thread a
      // follow-up under, and slack_ts is a public message id the caller is
      // already authenticated to have posted, so surfacing it here is purely
      // additive. Any error re-reading is logged but never turned into a
      // failure response: the original claim/post already succeeded (or is
      // in flight), and this row is a lookup convenience, not a retry of the
      // claim itself.
      const { data: existing, error: existingErr } = await supabase
        .from('slack_notifications')
        .select('slack_ts')
        .eq('dedupe_key', plan.dedupeKey)
        .maybeSingle()
      if (existingErr) {
        console.error('[slack-notify] duplicate re-read failed', { dedupe_key: plan.dedupeKey, existingErr })
      }
      return json({ ok: true, skipped: 'duplicate', slack_ts: existing?.slack_ts ?? null })
    }

    const rowId = claimed.id as number
    // Only agent_post ever carries a caller-supplied thread_ts. Threaded here
    // (not inside the per-event branch below) so both the success and
    // failure settle() calls persist it — audit-only (046's header comment),
    // never read back by any code path, purely so a human reading the ledger
    // can see the threading relationship on a retry.
    const requestThreadTs = parsed.event === 'agent_post' ? parsed.thread_ts : undefined

    try {
      let text: string
      let postOpts: PostOpts = {}

      if (parsed.event === 'agent_post') {
        text = buildAgentPostText(parsed)
        postOpts = buildAgentPostOpts(parsed)
      } else if (parsed.event === 'feedback') {
        const { data: fb, error: fbErr } = await supabase
          .from('feedback_posts')
          // email (migration 058): optional reply-to address the submitter
          // may have left. Added to this hardcoded allowlist deliberately —
          // same policy note as the embed_request branch below.
          .select('id, body, page_path, created_at, email')
          .eq('id', parsed.id)
          .maybeSingle()

        if (fbErr || !fb) {
          console.error('[slack-notify] feedback row not found', { id: parsed.id, fbErr })
          await settle(rowId, 'failed', { error: 'row not found' })
          return json({ ok: true, skipped: 'row not found' })
        }

        text = renderFeedback(fb)
      } else if (parsed.event === 'embed_request') {
        // HARD REQUIREMENT: hardcoded column allowlist, never select('*').
        // Mirrors the subscribers re-read below — this is Tier 1 in kind,
        // rendering from a server-side re-read of a real row, never from
        // the POST body (the body only ever carries { request_id }).
        const { data: reqRow, error: reqErr } = await supabase
          .from('embed_requests')
          .select('id, name, email, organization, website, note, config, embed_path, created_at')
          .eq('id', parsed.id)
          .maybeSingle()

        if (reqErr || !reqRow) {
          console.error('[slack-notify] embed_requests row not found', { id: parsed.id, reqErr })
          await settle(rowId, 'failed', { error: 'row not found' })
          return json({ ok: true, skipped: 'row not found' })
        }

        const cfg = normalizeConfig(reqRow.config)
        // embed_path was already derived and persisted by notify-embed-request
        // at claim time; recompute the URL/snippet here from the same
        // normalizeConfig output rather than trusting the stored string
        // verbatim in a Slack message — this re-derivation is deterministic
        // and cheap, and keeps this function's output independent of
        // whatever notify-embed-request happened to write.
        const url = buildEmbedUrl(PUBLIC_SITE_URL, cfg)
        const snippet = buildIframeSnippet(PUBLIC_SITE_URL, cfg)
        const row: EmbedRequestRow = {
          id: reqRow.id,
          name: reqRow.name,
          email: reqRow.email,
          organization: reqRow.organization,
          website: reqRow.website,
          note: reqRow.note,
          config: reqRow.config,
          created_at: reqRow.created_at,
        }
        text = renderEmbedRequest(row, snippet, url)
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

      const result = await postMessage(plan.channelKey, text, postOpts)

      if (!result.ok) {
        console.error('[slack-notify] post failed', { dedupe_key: plan.dedupeKey, error: result.error })
        await settle(rowId, 'failed', { error: result.error, ...(requestThreadTs !== undefined ? { thread_ts: requestThreadTs } : {}) })
        return json({ error: 'Slack send failed' }, 502)
      }

      await settle(rowId, 'sent', { slack_ts: result.ts, ...(requestThreadTs !== undefined ? { thread_ts: requestThreadTs } : {}) })
      console.log('[slack-notify] sent', { dedupe_key: plan.dedupeKey, channel_key: plan.channelKey, slack_ts: result.ts })
      return json({ ok: true, slack_ts: result.ts })
    } catch (err) {
      console.error('[slack-notify] render/post fatal', err)
      await settle(rowId, 'failed', { error: err instanceof Error ? err.message : String(err), ...(requestThreadTs !== undefined ? { thread_ts: requestThreadTs } : {}) })
      return json({ error: 'Internal error' }, 500)
    }
  } catch (err) {
    console.error('[slack-notify] fatal', err)
    return json({ error: 'Internal error' }, 500)
  }
})
