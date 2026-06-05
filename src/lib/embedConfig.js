/**
 * embedConfig.js
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
 *   view=list|map              initial view (default: list)
 *   density=comfortable|efficient  initial card density (default: comfortable)
 *   target=inline|blank        event click-through (default: inline)
 *
 * A filter that is present in the URL is treated as LOCKED — the visitor can
 * filter further within the embed but can never remove the partner's
 * constraint (see lockedDimensions below + FilterBar locked-pill handling).
 */

import { isValidTheme, DEFAULT_THEME } from '@/lib/themes'

export const EMBED_FEATURES = ['filter', 'map', 'density', 'price', 'tags']

const VALID_PRICE = new Set(['free', 'under10', 'under25'])
const VALID_DATE = new Set(['today', 'this_weekend', 'this_week', 'this_month'])
const VALID_VIEW = new Set(['list', 'map'])
const VALID_DENSITY = new Set(['comfortable', 'efficient'])
const VALID_TARGET = new Set(['inline', 'blank'])

function csv(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * Parse a URLSearchParams (or query string) into a validated embed config.
 * Always returns a fully-populated object with safe defaults.
 */
export function parseEmbedConfig(search) {
  const params = typeof search === 'string'
    ? new URLSearchParams(search)
    : (search ?? new URLSearchParams())

  const theme = params.get('theme')
  const categories = csv(params.get('categories'))
  const price = VALID_PRICE.has(params.get('price')) ? params.get('price') : null
  const date = VALID_DATE.has(params.get('date')) ? params.get('date') : null
  const family = params.get('family') === '1' || params.get('family') === 'true'

  // features: omitted → all on; present → explicit allowlist.
  const featureParam = params.get('features')
  const enabled = featureParam == null
    ? new Set(EMBED_FEATURES)
    : new Set(csv(featureParam).filter((f) => EMBED_FEATURES.includes(f)))

  const features = Object.fromEntries(EMBED_FEATURES.map((f) => [f, enabled.has(f)]))

  const view = VALID_VIEW.has(params.get('view')) ? params.get('view') : 'list'
  const density = VALID_DENSITY.has(params.get('density')) ? params.get('density') : 'comfortable'
  const target = VALID_TARGET.has(params.get('target')) ? params.get('target') : 'inline'

  // Locked dimensions — a tray dimension is locked (hidden + non-clearable)
  // when the partner preset it. `family` has no dedicated tray control, so
  // it locks nothing here; it's applied via the effective-query preset.
  const lockedDimensions = {
    category: categories.length > 0,
    price: !!price,
    dateRange: !!date,
  }

  // Which FILTER_PARAM_KEYS clearFilters must preserve (the locked presets).
  const lockedKeys = []
  if (categories.length > 0) lockedKeys.push('categories')
  if (price) lockedKeys.push('price')
  if (date) lockedKeys.push('date')

  return {
    embed: true,
    theme: theme && isValidTheme(theme) ? theme : DEFAULT_THEME,
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
export function embedEventPath(eventPathStr, configSearch) {
  // eventPathStr is the canonical "/events/{slug}/{id}". Re-root under /embed.
  const rerooted = `/embed${eventPathStr}`
  const qs = configSearch ? (configSearch.startsWith('?') ? configSearch : `?${configSearch}`) : ''
  return `${rerooted}${qs}`
}
