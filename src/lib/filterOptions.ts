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

export interface WhenPresetOption {
  id: string
  label: string
  /** True only for the legacy `this_week` value: no chip renders it (see
   * WhenSection.tsx), it exists here only so it round-trips through
   * `deriveWhen` (whenFilter.ts) and the drift-guard test can assert it's
   * still a recognized id. */
  ghost?: true
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

/**
 * The single vocabulary for the "When" date preset chips (the tray and the
 * hub filter strip both render from this list via WhenSection) AND the
 * removal-pill label lookup in FilterBar. Previously FilterBar.tsx had its
 * own `DATE_TABS` list that nothing rendered as tabs (dead UI, kept alive
 * only as a label lookup) -- a second, silently-drifting date vocabulary.
 * This is now the only one.
 *
 * `this_week` is a GHOST: a legacy value with no chip. Partner embeds seeded
 * before this change (embedConfig.ts, EmbedBuilderPage.tsx, CalendarView.tsx)
 * may still carry `date=this_week`, and it must keep resolving forever, so
 * it stays a recognized id here -- but `ghost: true` means WhenSection never
 * offers it as a selectable option, only renders it (selected, inert-free)
 * when it is already the active value. Do NOT delete this entry and do NOT
 * turn it into a normal chip; see whenFilter.ts's deriveWhen and
 * embedConfig.ts's VALID_DATE for the other two places this same "keep
 * resolving, never mint" rule applies.
 */
export const WHEN_PRESETS: WhenPresetOption[] = [
  { id: 'today',        label: 'Today' },
  { id: 'tomorrow',     label: 'Tomorrow' },
  { id: 'this_weekend', label: 'This weekend' },
  { id: 'next_7_days',  label: 'Next 7 days' },
  { id: 'this_month',   label: 'This month' },
  { id: 'this_week',    label: 'This week', ghost: true },
]

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtYmd(ymd: string): string {
  const [, m, day] = ymd.split('-')
  return `${MONTH_ABBR[parseInt(m, 10) - 1]} ${parseInt(day, 10)}`
}

/**
 * Build the human label for a custom date range, e.g. "Aug 16 to Aug 22".
 * Shared by the When chip row and the FilterBar removal pill so they can
 * never show two different strings for the same range. The repo bans em
 * dashes, so "to" (not the old en-dash form) joins a two-sided range.
 */
export function buildDateRangeLabel(from: string | null, to: string | null): string {
  if (from && to) return from === to ? fmtYmd(from) : `${fmtYmd(from)} to ${fmtYmd(to)}`
  if (from) return `From ${fmtYmd(from)}`
  if (to) return `Through ${fmtYmd(to)}`
  return ''
}
