/**
 * request.ts — pure request parsing, planning, and Tier 2 payload-prep logic
 * for slack-notify.
 *
 * Split out from index.ts (which owns Deno.serve, the Supabase client, and
 * the shared-secret auth gate) for the same reason render.ts is split out
 * from index.ts: everything here is a plain function of its arguments, so it
 * can be unit-tested directly (request.test.ts) without a live server, a
 * database, or a Slack workspace — mirrors render.ts/render.test.ts exactly.
 */

import {
  escapeSlackText,
  SLACK,
  AGENT_IDENTITIES,
  type ChannelKey,
  type PostOpts,
} from '../_shared/slack.ts'

// ── Discriminated request body ──────────────────────────────────────────
//
// Tier 1 implements the first three arms (fired only by the DB triggers in
// supabase/migrations/045_slack_triggers.sql). `agent_post` is Tier 2: an
// agent-authored report, posted by a caller holding SLACK_AGENT_SECRET (see
// index.ts's auth gate) rather than a DB trigger holding SLACK_NOTIFY_SECRET.
//
// `agent` is typed as `string`, not `AgentId` — an unrecognized value must
// fall back to the default SLACK identity rather than fail request parsing
// (see resolveAgentIdentity below), so parseRequest never rejects on this
// field's *value*, only on its *presence/type*.
export type Req =
  | { event: 'feedback'; id: number }
  | { event: 'subscriber_signup'; id: string }
  | { event: 'subscriber_confirmed'; id: string }
  | {
      event: 'agent_post'
      kind: 'daily_report' | 'night_crew'
      run_key: string
      agent: string
      text: string
      thread_ts?: string
    }

// run_key becomes half of the dedupe key (`{daily_report,night_crew}:{run_key}`)
// — see planFor's comment for why the caller supplies only this half, never a
// full dedupe_key. Bounded to 80 chars, alnum plus `. _ : -`, so it can never
// contain the DB's own dedupe-key separator ambiguity, a `/`, whitespace, or
// anything else that would make a run_key confusing to read in the ledger.
export const RUN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

// Slack message `ts` shape: <10-digit unix seconds>.<6-digit fractional part>.
export const THREAD_TS_RE = /^\d{10}\.\d{6}$/

/**
 * Normalize a raw shared-secret env-var value the way HTTP already
 * normalizes the header value it's compared against: HTTP strips optional
 * leading/trailing whitespace from header VALUES, but `Deno.env.get()` does
 * not apply the same normalization to env vars. Without this, an operator
 * slip in `supabase secrets set` (a trailing space or newline picked up by
 * copy-paste — common) produces two secrets that are byte-identical over the
 * wire (after HTTP's own stripping) but `!==` each other in
 * `classifyCaller`'s comparison, silently voiding the SECRETS_COLLIDE guard:
 * an agent-secret holder whose value happens to equal the trimmed notify
 * secret could move it into the notify header slot and classify as
 * 'trigger'. Extracted as its own function (rather than inlined at each of
 * index.ts's two call sites) so this normalization is unit-tested directly,
 * the same reason classifyCaller itself was pulled out of index.ts.
 *
 * Returns null for an unset, empty, or whitespace-only value — same shape
 * index.ts previously got from `Deno.env.get(...) || null`. Nothing
 * meaningful is lost by trimming: a secret whose only distinguishing
 * characters are surrounding whitespace is unusable anyway, since HTTP
 * strips that whitespace from the header before classifyCaller ever sees
 * it. Same precedent as _shared/slack.ts:53 resolveChannel's `id.trim()`.
 */
export function normalizeSecret(raw: string | null | undefined): string | null {
  return (raw ?? '').trim() || null
}

// `agent` charset/length guard. Every other agent_post field is bounded
// (`text` at MAX_AGENT_TEXT_LEN, `run_key` at 80 chars plus a charset,
// `thread_ts` by THREAD_TS_RE) except `agent`, which used to accept any
// string at all. resolveAgentIdentity's unknown-agent fallback means an
// out-of-charset value is harmless to Slack (it never reaches Slack — it
// falls back to the default identity) and never a security issue, but an
// unbounded `agent` is free log volume: it is emitted verbatim by
// resolveAgentIdentity's `console.warn` on every unrecognized value, so an
// authenticated agent-secret holder could otherwise write megabytes into the
// function logs per request. Real agent ids (.claude/agents/*.md basenames)
// are short lowercase-alnum-hyphen strings, so this is generous headroom,
// not a tight fit: 40 chars comfortably exceeds the longest real id
// ('code-reviewer', 13 chars) and matches RUN_KEY_RE's shape (minus the
// leading-alnum requirement, since 'agent' has no such constraint today).
export const AGENT_ID_RE = /^[a-z0-9-]{0,40}$/

// Tier 2 free-text cap. Unlike Tier 1's renderers (which cap at 3000 code
// points via render.ts's capMessage), agent-authored text is truncated with
// an explicit marker rather than silently clamped, so a caller can tell at a
// glance that its report was cut — and the request is never rejected outright
// for being long, matching this integration's stated intent (a report is more
// valuable partially delivered than not delivered at all).
export const MAX_AGENT_TEXT_LEN = 2800
export const AGENT_TEXT_TRUNCATION_MARKER = '…[truncated]'

/** Truncate by CODE POINT (never mid-surrogate-pair), same reasoning as render.ts's capMessage/clampLabel. */
export function truncateAgentText(text: string): string {
  const chars = [...text]
  return chars.length > MAX_AGENT_TEXT_LEN
    ? chars.slice(0, MAX_AGENT_TEXT_LEN).join('') + AGENT_TEXT_TRUNCATION_MARKER
    : text
}

/**
 * Parse + validate the discriminated request body. Returns null for
 * anything malformed — index.ts turns a null into a 400 before any Supabase
 * call or fetch, so every rejection below (including a malformed thread_ts)
 * happens before any network I/O.
 *
 * `agent`'s value is intentionally NOT validated against the AgentId enum
 * here — see resolveAgentIdentity's comment for why an unrecognized value
 * must fall back to the default identity rather than 400 this request. It IS
 * bounded by AGENT_ID_RE (charset + 40-char length) purely to cap log
 * volume — an out-of-charset or over-long value is normalized to '' (the
 * same fail-safe resolveAgentIdentity already applies to any unrecognized
 * string) rather than rejecting the request.
 */
export function parseRequest(body: unknown): Req | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>

  // Every field is read into a const EXACTLY ONCE and every subsequent check
  // and the returned value both use that same const — never `b.<field>`
  // again after this point. `body` is untrusted input; if it were ever
  // something other than the result of `JSON.parse` (a getter-backed object,
  // e.g. from a future caller that builds the body programmatically rather
  // than parsing JSON text), reading the same property twice could observe
  // two different values — validate one, use another (TOCTOU). A getter
  // that returns 'daily_report' on read #1 (validation) and something else
  // read #2 (use) would let an unvalidated value leak into a Req the rest of
  // this function treats as validated. Plain JSON.parse output can't produce
  // getters, so this isn't reachable via index.ts's actual request path
  // today, but this module is now shared/exported and unit-tested directly
  // against arbitrary objects, so it must hold for any caller.
  const event = b.event

  if (event === 'feedback') {
    const id = b.id
    if (typeof id === 'number' && Number.isFinite(id)) {
      return { event: 'feedback', id }
    }
    return null
  }
  if (event === 'subscriber_signup') {
    const id = b.id
    if (typeof id === 'string' && id) {
      return { event: 'subscriber_signup', id }
    }
    return null
  }
  if (event === 'subscriber_confirmed') {
    const id = b.id
    if (typeof id === 'string' && id) {
      return { event: 'subscriber_confirmed', id }
    }
    return null
  }
  if (event === 'agent_post') {
    const kind = b.kind
    if (kind !== 'daily_report' && kind !== 'night_crew') return null

    const runKey = b.run_key
    if (typeof runKey !== 'string' || !RUN_KEY_RE.test(runKey)) return null

    const text = b.text
    if (typeof text !== 'string' || text.length === 0) return null

    let threadTs: string | undefined
    const rawThreadTs = b.thread_ts
    if (rawThreadTs !== undefined) {
      if (typeof rawThreadTs !== 'string' || !THREAD_TS_RE.test(rawThreadTs)) return null
      threadTs = rawThreadTs
    }

    // A missing/non-string/charset-violating/over-long `agent` becomes '' —
    // resolveAgentIdentity treats any unrecognized string (including '') as
    // "use the default identity." This is a normalization, not a rejection:
    // an out-of-charset or over-long agent must not fail the whole request
    // (same reasoning as resolveAgentIdentity's own unknown-id fallback) —
    // it's just not trustworthy to pass through to resolveAgentIdentity (and
    // its console.warn) as-is, so AGENT_ID_RE is enforced one step earlier.
    const rawAgent = b.agent
    const agent = typeof rawAgent === 'string' && AGENT_ID_RE.test(rawAgent) ? rawAgent : ''

    return {
      event: 'agent_post',
      kind,
      run_key: runKey,
      agent,
      text: truncateAgentText(text),
      ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
    }
  }
  return null
}

// ── Planning ─────────────────────────────────────────────────────────────

export interface Plan {
  dedupeKey: string
  kind: 'feedback' | 'subscriber_signup' | 'subscriber_confirmed' | 'daily_report' | 'night_crew'
  channelKey: ChannelKey
}

export type Caller = 'trigger' | 'agent'

/**
 * Classify the caller from the two shared-secret headers. Extracted from
 * index.ts's auth gate so it's a pure function of its arguments and gets
 * direct unit coverage — this is the outermost auth boundary on a
 * `verify_jwt = false` endpoint, and until this extraction it was the only
 * component of the Tier 2 security model with zero unit coverage.
 *
 * `eq` is an injected constant-time comparator (index.ts passes
 * timingSafeEqualStrings; tests pass a plain `(a, b) => a === b` so this file
 * never needs `jsr:@std/crypto`). PRECEDENCE: the notify header is checked
 * first and returns immediately on a match — a caller sending BOTH correct
 * headers at once is always classified 'trigger', never 'agent'. This is the
 * safe default: Tier 1 (trigger) can only ever claim/read/render its three
 * fixed event shapes off server-side data, while Tier 2 (agent) can only
 * post caller-authored text into two fixed channels — trigger is the more
 * restricted, more trusted capability, so ties resolve toward it rather than
 * toward the free-text arm. A caller sending only the agent header (the
 * common case) is unaffected by this ordering and still classifies 'agent'
 * normally; the wrong-header-slot case (a caller sending its own secret in
 * the other role's header) is handled separately by the SECRETS-COLLIDE
 * guard and the `secrets.notify && secrets.agent` comparisons below, not by
 * this ordering.
 *
 * SECRETS-COLLIDE GUARD: if SLACK_NOTIFY_SECRET and SLACK_AGENT_SECRET are
 * ever set to the same value, the two-header capability split is void — a
 * holder of either secret could move it into the other header slot and be
 * classified as the other caller, reaching Tier 1's DB-claim capability from
 * a task-side secret meant to be contained to `agent_post`. Rather than
 * detect this as an error, this function fails closed on the 'agent' arm
 * only: a colliding SLACK_AGENT_SECRET is treated as if it were unset, so
 * 'trigger' classification (Tier 1) is completely unaffected and only Tier 2
 * 401s. The cold-start log in index.ts additionally surfaces this
 * misconfiguration loudly so it doesn't go unnoticed.
 *
 * FAIL CLOSED, PER TIER (verified, must not regress): `secrets.notify`/
 * `secrets.agent` being falsy (env var unset, or coerced from an empty
 * string to null by index.ts's `Deno.env.get(...) || null`) means that arm
 * can never classify, regardless of what the caller sends — including an
 * empty-string header, which can never equal a falsy secret. A Tier 2
 * misconfiguration (unset or colliding SLACK_AGENT_SECRET) must never break
 * Tier 1, and this structure is what makes that true rather than relying on
 * convention.
 */
export function classifyCaller(
  headers: { notify: string | null; agent: string | null },
  secrets: { notify: string | null; agent: string | null },
  eq: (a: string, b: string) => boolean,
): Caller | null {
  const notifyProvided = headers.notify ?? ''
  if (secrets.notify && notifyProvided && eq(notifyProvided, secrets.notify)) {
    return 'trigger'
  }

  const secretsCollide = !!secrets.notify && secrets.notify === secrets.agent
  if (secrets.agent && !secretsCollide) {
    const agentProvided = headers.agent ?? ''
    if (agentProvided && eq(agentProvided, secrets.agent)) {
      return 'agent'
    }
  }

  return null
}

const TIER1_EVENTS = new Set(['feedback', 'subscriber_signup', 'subscriber_confirmed'])

/**
 * Dedupe keys: feedback:{id}, subscriber_signup:{uuid}, subscriber_confirmed:{uuid},
 * daily_report:{run_key}, night_crew:{run_key}.
 *
 * THE MOST IMPORTANT HOLE THIS CLOSES: the caller supplies only `run_key`,
 * never a raw `dedupe_key` — this function derives the full key by prefixing
 * with the fixed `kind` string. If a caller could instead supply an arbitrary
 * dedupe_key directly, an agent-secret holder could POST
 * `dedupe_key: 'subscriber_signup:<real-uuid>'` and permanently suppress that
 * real Tier 1 notification: the ledger is claim-first and at-most-once (ON
 * CONFLICT DO NOTHING), so a pre-burned key silently never posts again, with
 * no error anywhere for anyone to notice. Prefixing with the caller's own
 * fixed `kind` namespaces every Tier 2 key into its own space — a run_key of
 * literally `subscriber_signup:<uuid>` still produces
 * `night_crew:subscriber_signup:<uuid>`, which cannot collide with the real
 * `subscriber_signup:<uuid>` key Tier 1 uses.
 *
 * CAPABILITY SPLIT: `caller==='trigger'` (holds SLACK_NOTIFY_SECRET) may only
 * use the three Tier 1 arms; `caller==='agent'` (holds SLACK_AGENT_SECRET) may
 * only use `agent_post`. Any cross-use returns `{ok:false}` — index.ts turns
 * that into a 403, logged distinguishably from an auth-gate 401 so Byron can
 * tell "wrong secret for this event type" from "no valid secret at all."
 *
 * ALLOWLIST, NOT DENYLIST: this is deliberately an if/else-if/else chain that
 * denies by default, not two independent negative checks. Two denylists
 * (`if (trigger) deny non-tier1`, `if (agent) deny non-agent_post`) fail OPEN
 * for any caller value neither check names — `planFor(req, 'admin')` would
 * fall through both checks and reach the switch with full cross-tier
 * capability. Not reachable today (index.ts's classifyCaller only ever
 * returns `'trigger' | 'agent' | null`), but Tier 3 is already scaffolded as
 * commented-out lines in _shared/slack.ts (ChannelKey's
 * `'ask-the-developers'`), and whoever uncomments it and adds a third caller
 * class must not silently inherit Tier 1/2 capability from this function.
 */
export function planFor(req: Req, caller: Caller): { ok: true; plan: Plan } | { ok: false } {
  if (caller === 'trigger') {
    if (!TIER1_EVENTS.has(req.event)) return { ok: false }
  } else if (caller === 'agent') {
    if (req.event !== 'agent_post') return { ok: false }
  } else {
    return { ok: false }
  }

  switch (req.event) {
    case 'feedback':
      return { ok: true, plan: { dedupeKey: `feedback:${req.id}`, kind: 'feedback', channelKey: 'public-feedback' } }
    case 'subscriber_signup':
      return {
        ok: true,
        plan: { dedupeKey: `subscriber_signup:${req.id}`, kind: 'subscriber_signup', channelKey: 'public-new-email-subscribers' },
      }
    case 'subscriber_confirmed':
      return {
        ok: true,
        plan: { dedupeKey: `subscriber_confirmed:${req.id}`, kind: 'subscriber_confirmed', channelKey: 'public-new-email-subscribers' },
      }
    case 'agent_post': {
      // Channel-allowlist invariant: an agent_post plan's channelKey can only
      // ever be one of these two literals — there is no code path from this
      // switch arm to 'public-feedback' or 'public-new-email-subscribers'.
      //
      // An explicit lookup table with an else-throw (rather than a
      // `req.kind === 'daily_report' ? … : …` ternary fallthrough) so the
      // invariant is visible AT THIS SITE — parseRequest already restricts
      // `kind` to these two literals, but a ternary's `else` branch silently
      // covers "anything that isn't daily_report" rather than naming
      // `night_crew` explicitly, which is easy to miss when this switch is
      // the one place whose header comment claims the allowlist.
      const AGENT_POST_CHANNELS: Record<'daily_report' | 'night_crew', ChannelKey> = {
        daily_report: 'daily-reports',
        night_crew: 'the-night-crew',
      }
      const channelKey = AGENT_POST_CHANNELS[req.kind]
      if (!channelKey) {
        throw new Error(`planFor: no channel mapping for agent_post kind "${req.kind}"`)
      }
      return { ok: true, plan: { dedupeKey: `${req.kind}:${req.run_key}`, kind: req.kind, channelKey } }
    }
  }
}

// ── Tier 2 payload prep ───────────────────────────────────────────────────

type AgentPostReq = Extract<Req, { event: 'agent_post' }>

/**
 * `agent` -> the identity Slack actually displays. An unrecognized agent id
 * (persona typo, a role removed from .claude/agents/, a future role not yet
 * added here) falls back to the default SLACK identity ('Akron Pulse')
 * rather than failing the request — a typo in a report's persona must not
 * cost the report itself.
 */
export function resolveAgentIdentity(agent: string): { username: string; iconUrl: string | null } {
  // Object.hasOwn (not a bare index/`in` lookup) so an `agent` value like
  // 'constructor', '__proto__', or 'toString' can't resolve to something
  // inherited off Object.prototype (e.g. the `Object` constructor function
  // itself, which is truthy, so `?? default` below would never fire) —
  // the docstring above promises the default identity for any unrecognized
  // value, and prototype-chain properties are not a recognized agent id.
  const known = Object.hasOwn(AGENT_IDENTITIES, agent)
    ? (AGENT_IDENTITIES as Record<string, { username: string; iconUrl: string }>)[agent]
    : undefined
  if (!known) {
    // A silent fallback here means a typo'd persona (or a role retired from
    // .claude/agents/ but still referenced by a stale task prompt) posts
    // under the default identity for as long as nobody notices — log it so
    // that's visible instead of silent.
    console.warn('[slack-notify] unrecognized agent id, posting under the default identity', { agent })
  }
  return known ?? { username: SLACK.username, iconUrl: SLACK.iconUrl }
}

// Post-escape safety cap. MAX_AGENT_TEXT_LEN (2800) bounds the RAW text
// before escaping, but escapeSlackText can expand a pathological payload
// (e.g. 2,800 `&` characters) to up to 5x its length — 14,012 chars, still
// under Slack's ~40,000-char hard ceiling but well past the ~4,000 chars
// Slack actually renders before truncating client-side. This is a belt-only
// safety net on top of MAX_AGENT_TEXT_LEN, not a replacement for it: normal
// reports (mostly letters/digits/whitespace) never come close to either cap.
export const MAX_ESCAPED_AGENT_TEXT_LEN = 3900

/**
 * The exact text this arm sends to Slack. escapeSlackText runs unconditionally
 * — this is what makes agent_post structurally incapable of emitting
 * `<!channel>`, `<!here>`, `<@U…>`, or a masked `<url|label>` link, no matter
 * what an agent-secret holder puts in `text`. Truncation of the RAW text
 * already happened in parseRequest (before this ever runs); the cap applied
 * here is a second, post-escape cap for the pathological-expansion case
 * described at MAX_ESCAPED_AGENT_TEXT_LEN above. A cut mid-entity (e.g. a
 * dangling `&am`) is cosmetically ugly but not unsafe — Slack renders it as
 * inert literal text, not a re-parsed entity.
 */
export function buildAgentPostText(req: AgentPostReq): string {
  const escaped = escapeSlackText(req.text)
  const chars = [...escaped]
  return chars.length > MAX_ESCAPED_AGENT_TEXT_LEN
    ? chars.slice(0, MAX_ESCAPED_AGENT_TEXT_LEN).join('') + AGENT_TEXT_TRUNCATION_MARKER
    : escaped
}

/** Identity + threading options to hand to postMessage's third parameter. */
export function buildAgentPostOpts(req: AgentPostReq): PostOpts {
  const identity = resolveAgentIdentity(req.agent)
  const opts: PostOpts = { username: identity.username, iconUrl: identity.iconUrl }
  if (req.thread_ts !== undefined) {
    opts.threadTs = req.thread_ts
  }
  return opts
}
