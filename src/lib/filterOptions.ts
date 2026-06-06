/**
 * filterOptions.ts
 *
 * Shared option lists for the homepage Filter & Sort tray and the
 * inline filter strip on category/neighborhood hub pages. Keeping
 * these in one place means changing a category emoji, reordering
 * chips, or adjusting price tiers updates every surface at once.
 *
 * The "Hide sources" chip group was removed in 2026-06 — the
 * SourceOverflowCard ("See N more from …") is a better solution for
 * the same problem, and a global hide-this-source toggle conflicted
 * with the per-date-group overflow UX.
 */

import { FILTERABLE_CATEGORIES, INTENTS } from './categories.js'

export interface CategoryOption {
  kind: 'intent' | 'raw'
  value: string
  label: string
}

export interface SortOption {
  value: 'soonest' | 'latest' | 'recent'
  label: string
}

export interface PriceOption {
  value: string | null
  label: string
}

/**
 * Filter-tray chips, generated from the canonical taxonomy registry so they can
 * never drift from the DB / inference / badges again. Curated intents lead
 * (the lean discovery layer), followed by the raw content categories.
 *
 *   { kind: 'intent', value: <intentId>, label }  → resolves to categories
 *                                                    and/or facets (see INTENTS)
 *   { kind: 'raw',    value: <slug>,     label }  → a single content category
 *
 * `INTENTS` / `FILTERABLE_CATEGORIES` come from the JS taxonomy registry; their
 * shapes are inferred via allowJs, so the field accesses below are checked.
 */
export const CATEGORY_OPTIONS: CategoryOption[] = [
  ...INTENTS.map((i) => ({ kind: 'intent' as const, value: i.id, label: `${i.emoji} ${i.label}` })),
  ...FILTERABLE_CATEGORIES.map((c) => ({ kind: 'raw' as const, value: c.slug, label: `${c.emoji} ${c.label}` })),
]

export const SORT_OPTIONS: SortOption[] = [
  { value: 'soonest', label: '📅 Soonest first' },
  { value: 'latest',  label: '🕐 Latest first' },
  { value: 'recent',  label: '🆕 Recently added' },
]

export const PRICE_OPTIONS: PriceOption[] = [
  { value: null,       label: 'Any price' },
  { value: 'free',     label: '🎉 Free' },
  { value: 'under10',  label: 'Under $10' },
  { value: 'under25',  label: 'Under $25' },
]
