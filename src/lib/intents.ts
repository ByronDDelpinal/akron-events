/**
 * intents.ts
 *
 * Curated multi-category/facet presets used alongside raw categories in the
 * unified Filter & Sort tray. The intent definitions now live in the canonical
 * taxonomy registry (categories.js) so categories, facets, and labels stay in
 * one place. Re-exported here under the historical name so existing imports
 * (`@/lib/intents`) keep working.
 *
 * Each intent resolves to `{ categories, facets }`:
 *   • categories → OR/any-match on the content axis (event_categories)
 *   • facets     → boolean flags (family, fundraiser) or derived (free)
 */

export { INTENTS } from './categories.js'

/** A search-bar suggestion. `intentId` must match an INTENTS id. */
export interface SearchSuggestion {
  intentId: string
  label: string
  datePreset: string | null
}

/**
 * Search-bar intent suggestions. `intentId` must match an INTENTS id.
 */
export const SEARCH_SUGGESTIONS: SearchSuggestion[] = [
  { intentId: 'date-night',      label: 'Date night ideas',         datePreset: null           },
  { intentId: 'family',          label: 'Family-friendly events',   datePreset: null           },
  { intentId: 'arts-stage',      label: 'Arts, theater & film',     datePreset: null           },
  { intentId: 'give-back',       label: 'Give back to Akron',       datePreset: null           },
  { intentId: 'outdoors-active', label: 'Get outside this weekend', datePreset: 'this_weekend' },
]
