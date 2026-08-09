/**
 * embedParams.ts
 *
 * The embed builder's query-string serializer, extracted out of
 * EmbedBuilderPage.tsx (pure move, no behavior change — see
 * docs/embed-request-capture.md §6.1) so it can be imported both by the page
 * (for the live preview) and, via the root `@/` Deno import map, by
 * supabase/functions/_shared/embedSnippet.ts. That is what makes there be
 * exactly one `buildEmbedParams` in the codebase, and what lets the
 * embed-request round-trip test exercise the real serializer instead of a
 * mirrored fork.
 *
 * This module must stay import-safe from Deno: no top-level `window` /
 * `document` / `localStorage` / `import.meta` access. `buildEmbedSrc` reads
 * `window.location.origin`, but only inside its function body — Deno never
 * calls that function (the edge functions use `buildEmbedUrl` in
 * `_shared/embedSnippet.ts`, which takes an explicit origin instead), so the
 * module itself imports and typechecks cleanly under `deno check`.
 */

// Explicit `.ts` extension — see embedConfig.ts's own import comment for why.
import {
  EMBED_FEATURES,
  type EmbedFeature,
  type EmbedPrice,
  type EmbedDate,
  type EmbedView,
  type EmbedDensity,
  type EmbedTarget,
} from '@/lib/embedConfig.ts'

export interface BuilderState {
  title: string
  theme: string
  place: string
  categories: string[]
  price: EmbedPrice | ''
  date: EmbedDate | ''
  family: boolean
  features: Record<EmbedFeature, boolean>
  view: EmbedView
  density: EmbedDensity
  target: EmbedTarget
}

/**
 * Serialize a BuilderState into the `/embed` query string. Byte-identical
 * to what it always was in EmbedBuilderPage.tsx — the only change from the
 * move is that the features loop now walks `EMBED_FEATURES` (the same
 * ordered key list `embedConfig.ts`'s parser itself is built around)
 * instead of the page-local `ALL_FEATURES` UI array, which is equivalent
 * (same keys, same order) but doesn't drag UI labels into a shared module.
 */
export function buildEmbedParams(state: BuilderState): URLSearchParams {
  const p = new URLSearchParams()
  if (state.theme !== 'akron-pulse') p.set('theme', state.theme)
  if (state.title.trim()) p.set('title', state.title.trim())
  if (state.place) p.set('place', state.place)
  if (state.categories.length) p.set('categories', state.categories.join(','))
  if (state.price) p.set('price', state.price)
  if (state.date) p.set('date', state.date)
  if (state.family) p.set('family', '1')

  // Features: omitting the param means "all on", so we only emit when at least
  // one feature is off. When EVERY feature is off the allowlist is empty — we
  // still must emit the param (as the `none` sentinel), otherwise an all-off
  // config would serialize identically to an unconfigured one and parse back as
  // all-on. parseEmbedConfig treats any present-but-empty allowlist as all-off.
  const allOn = Object.values(state.features).every(Boolean)
  if (!allOn) {
    const enabled = EMBED_FEATURES.filter((f) => state.features[f])
    p.set('features', enabled.length ? enabled.join(',') : 'none')
  }

  if (state.view !== 'list') p.set('view', state.view)
  if (state.density !== 'comfortable') p.set('density', state.density)
  if (state.target !== 'inline') p.set('target', state.target)
  return p
}

/** Browser-only: the live-preview iframe src. Never called from Deno. */
export function buildEmbedSrc(state: BuilderState): string {
  const params = buildEmbedParams(state)
  const qs = params.toString()
  return `${window.location.origin}/embed${qs ? `?${qs}` : ''}`
}
