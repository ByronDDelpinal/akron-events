/**
 * _shared/slack.ts — Slack notification primitives for Tier 1 and Tier 2
 * (agent-authored reports) notifications. Tier 3 ('ask-the-developers') is
 * not wired up yet — see ChannelKey/CHANNEL_ENV_VARS below.
 *
 * Mirrors the shape of _shared/email.ts: theme identity, an escape helper,
 * and a single send primitive live here so every Slack-facing caller renders
 * and escapes the same way. The only current caller is slack-notify/index.ts,
 * invoked by the three Tier 1 DB triggers in
 * supabase/migrations/045_slack_triggers.sql and by Tier 2's `agent_post`
 * request arm (agent-side callers authenticated with SLACK_AGENT_SECRET).
 *
 * Channels are addressed by a logical ChannelKey, never a raw Slack channel
 * id — resolveChannel() maps a key to the env var that holds the real `C…`
 * id, so callers (and tests) never see or hardcode channel ids.
 */

// Bot identity applied to every posted message. iconUrl is optional — Slack
// falls back to the bot's configured avatar when it's null.
export const SLACK = {
  username: 'Akron Pulse',
  iconUrl: Deno.env.get('SLACK_ICON_URL') ?? null,
} as const

// Tier 1 wires the first two channels; Tier 2 (agent-authored reports) adds
// the next two. 'ask-the-developers' is Tier 3 and stays commented out below
// (both here and in CHANNEL_ENV_VARS) — wiring it up for real is a one-line
// uncomment in each place plus setting the matching env var.
export type ChannelKey =
  | 'public-feedback'
  | 'public-new-email-subscribers'
  | 'daily-reports'
  | 'the-night-crew'
  // | 'ask-the-developers'

// Logical key -> env var name holding the real Slack channel id. Keeping
// this as an explicit map (rather than deriving the env var name from the
// key) means the env var naming is free to not match the key spelling, and
// a missing/renamed secret fails closed (resolveChannel returns null)
// instead of posting to a wrong or malformed channel string.
const CHANNEL_ENV_VARS: Record<ChannelKey, string> = {
  'public-feedback': 'SLACK_CHANNEL_PUBLIC_FEEDBACK',
  'public-new-email-subscribers': 'SLACK_CHANNEL_NEW_EMAIL_SUBSCRIBERS',
  'daily-reports': 'SLACK_CHANNEL_DAILY_REPORTS',
  'the-night-crew': 'SLACK_CHANNEL_THE_NIGHT_CREW',
  // 'ask-the-developers': 'SLACK_CHANNEL_ASK_THE_DEVELOPERS',
}

/** Resolve a logical channel key to the real Slack channel id, or null if unset. */
export function resolveChannel(key: ChannelKey): string | null {
  const envVar = CHANNEL_ENV_VARS[key]
  const id = envVar ? Deno.env.get(envVar) : undefined
  return id && id.trim() ? id.trim() : null
}

// Tier 2 agent identity registry — server-side only. An `agent_post` request
// (slack-notify/index.ts) names which of our own role agents authored the
// report; this map is what turns that id into the username/avatar Slack
// actually displays, so a caller can never supply arbitrary display text or
// an arbitrary avatar URL of their own choosing (that would defeat the point
// of a fixed identity registry — anyone holding SLACK_AGENT_SECRET could
// otherwise impersonate any name/avatar in the channel).
//
// One entry per role file under .claude/agents/*.md, EXCLUDING README.md
// (that file documents the roles, it isn't one). Kept in sync by
// scripts/tests/test-slack-agent-identities.js, which fails CI on drift the
// same way test-slack-category-labels.js does for CATEGORY_LABELS.
//
// iconUrl filenames are versioned (`-v1.png`) ON PURPOSE: Slack caches
// `icon_url` per URL indefinitely (there is no cache-busting query-param
// convention Slack respects), so a future avatar redesign must ship under a
// NEW versioned URL (`-v2.png`) rather than overwriting the image at the old
// one — overwriting in place would leave some channel members seeing the old
// avatar and others the new one, unpredictably, for as long as Slack's CDN
// cache happens to hold the old response.
export type AgentId =
  | 'architect'
  | 'developer'
  | 'code-reviewer'
  | 'qa'
  | 'data-steward'
  | 'analyst'
  | 'support'

export const AGENT_IDENTITIES: Readonly<Record<AgentId, { username: string; iconUrl: string }>> = Object.freeze({
  'architect':     { username: 'Architect',     iconUrl: 'https://akronpulse.com/agents/architect-v1.png' },
  'developer':     { username: 'Developer',     iconUrl: 'https://akronpulse.com/agents/developer-v1.png' },
  'code-reviewer': { username: 'Code Reviewer', iconUrl: 'https://akronpulse.com/agents/code-reviewer-v1.png' },
  'qa':            { username: 'QA',            iconUrl: 'https://akronpulse.com/agents/qa-v1.png' },
  'data-steward':  { username: 'Data Steward',  iconUrl: 'https://akronpulse.com/agents/data-steward-v1.png' },
  'analyst':       { username: 'Analyst',       iconUrl: 'https://akronpulse.com/agents/analyst-v1.png' },
  'support':       { username: 'Support',       iconUrl: 'https://akronpulse.com/agents/support-v1.png' },
})

/**
 * Escape untrusted text for Slack mrkdwn. Slack's own escaping contract is
 * narrower than HTML's — only &, <, > are special (no quote escaping) — and
 * order matters: & MUST run first, or the &lt;/&gt; this function just
 * produced would themselves get their ampersand re-escaped a moment later
 * (double-encoding). Apply to feedback bodies, email addresses, keywords,
 * and every resolved org/venue name before it reaches a rendered message.
 */
export function escapeSlackText(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

// Cold-start env audit. Same pattern as notify-feedback/index.ts:37-41 —
// surface missing secrets in the logs instead of debugging a silent failure
// later. Lives here (not in slack-notify/index.ts) because this module owns
// every Slack-specific env var; any future caller importing it gets the
// same audit for free.
console.log('[_shared/slack] cold start', {
  has_SLACK_BOT_TOKEN: !!Deno.env.get('SLACK_BOT_TOKEN'),
  has_SLACK_CHANNEL_PUBLIC_FEEDBACK: !!Deno.env.get('SLACK_CHANNEL_PUBLIC_FEEDBACK'),
  has_SLACK_CHANNEL_NEW_EMAIL_SUBSCRIBERS: !!Deno.env.get('SLACK_CHANNEL_NEW_EMAIL_SUBSCRIBERS'),
  has_SLACK_CHANNEL_DAILY_REPORTS: !!Deno.env.get('SLACK_CHANNEL_DAILY_REPORTS'),
  has_SLACK_CHANNEL_THE_NIGHT_CREW: !!Deno.env.get('SLACK_CHANNEL_THE_NIGHT_CREW'),
  has_SLACK_ICON_URL: !!Deno.env.get('SLACK_ICON_URL'),
  has_SLACK_AGENT_SECRET: !!Deno.env.get('SLACK_AGENT_SECRET'),
})

/**
 * Per-call override of the identity/threading a message posts under. Every
 * field is optional and the default (`{}`) must reproduce today's Tier 1
 * payload byte-for-byte — see postMessage's own comment for the exact
 * defaulting rules this type exists to support.
 */
export type PostOpts = {
  username?: string
  iconUrl?: string | null
  threadTs?: string
}

/**
 * Post a plain-text mrkdwn message to a logical channel.
 *
 * Slack's chat.postMessage returns HTTP 200 even on failure — the body
 * carries `{ok:false,error:'...'}` instead of a non-2xx status. This is the
 * same trap documented at subscribe/index.ts:163-181 for the Resend SDK:
 * never trust the HTTP status alone, always check the parsed body.
 *
 * On HTTP 429 (rate limited) this reads Retry-After, sleeps once, and
 * retries exactly once before giving up — good enough for Tier 1's volume
 * (a handful of messages a day), not a general backoff strategy.
 *
 * `opts` (Tier 2+) lets a caller override the posted identity (username/
 * avatar) and thread a reply under an existing message. The defaulting is
 * deliberately conservative: every existing Tier 1 call site passes no
 * `opts` at all, and `opts = {}` must produce EXACTLY the payload Tier 1
 * always has —
 *   • `username`: `opts.username` if provided, else `SLACK.username`
 *     ('Akron Pulse'), same as before.
 *   • `icon_url`: `opts.iconUrl` if the caller explicitly passed it
 *     (including explicitly passing `null`), else `SLACK.iconUrl` — which is
 *     itself `null` whenever `SLACK_ICON_URL` isn't set. That preserves
 *     Tier 1's existing behavior of sending `icon_url: null` unconditionally
 *     when no override and no env var are present.
 *   • `thread_ts`: included in the payload ONLY when `opts.threadTs` is
 *     provided. Never sent as `thread_ts: undefined` — `JSON.stringify` drops
 *     `undefined`-valued object keys, but building the payload without the
 *     key at all (rather than relying on that serialization quirk) keeps the
 *     payload's own shape honest about what was actually requested.
 */
export async function postMessage(
  key: ChannelKey,
  text: string,
  opts: PostOpts = {},
): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
  const channel = resolveChannel(key)
  if (!channel) {
    return { ok: false, error: `no channel configured for "${key}"` }
  }

  const token = Deno.env.get('SLACK_BOT_TOKEN')
  if (!token) {
    return { ok: false, error: 'SLACK_BOT_TOKEN not configured' }
  }

  const payload: Record<string, unknown> = {
    channel,
    text,
    username: opts.username ?? SLACK.username,
    icon_url: opts.iconUrl !== undefined ? opts.iconUrl : SLACK.iconUrl,
    unfurl_links: false,
    unfurl_media: false,
  }
  if (opts.threadTs !== undefined) {
    payload.thread_ts = opts.threadTs
  }

  const attempt = () =>
    fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    })

  let res = await attempt()

  if (res.status === 429) {
    const retryAfterHeader = res.headers.get('Retry-After')
    const retryAfterSec = Number(retryAfterHeader)
    const waitMs = (Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 1) * 1000
    console.warn('[_shared/slack] rate limited, retrying once', { channel: key, waitMs })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    res = await attempt()
  }

  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; ts?: string; error?: string }
    | null

  if (!body || body.ok !== true || !body.ts) {
    const error = body?.error || `HTTP ${res.status}`
    console.error('[_shared/slack] postMessage failed', { channel: key, status: res.status, error })
    return { ok: false, error }
  }

  return { ok: true, ts: body.ts }
}

/**
 * INTENT_LABELS — re-exported from _shared/intents.ts, which owns the
 * canonical {id,label} pairs (see that file's header for why this moved out
 * of here: subscribe/validate.ts needs these ids too, and importing them
 * from this module — which reads Slack env vars and logs at module scope —
 * meant the public `subscribe` write endpoint transitively depended on the
 * Slack module booting cleanly). Re-exported here (rather than requiring
 * every existing importer of `../_shared/slack.ts` to change its import
 * path) so render.ts's `import { ..., INTENT_LABELS, ... } from
 * '../_shared/slack.ts'` keeps working unchanged.
 */
export { INTENT_LABELS } from './intents.ts'

/**
 * CATEGORY_LABELS — mirrors the {slug,label} pairs from src/lib/categories.js
 * CATEGORIES (same Deno-can't-import-the-frontend-module reason as
 * INTENT_LABELS above). Used by renderSignup's "Categories: " bullet —
 * partner channels must never show raw DB slugs, per Byron's "incredibly
 * simple, understood by business partners" requirement. Update both
 * together — scripts/tests/test-slack-category-labels.js fails CI when
 * they drift.
 */
export const CATEGORY_LABELS: { slug: string; label: string }[] = [
  { slug: 'music',      label: 'Music' },
  { slug: 'theater',    label: 'Theater' },
  { slug: 'film',       label: 'Film' },
  { slug: 'comedy',     label: 'Comedy' },
  { slug: 'visual-art', label: 'Art' },
  { slug: 'food',       label: 'Food & Drink' },
  { slug: 'sports',     label: 'Sports' },
  { slug: 'fitness',    label: 'Fitness' },
  { slug: 'outdoors',   label: 'Outdoors' },
  { slug: 'learning',   label: 'Learning' },
  { slug: 'festival',   label: 'Festivals' },
  { slug: 'market',     label: 'Markets' },
  { slug: 'civic',      label: 'Civic' },
  { slug: 'games',      label: 'Games & Hobbies' },
  { slug: 'other',      label: 'Other' },
]

/**
 * AGE_LABEL — mirrors src/lib/eventFormatting.ts AGE_LABEL (the display
 * labels for the `events.age_restriction` enum; same Deno-can't-import
 * reason as above — that module also pulls in date-fns). Used by
 * renderSignup's "Ages: " bullet. 'not_specified' is intentionally absent:
 * callers must treat it as "no restriction" (omit the bullet) before
 * looking up, same contract as the frontend copy. Update both together —
 * scripts/tests/test-slack-age-labels.js fails CI when they drift.
 */
export const AGE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  all_ages: 'All ages',
  '18_plus': '18+',
  '21_plus': '21+',
})
