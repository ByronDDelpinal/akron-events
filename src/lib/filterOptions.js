/**
 * filterOptions.js
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

import { CATEGORY_BY_SLUG } from './categories.js'

/**
 * Build a raw-category chip from the canonical taxonomy registry so the
 * emoji + label live in exactly one place. Returns `{ kind, value, label }`
 * in the same shape the tray has always consumed.
 */
function rawChip(slug) {
  const c = CATEGORY_BY_SLUG[slug]
  return { kind: 'raw', value: slug, label: `${c.emoji} ${c.label}` }
}

/**
 * Tray layout: curated intents (defined in intents.js) interleaved with raw
 * categories. The ORDER here is deliberate UX and is preserved as-is; only the
 * raw chips' emoji/label now derive from the registry instead of being
 * hard-coded, so a label change updates the tray, badges, and admin at once.
 */
export const CATEGORY_OPTIONS = [
  { kind: 'intent', value: 'date-night', label: '🌙 Date Night' },
  rawChip('music'),
  rawChip('art'),
  rawChip('food'),
  { kind: 'intent', value: 'family-fun', label: '👨‍👩‍👧 Family Fun' },
  rawChip('nonprofit'),
  rawChip('sports'),
  rawChip('fitness'),
  rawChip('education'),
  rawChip('nature'),
  { kind: 'intent', value: 'give-back',  label: '💛 Give Back' },
  rawChip('community'),
]

export const SORT_OPTIONS = [
  { value: 'soonest', label: '📅 Soonest first' },
  { value: 'latest',  label: '🕐 Latest first' },
  { value: 'recent',  label: '🆕 Recently added' },
]

export const PRICE_OPTIONS = [
  { value: null,       label: 'Any price' },
  { value: 'free',     label: '🎉 Free' },
  { value: 'under10',  label: 'Under $10' },
  { value: 'under25',  label: 'Under $25' },
]
