/**
 * embedConfig.ts
 *
 * Parses the white-label embed configuration out of a URL query string.
 * The embed is configured entirely by query params in phase 1 — no partner
 * accounts, no backend. Param names are chosen to map 1:1 onto a future
 * partner-config record so phase 2 (saved configs + custom colors + domain
 * allowlists) is a data move, not a re-plumb.
 *
 * Contract (all optional):
 *   theme=<id>                 theme id from lib/themes (default: brand)
 *   categories=music,arts      locked content filter (any-match)
 *   price=free|under10|under25 locked price filter
 *   date=today|this_weekend|this_week|this_month   locked date preset
 *   family=1                   locked family-friendly facet
 *   features=filter,map,density,price,tags
 *                              allowlist of enabled features; OMITTED = all on
 *   title=<string>             custom embed heading (default: "Upcoming Events")
 *   view=list|map              initial view (default: list)
 *   density=comfortable|efficient  initial card density (default: comfortable)
 *   target=inline|blank        event click-through (default: inline)
 *
 * A filter that is present in the URL is treated as LOCKED — the visitor can
 * never remove the partner's constraint (see lockedDimensions below + FilterBar
 * locked-pill handling). For a locked CATEGORY set the visitor may still narrow
 * WITHIN the set (e.g. a music+arts embed lets a visitor view just music) but
 * can never reach outside it; clearing resets to the full locked set. Locked
 * price/date are single presets with nothing to narrow, so their tray sections
 * stay hidden.
 */

import { isValidTheme, DEFAULT_THEME } from '@/lib/themes'

export const EMBED_FEATURES = ['filter', 'map', 'density', 'price', 'tags'] as const
export type EmbedFeature = (typeof EMBED_FEATURES)[number]

export type EmbedPrice = 'free' | 'under10' | 'under25'
export type EmbedDate = 'today' | 'this_weekend' | 'this_week' | 'this_month'
export type EmbedView = 'list' | 'map'
export type EmbedDensity = 'comfortable' | 'efficient'
export type EmbedTarget = 'inline' | 'blank' | 'external'

export interface EmbedConfig {
  embed: true
  theme: string
  title: string | null
  categories: string[]
  price: EmbedPrice | null
  date: EmbedDate | null
  family: boolean
  features: Record<EmbedFeature, boolean>
  view: EmbedView
  density: EmbedDensity
  target: EmbedTarget
  lockedDimensions: { category: boolean; price: boolean; dateRange: boolean }
  lockedKeys: string[]
}

const VALID_PRICE = new Set<EmbedPrice>(['free', 'under10', 'under25'])
const VALID_DATE = new Set<EmbedDate>(['today', 'this_weekend', 'this_week', 'this_month'])
const VALID_VIEW = new Set<EmbedView>(['list', 'map'])
const VALID_DENSITY = new Set<EmbedDensity>(['comfortable', 'efficient'])
const VALID_TARGET = new Set<EmbedTarget>(['inline', 'blank', 'external'])

function csv(value: string | null | undefined): string[] {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean)
}

/** Narrow a raw query value to a member of `valid`, else return `fallback`. */
function oneOf<T extends string>(
  raw: string | null,
  valid: Set<T>,
  fallback: T | null
): T | null {
  return raw !== null && valid.has(raw as T) ? (raw as T) : fallback
}

/**
 * Parse a URLSearchParams (or query string) into a validated embed config.
 * Always returns a fully-populated object with safe defaults.
 */
export function parseEmbedConfig(
  search: string | URLSearchParams | null | undefined
): EmbedConfig {
  const params = typeof search === 'string'
    ? new URLSearchParams(search)
    : (search ?? new URLSearchParams())

  const theme = params.get('theme')
  // title: free-form string; trim and clamp to 120 chars to prevent abuse.
  const rawTitle = params.get('title')
  const title = rawTitle ? rawTitle.trim().slice(0, 120) || null : null
  const categories = csv(params.get('categories'))
  const price = oneOf(params.get('price'), VALID_PRICE, null)
  const date = oneOf(params.get('date'), VALID_DATE, null)
  const family = params.get('family') === '1' || params.get('family') === 'true'

  // features: OMITTED (param absent) → all on. PRESENT → explicit allowlist of
  // the named features; any unknown token (e.g. the `none` sentinel the builder
  // emits for an all-off config, or an empty string) simply contributes nothing,
  // so a present-but-empty allowlist correctly turns every feature off.
  const featureParam = params.get('features')
  const enabled = featureParam == null
    ? new Set<string>(EMBED_FEATURES)
    : new Set<string>(csv(featureParam).filter((f): f is EmbedFeature =>
        (EMBED_FEATURES as readonly string[]).includes(f)))

  const features = Object.fromEntries(
    EMBED_FEATURES.map((f) => [f, enabled.has(f)])
  ) as Record<EmbedFeature, boolean>

  const view = oneOf(params.get('view'), VALID_VIEW, 'list') as EmbedView
  const density = oneOf(params.get('density'), VALID_DENSITY, 'comfortable') as EmbedDensity
  const target = oneOf(params.get('target'), VALID_TARGET, 'inline') as EmbedTarget

  // Locked dimensions — a tray dimension is locked (hidden + non-clearable)
  // when the partner preset it. `family` has no dedicated tray control, so
  // it locks nothing here; it's applied via the effective-query preset.
  const lockedDimensions = {
    category: categories.length > 0,
    price: !!price,
    dateRange: !!date,
  }

  // Which FILTER_PARAM_KEYS clearFilters must preserve (the locked presets).
  // Categories are intentionally NOT preserved here: the category lock is
  // enforced by `categories` (the locked set) being passed to useEventFilters as
  // `lockedCategories`, which clamps the effective query and resets to the full
  // set on clear. Preserving the param would instead pin the visitor's narrowed
  // subset, which is the opposite of "Clear filters".
  const lockedKeys: string[] = []
  if (price) lockedKeys.push('price')
  if (date) lockedKeys.push('date')

  return {
    embed: true,
    theme: theme && isValidTheme(theme) ? theme : DEFAULT_THEME,
    title,
    categories,
    price,
    date,
    family,
    features,
    view,
    density,
    target,
    lockedDimensions,
    lockedKeys,
  }
}

/**
 * Build the in-iframe detail path for an event, carrying the embed config
 * query string forward so theme/features/target survive the navigation.
 * Mirrors lib/slug eventPath but under the /embed prefix.
 */
export function embedEventPath(
  eventPathStr: string,
  configSearch: string | null | undefined
): string {
  // eventPathStr is the canonical "/events/{slug}/{id}". Re-root under /embed.
  const rerooted = `/embed${eventPathStr}`
  const qs = configSearch ? (configSearch.startsWith('?') ? configSearch : `?${configSearch}`) : ''
  return `${rerooted}${qs}`
}
