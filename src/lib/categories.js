/**
 * categories.js — THE single source of truth for the event category taxonomy.
 *
 * Every category-aware surface in the app derives from this file:
 *   - DB check constraint            (supabase/migrations — kept in sync manually;
 *                                     CATEGORY_SLUGS is the authoritative list)
 *   - Category inference             (scripts/lib/category-inference.js validates
 *                                     its output against CATEGORY_SLUGS)
 *   - Filter & Sort tray             (src/lib/filterOptions.js)
 *   - Admin event editor dropdown    (src/lib/admin/constants.js)
 *   - Category badges / pills        (src/components/CategoryBadge.jsx)
 *   - Prose + gradient + label maps  (src/lib/eventFormatting.js)
 *
 * BEFORE THIS FILE EXISTED these lists had drifted: the admin editor was
 * missing `nature` entirely (operators literally could not assign it), and
 * each surface re-declared its own copy of the slug list. Add or change a
 * category HERE and every surface updates at once.
 *
 * This module is intentionally dependency-free and framework-agnostic so it
 * can be imported by both the Vite/React frontend (`@/lib/categories`) and the
 * plain-Node ingestion scripts (`../../src/lib/categories.js`). Do not add
 * imports that rely on Vite (`import.meta.env`, CSS, JSX) or on Node (`fs`,
 * `process`) here.
 *
 * Field reference for each entry:
 *   slug            internal enum value stored in events.category (DB truth)
 *   label           title-case user-facing label  (badges, filter chips, headers)
 *   short           lower-case label for running prose ("more music events")
 *   emoji           filter-chip emoji
 *   gradient        CSS gradient utility class (src/styles/globals.css)
 *   tagClass        CSS class for the colored badge pill
 *   adminSelectable whether the admin editor offers it in the category dropdown
 *   filterable      whether it appears as a chip in the public filter tray
 *                   ('other' is a system fallback — assignable by admins but
 *                    never offered as a public filter)
 */

export const CATEGORIES = Object.freeze([
  { slug: 'music',     label: 'Music',       short: 'music',     emoji: '🎵', gradient: 'gradient-jazz',    tagClass: 'tag-music',     adminSelectable: true, filterable: true  },
  { slug: 'art',       label: 'Art',         short: 'art',       emoji: '🎨', gradient: 'gradient-art',     tagClass: 'tag-art',       adminSelectable: true, filterable: true  },
  { slug: 'food',      label: 'Food & Drink', short: 'food',     emoji: '🍺', gradient: 'gradient-market',  tagClass: 'tag-food',      adminSelectable: true, filterable: true  },
  { slug: 'nonprofit', label: 'Non-Profit',  short: 'nonprofit', emoji: '🤲', gradient: 'gradient-gala',    tagClass: 'tag-nonprofit', adminSelectable: true, filterable: true  },
  { slug: 'sports',    label: 'Sports',      short: 'sports',    emoji: '🏟', gradient: 'gradient-sports',  tagClass: 'tag-sports',    adminSelectable: true, filterable: true  },
  { slug: 'fitness',   label: 'Fitness',     short: 'fitness',   emoji: '🏃', gradient: 'gradient-run',     tagClass: 'tag-fitness',   adminSelectable: true, filterable: true  },
  { slug: 'education', label: 'Education',   short: 'education', emoji: '📚', gradient: 'gradient-openmic', tagClass: 'tag-education', adminSelectable: true, filterable: true  },
  { slug: 'nature',    label: 'Nature',      short: 'nature',    emoji: '🌿', gradient: 'gradient-forest',  tagClass: 'tag-nature',    adminSelectable: true, filterable: true  },
  { slug: 'community', label: 'Community',   short: 'community', emoji: '🤝', gradient: 'gradient-civic',   tagClass: 'tag-community', adminSelectable: true, filterable: true  },
  { slug: 'other',     label: 'Other',       short: 'other',     emoji: '✨', gradient: 'gradient-default', tagClass: 'tag-other',     adminSelectable: true, filterable: false },
])

// ── Derived lookups ─────────────────────────────────────────────────
// All maps below are generated from CATEGORIES so they can never drift.

/** Ordered list of valid category slugs — the authoritative enum. */
export const CATEGORY_SLUGS = Object.freeze(CATEGORIES.map((c) => c.slug))

/** Fast slug → definition lookup. */
export const CATEGORY_BY_SLUG = Object.freeze(
  Object.fromEntries(CATEGORIES.map((c) => [c.slug, c]))
)

const pick = (field) =>
  Object.freeze(Object.fromEntries(CATEGORIES.map((c) => [c.slug, c[field]])))

/** slug → title-case label (e.g. 'food' → 'Food & Drink'). */
export const CATEGORY_DISPLAY = pick('label')
/** slug → lower-case prose label. */
export const CATEGORY_SHORT = pick('short')
/** slug → filter-chip emoji. */
export const CATEGORY_EMOJI = pick('emoji')
/** slug → gradient utility class. */
export const GRADIENT_MAP = pick('gradient')
/** slug → badge pill CSS class. */
export const TAG_CLASS_MAP = pick('tagClass')

/** Categories an admin may assign in the event editor dropdown. */
export const ADMIN_CATEGORIES = Object.freeze(
  CATEGORIES.filter((c) => c.adminSelectable).map((c) => ({
    value: c.slug,
    label: c.label,
  }))
)

/** Categories offered as chips in the public filter tray. */
export const FILTERABLE_CATEGORIES = Object.freeze(
  CATEGORIES.filter((c) => c.filterable)
)

/** True when `slug` is a recognised category. */
export function isValidCategory(slug) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_BY_SLUG, slug)
}

/** Gradient class for a category, with safe fallback. */
export function gradientFor(category) {
  return GRADIENT_MAP[category] ?? 'gradient-default'
}
