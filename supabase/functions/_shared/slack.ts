/**
 * _shared/slack.ts — Slack notification primitives for Tier 1 (and later
 * Tier 2/3) notifications.
 *
 * Mirrors the shape of _shared/email.ts: theme identity, an escape helper,
 * and a single send primitive live here so every Slack-facing caller renders
 * and escapes the same way. The only current caller is slack-notify/index.ts,
 * invoked by the three DB triggers in supabase/migrations/045_slack_triggers.sql.
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

// Tier 1 wires exactly these two channels. Tier 2/3 keys are commented out
// below (both here and in CHANNEL_ENV_VARS) — wiring one up for real is a
// one-line uncomment in each place plus setting the matching env var.
export type ChannelKey =
  | 'public-feedback'
  | 'public-new-email-subscribers'
  // | 'daily-reports'
  // | 'the-night-crew'
  // | 'ask-the-developers'

// Logical key -> env var name holding the real Slack channel id. Keeping
// this as an explicit map (rather than deriving the env var name from the
// key) means the env var naming is free to not match the key spelling, and
// a missing/renamed secret fails closed (resolveChannel returns null)
// instead of posting to a wrong or malformed channel string.
const CHANNEL_ENV_VARS: Record<ChannelKey, string> = {
  'public-feedback': 'SLACK_CHANNEL_PUBLIC_FEEDBACK',
  'public-new-email-subscribers': 'SLACK_CHANNEL_NEW_EMAIL_SUBSCRIBERS',
  // 'daily-reports': 'SLACK_CHANNEL_DAILY_REPORTS',
  // 'the-night-crew': 'SLACK_CHANNEL_THE_NIGHT_CREW',
  // 'ask-the-developers': 'SLACK_CHANNEL_ASK_THE_DEVELOPERS',
}

/** Resolve a logical channel key to the real Slack channel id, or null if unset. */
export function resolveChannel(key: ChannelKey): string | null {
  const envVar = CHANNEL_ENV_VARS[key]
  const id = envVar ? Deno.env.get(envVar) : undefined
  return id && id.trim() ? id.trim() : null
}

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
  has_SLACK_ICON_URL: !!Deno.env.get('SLACK_ICON_URL'),
})

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
 */
export async function postMessage(
  key: ChannelKey,
  text: string,
): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
  const channel = resolveChannel(key)
  if (!channel) {
    return { ok: false, error: `no channel configured for "${key}"` }
  }

  const token = Deno.env.get('SLACK_BOT_TOKEN')
  if (!token) {
    return { ok: false, error: 'SLACK_BOT_TOKEN not configured' }
  }

  const payload = {
    channel,
    text,
    username: SLACK.username,
    icon_url: SLACK.iconUrl,
    unfurl_links: false,
    unfurl_media: false,
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
