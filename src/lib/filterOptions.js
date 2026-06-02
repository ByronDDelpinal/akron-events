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

export const CATEGORY_OPTIONS = [
  { kind: 'intent', value: 'date-night', label: '🌙 Date Night' },
  { kind: 'raw',    value: 'music',      label: '🎵 Music' },
  { kind: 'raw',    value: 'art',        label: '🎨 Art' },
  { kind: 'raw',    value: 'food',       label: '🍺 Food & Drink' },
  { kind: 'intent', value: 'family-fun', label: '👨‍👩‍👧 Family Fun' },
  { kind: 'raw',    value: 'nonprofit',  label: '🤲 Non-Profit' },
  { kind: 'raw',    value: 'sports',     label: '🏟 Sports' },
  { kind: 'raw',    value: 'fitness',    label: '🏃 Fitness' },
  { kind: 'raw',    value: 'education',  label: '📚 Education' },
  { kind: 'raw',    value: 'nature',     label: '🌿 Nature' },
  { kind: 'intent', value: 'give-back',  label: '💛 Give Back' },
  { kind: 'raw',    value: 'community',  label: '🤝 Community' },
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
