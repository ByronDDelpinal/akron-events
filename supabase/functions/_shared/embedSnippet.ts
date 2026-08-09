/**
 * _shared/embedSnippet.ts — server-side embed URL / snippet / summary
 * builder for the "request an embed" feature (docs/embed-request-capture.md
 * §3). Pure functions, no Deno globals, no fetch, no Supabase client — same
 * split rationale as slack-notify/render.ts and subscribe/validate.ts, so
 * this unit-tests directly without a live server or database.
 *
 * Imported by BOTH notify-embed-request (email) and slack-notify/render.ts
 * (Slack) — there is exactly one snippet implementation and two renderers
 * around it. Both callers apply their OWN channel-specific escaping
 * (escapeHtml / escapeSlackText) to whatever this module returns; nothing
 * here is pre-escaped for a specific channel except the one HTML-attribute
 * context noted on buildIframeSnippet below.
 *
 * This module imports `@/lib/embedConfig` and `@/lib/embedParams` — real
 * frontend modules, resolved through the root `deno.json` `@/` import map
 * (docs/embed-request-capture.md D1). Both are verified side-effect-free:
 * no `window`, `document`, `localStorage`, or `import.meta` anywhere in
 * their transitive closure (embedConfig.ts pulls in `@/lib/themes`,
 * `@/lib/neighborhoods`, `@/lib/seo/categories.js`, all pure data; a repeat
 * of that grep is worth doing again if this module's import graph grows).
 * That is what lets `buildEmbedParams` below DELEGATE to the real frontend
 * serializer instead of reimplementing it — see the hard anti-goal in
 * docs/embed-request-capture.md §6.1: this repo has already been bitten by
 * a test (scripts/tests/test-eventbrite.js) that forks production parsing
 * logic instead of importing it, and a forked serializer here would make
 * the round-trip test assert that our copy agrees with our copy.
 */

// Explicit `.ts` extensions on every `@/` import — Deno requires an
// explicit extension on local/aliased imports it resolves (unlike Vite,
// which is happy either way — `allowImportingTsExtensions` is on in
// tsconfig.json). Deliberately NOT relying on Deno's unstable
// sloppy-imports flag for this: Supabase's deployed edge runtime is not
// guaranteed to be the same Deno build/version as the CLI this was
// developed and tested against, so an unstable resolution feature is a
// real deploy-time risk this repo doesn't need to take when explicit
// extensions cost nothing.
import {
  EMBED_FEATURES,
  type EmbedFeature,
  type EmbedPrice,
  type EmbedDate,
  type EmbedView,
  type EmbedDensity,
  type EmbedTarget,
} from '@/lib/embedConfig.ts'
import { buildEmbedParams as buildBuilderEmbedParams, type BuilderState } from '@/lib/embedParams.ts'
import { THEMES } from '@/lib/themes.ts'
import { escapeHtml } from './email.ts'
import { CATEGORY_LABELS } from './slack.ts'

// ── Normalized config ───────────────────────────────────────────────────

/**
 * The server-normalized shape of a submitted BuilderState. Every field is
 * either a validated member of a known set, or the documented fallback —
 * `normalizeConfig` NEVER throws and NEVER passes through an untrusted raw
 * value verbatim, matching the "always returns a fully-populated object
 * with safe defaults" contract `parseEmbedConfig` already keeps.
 */
export interface NormalizedConfig {
  theme: string
  title: string | null
  place: string | null
  categories: string[]
  price: EmbedPrice | null
  date: EmbedDate | null
  family: boolean
  features: Record<EmbedFeature, boolean>
  view: EmbedView
  density: EmbedDensity
  target: EmbedTarget
}

// theme/place/categories are charset-gated, not matched against a mirrored
// allowlist — see docs/embed-request-capture.md §3.3 ("Why charset-gating
// and not full allowlists"): the security property required is "no HTML or
// mrkdwn injection," which this charset (plus URLSearchParams' own
// percent-encoding downstream) already delivers. parseEmbedConfig itself
// already treats an unrecognized theme/place/category as harmless (falls
// back to its own default), so an invalid-but-charset-safe slug here just
// produces an odd-looking embed, not a security issue.
const SLUG_RE = /^[a-z0-9-]{1,40}$/

// Strips C0 control characters (0x00-0x1F) and DEL (0x7F) from `title`.
// Caret notation for the same range: ^@ (NUL) through ^_ (US), plus ^?
// (DEL).
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g

const MAX_TITLE_CODE_POINTS = 120
const MAX_CATEGORIES = 20

/**
 * Clamp by CODE POINT ([...s]), never by UTF-16 code unit (a bare
 * `.slice(n)`). Same reasoning as slack-notify/render.ts's clampLabel/
 * capMessage: most emoji are a surrogate pair, and slicing mid-pair emits a
 * lone surrogate that renders as U+FFFD instead of a clean cut.
 */
function clampCodePoints(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, max).join('') : s
}

/**
 * Coerce untrusted jsonb (the `embed_requests.config` column) into a fully
 * populated, safe-by-construction config. Non-object / array / null input
 * is rejected wholesale (falls through to every field's own default) —
 * `jsonb_typeof(config) = 'object'` is already enforced by migration 051's
 * CHECK constraint, but this function must hold for any caller, including a
 * hand-run test or a future admin tool that doesn't go through that
 * constraint.
 */
export function normalizeConfig(raw: unknown): NormalizedConfig {
  const obj: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

  const rawTheme = obj.theme
  const theme = typeof rawTheme === 'string' && SLUG_RE.test(rawTheme) ? rawTheme : 'akron-pulse'

  const rawTitle = obj.title
  let title: string | null = null
  if (typeof rawTitle === 'string') {
    // Strip backticks so a title can never break out of a Slack code fence
    // (escapeSlackText handles &, <, > — it does not touch `` ` ``; title
    // is the only free text that reaches the snippet, so this is the one
    // place that closes the fence-escape entirely). Strip control chars for
    // the same reason every other free-text field in this codebase does.
    const stripped = rawTitle.replace(CONTROL_CHARS_RE, '').replace(/`/g, '').trim()
    const clamped = clampCodePoints(stripped, MAX_TITLE_CODE_POINTS)
    title = clamped || null
  }

  const rawPlace = obj.place
  const place = typeof rawPlace === 'string' && SLUG_RE.test(rawPlace) ? rawPlace : null

  const categories: string[] = []
  if (Array.isArray(obj.categories)) {
    const seen = new Set<string>()
    for (const item of obj.categories) {
      if (categories.length >= MAX_CATEGORIES) break
      if (typeof item !== 'string' || !SLUG_RE.test(item)) continue
      if (seen.has(item)) continue
      seen.add(item)
      categories.push(item)
    }
  }

  const rawPrice = obj.price
  const price: EmbedPrice | null =
    rawPrice === 'free' || rawPrice === 'under10' || rawPrice === 'under25' ? rawPrice : null

  const rawDate = obj.date
  const date: EmbedDate | null =
    rawDate === 'today' || rawDate === 'this_weekend' || rawDate === 'this_week' || rawDate === 'this_month'
      ? rawDate
      : null

  const family = obj.family === true

  // Plain object present -> per-key `=== true` (a missing key is `false`,
  // not defaulted to `true`). Missing/malformed `features` entirely -> all
  // six `true`. The two cases are genuinely different defaults, so they
  // can't share one fallback path. `k` below always comes from the fixed
  // EMBED_FEATURES constant, never from an attacker-controlled key, so a
  // bracket read (`rawFeaturesObj[k]`) is not a prototype-chain lookup —
  // unlike render.ts's AGE_LABEL/FEATURE_LABELS[k]-on-untrusted-k case.
  let features: Record<EmbedFeature, boolean>
  const rawFeatures = obj.features
  if (rawFeatures && typeof rawFeatures === 'object' && !Array.isArray(rawFeatures)) {
    const f = rawFeatures as Record<string, unknown>
    features = Object.fromEntries(EMBED_FEATURES.map((k) => [k, f[k] === true])) as Record<EmbedFeature, boolean>
  } else {
    features = Object.fromEntries(EMBED_FEATURES.map((k) => [k, true])) as Record<EmbedFeature, boolean>
  }

  const rawView = obj.view
  const view: EmbedView = rawView === 'list' || rawView === 'calendar' || rawView === 'map' ? rawView : 'list'

  const rawDensity = obj.density
  const density: EmbedDensity = rawDensity === 'comfortable' || rawDensity === 'efficient' ? rawDensity : 'comfortable'

  const rawTarget = obj.target
  const target: EmbedTarget =
    rawTarget === 'inline' || rawTarget === 'blank' || rawTarget === 'external' ? rawTarget : 'inline'

  return { theme, title, place, categories, price, date, family, features, view, density, target }
}

// ── URL / params ────────────────────────────────────────────────────────

/**
 * Delegates to the REAL frontend serializer (src/lib/embedParams.ts) rather
 * than reimplementing it — see this module's header. NormalizedConfig's
 * nullable fields (`title: string | null`, `place: string | null`, etc.)
 * are adapted to BuilderState's empty-string-sentinel shape here, at the
 * boundary, so the delegation is a pure data reshape with no logic of its
 * own to drift.
 */
export function buildEmbedParams(cfg: NormalizedConfig): URLSearchParams {
  const state: BuilderState = {
    title: cfg.title ?? '',
    theme: cfg.theme,
    place: cfg.place ?? '',
    categories: cfg.categories,
    price: cfg.price ?? '',
    date: cfg.date ?? '',
    family: cfg.family,
    features: cfg.features,
    view: cfg.view,
    density: cfg.density,
    target: cfg.target,
  }
  return buildBuilderEmbedParams(state)
}

/** "/embed" or "/embed?theme=...&..." — path only, no origin. */
export function buildEmbedPath(cfg: NormalizedConfig): string {
  const qs = buildEmbedParams(cfg).toString()
  return qs ? `/embed?${qs}` : '/embed'
}

/** Full URL. `origin` is always caller-supplied (never derived from a
 * request header — see buildIframeSnippet's comment for why). */
export function buildEmbedUrl(origin: string, cfg: NormalizedConfig): string {
  return `${origin}${buildEmbedPath(cfg)}`
}

// ── Snippet ─────────────────────────────────────────────────────────────

/**
 * The ONE canonical snippet shape, byte-matching docs/embed.md's Quick
 * start: the iframe plus the optional auto-resize helper `<script>`.
 * `public/akron-pulse-embed.js` is not an alternative embed form — it does
 * nothing without the iframe.
 *
 * `origin` is ALWAYS a server constant
 * (`Deno.env.get('PUBLIC_SITE_URL') || 'https://akronpulse.com'`, computed
 * by the caller), never derived from client input or a request header — a
 * `Host`-header-derived origin would let a caller rewrite the script `src`
 * in the maintainer's own email/Slack message.
 *
 * `title` appears twice, in two different escaping contexts:
 *   1. Inside the URL (via `buildEmbedUrl` -> `URLSearchParams`) — percent-
 *      encoded automatically. Safe.
 *   2. Inside the `title="…"` HTML attribute below — escaped with
 *      `escapeHtml` (closes the `"` attribute break-out) BEFORE the
 *      snippet string is assembled. This is independent of, and happens
 *      before, the "escape the whole assembled snippet once more per
 *      delivery channel" step each caller performs afterward
 *      (`escapeHtml(snippet)` for the email `<pre>`, `escapeSlackText(snippet)`
 *      for the Slack code fence) — yes, the title is escaped twice in the
 *      email case; that's correct, not redundant (the first escape makes
 *      valid HTML *source*, the second makes that source *display* as text).
 */
export function buildIframeSnippet(origin: string, cfg: NormalizedConfig): string {
  const url = buildEmbedUrl(origin, cfg)
  const title = escapeHtml(cfg.title ?? 'Upcoming Events')
  return `<iframe
  src="${url}"
  data-akron-pulse-embed
  title="${title}"
  style="width:100%;border:0;height:900px"
  loading="lazy"></iframe>

<!-- Optional: auto-resize the iframe to its content (no inner scrollbar) -->
<script src="${origin}/akron-pulse-embed.js" async></script>`
}

// ── Human-readable summary ──────────────────────────────────────────────
//
// Small closed-enum label maps, local to this module (not shared with
// EmbedBuilderPage.tsx's UI-flavored ALL_FEATURES/PRICE_OPTIONS/DATE_OPTIONS,
// which carry emoji and UI-only "(no lock)" phrasing that don't belong in an
// operator notification).

const PRICE_LABELS: Record<EmbedPrice, string> = {
  free: 'Free events only',
  under10: 'Under $10',
  under25: 'Under $25',
}

const DATE_LABELS: Record<EmbedDate, string> = {
  today: 'Today',
  this_weekend: 'This weekend',
  this_week: 'This week',
  this_month: 'This month',
}

const VIEW_LABELS: Record<EmbedView, string> = {
  list: 'list',
  calendar: 'calendar',
  map: 'map',
}

const DENSITY_LABELS: Record<EmbedDensity, string> = {
  comfortable: 'comfortable',
  efficient: 'compact',
}

const TARGET_LABELS: Record<EmbedTarget, string> = {
  inline: 'inside the embed',
  blank: 'in a new tab',
  external: 'direct to event site',
}

const FEATURE_LABELS: Record<EmbedFeature, string> = {
  filter: 'Filter & Sort',
  map: 'Map view',
  calendar: 'Calendar view',
  density: 'Density toggle',
  price: 'Price labels',
  tags: 'Category tags',
}

/**
 * "What they configured" bullet lines, shared verbatim by the email body
 * and the Slack message (docs/embed-request-capture.md §4.4/§4.5). Returned
 * UNESCAPED — every caller escapes each line for its own channel
 * (`escapeHtml` / `escapeSlackText`) at its own render boundary, same
 * pattern render.ts's capList already uses for CATEGORY_LABELS lookups.
 * The only line carrying real free text is "Heading" (the submitted
 * title); every other line is built from a closed, curated label set or a
 * charset-gated slug, so escaping the whole line is always safe and never
 * double-mangles a curated label like "Food & Drink".
 */
export function describeConfig(cfg: NormalizedConfig): string[] {
  const lines: string[] = []

  const themeName = THEMES.find((t) => t.id === cfg.theme)?.name ?? cfg.theme
  lines.push(`Theme: ${themeName}`)

  if (cfg.title) lines.push(`Heading: "${cfg.title}"`)
  if (cfg.place) lines.push(`Location: ${cfg.place}`)

  if (cfg.categories.length > 0) {
    const labels = cfg.categories.map(
      (slug) => CATEGORY_LABELS.find((c) => c.slug === slug)?.label ?? slug,
    )
    lines.push(`Categories: ${labels.join(', ')}`)
  }

  if (cfg.price) lines.push(`Price: ${PRICE_LABELS[cfg.price]}`)
  if (cfg.date) lines.push(`Dates: ${DATE_LABELS[cfg.date]}`)
  if (cfg.family) lines.push('Family-friendly only')

  const hidden = EMBED_FEATURES.filter((f) => !cfg.features[f])
  if (hidden.length > 0) {
    lines.push(`Hidden: ${hidden.map((f) => FEATURE_LABELS[f]).join(', ')}`)
  }

  lines.push(
    `Opens: ${TARGET_LABELS[cfg.target]} · Cards: ${DENSITY_LABELS[cfg.density]} · Starts on: ${VIEW_LABELS[cfg.view]}`,
  )

  return lines
}
