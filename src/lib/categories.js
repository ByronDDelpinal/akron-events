/**
 * categories.js — THE single source of truth for the event taxonomy.
 *
 * Option 6 (faceted) model:
 *   • Axis 1 — CONTENT category (the badge). 14 mutually-exclusive-ish slugs.
 *   • Axes 2/3 — FACETS: cross-cutting boolean flags (family, fundraiser) plus
 *     derived facets (free) and the display-only age restriction. Facets are
 *     NOT content categories — a kids' zoo day is `outdoors` + family; a charity
 *     gala is `food` + fundraiser.
 *
 * Every category-aware surface derives from this file: the DB check constraint
 * (event_categories), inference (scripts/lib/category-inference.js), the filter
 * tray, the admin editor, badges, and the prose/gradient/label maps.
 *
 * Dependency-free + framework-agnostic so it can be imported by both the
 * Vite/React frontend (`@/lib/categories`) and the plain-Node ingestion scripts
 * (`../../src/lib/categories.js`). No Vite-only (`import.meta.env`, CSS, JSX) or
 * Node-only (`fs`, `process`) imports here.
 *
 * Field reference:
 *   slug/label/short/emoji/gradient/tagClass/adminSelectable/filterable — as
 *   before. tagClass/gradient for the new theater/film/comedy/festival/market
 *   slugs have CSS rules in src/styles/globals.css.
 */

// ── Axis 1: content categories (the badge) ──────────────────────────
export const CATEGORIES = Object.freeze([
  { slug: 'music',      label: 'Music',        short: 'music',     emoji: '🎵', gradient: 'gradient-music',      tagClass: 'tag-music',      adminSelectable: true, filterable: true  },
  { slug: 'theater',    label: 'Theater',      short: 'theater',   emoji: '🎭', gradient: 'gradient-theater',    tagClass: 'tag-theater',    adminSelectable: true, filterable: true  },
  { slug: 'film',       label: 'Film',         short: 'film',      emoji: '🎬', gradient: 'gradient-film',       tagClass: 'tag-film',       adminSelectable: true, filterable: true  },
  { slug: 'comedy',     label: 'Comedy',       short: 'comedy',    emoji: '😂', gradient: 'gradient-comedy',     tagClass: 'tag-comedy',     adminSelectable: true, filterable: true  },
  { slug: 'visual-art', label: 'Art',          short: 'art',       emoji: '🎨', gradient: 'gradient-visual-art', tagClass: 'tag-visual-art', adminSelectable: true, filterable: true  },
  { slug: 'food',       label: 'Food & Drink', short: 'food',      emoji: '🍎', gradient: 'gradient-food',       tagClass: 'tag-food',       adminSelectable: true, filterable: true  },
  { slug: 'sports',     label: 'Sports',       short: 'sports',    emoji: '⚾', gradient: 'gradient-sports',     tagClass: 'tag-sports',     adminSelectable: true, filterable: true  },
  { slug: 'fitness',    label: 'Fitness',      short: 'fitness',   emoji: '🏋', gradient: 'gradient-fitness',    tagClass: 'tag-fitness',    adminSelectable: true, filterable: true  },
  { slug: 'outdoors',   label: 'Outdoors',     short: 'outdoors',  emoji: '🌿', gradient: 'gradient-outdoors',   tagClass: 'tag-outdoors',   adminSelectable: true, filterable: true  },
  { slug: 'learning',   label: 'Learning',     short: 'learning',  emoji: '✏️', gradient: 'gradient-learning',   tagClass: 'tag-learning',   adminSelectable: true, filterable: true  },
  { slug: 'festival',   label: 'Festivals',    short: 'festival',  emoji: '🎪', gradient: 'gradient-festival',   tagClass: 'tag-festival',   adminSelectable: true, filterable: true  },
  { slug: 'market',     label: 'Markets',      short: 'market',    emoji: '🛍', gradient: 'gradient-market',     tagClass: 'tag-market',     adminSelectable: true, filterable: true  },
  { slug: 'civic',      label: 'Civic',        short: 'civic',     emoji: '🏛', gradient: 'gradient-civic',      tagClass: 'tag-civic',      adminSelectable: true, filterable: true  },
  { slug: 'other',      label: 'Other',        short: 'other',     emoji: '✨', gradient: 'gradient-other',      tagClass: 'tag-other',      adminSelectable: true, filterable: false },
])

export const CATEGORY_SLUGS = Object.freeze(CATEGORIES.map((c) => c.slug))

// ── Axes 2/3: facets (cross-cutting flags, NOT content categories) ──
export const FACETS = Object.freeze([
  { slug: 'family',     label: 'Family',     emoji: '👨‍👩‍👧', kind: 'audience', column: 'is_family',     derived: null },
  { slug: 'fundraiser', label: 'Fundraiser', emoji: '💛',     kind: 'purpose',  column: 'is_fundraiser', derived: null },
  { slug: 'free',       label: 'Free',       emoji: '🎉',     kind: 'price',    column: null,            derived: 'price_min = 0' },
])

export const FACET_SLUGS = Object.freeze(FACETS.map((f) => f.slug))

// Display-only constraint (surfaced only when restrictive). Unchanged schema.
export const AGE_RESTRICTIONS = Object.freeze(['not_specified', 'all_ages', '18_plus', '21_plus'])

// ── Curated intents (the lean discovery layer) ─────────────────────
// `categories` filter the content axis (OR/any-match); `facets` filter the flag
// axis. An intent may use either or both.
export const INTENTS = Object.freeze([
  { id: 'date-night',      label: 'Date Night',        emoji: '🌙',   tagline: 'Music, theater, comedy, film, food & a game — a great evening out', categories: ['music', 'theater', 'comedy', 'film', 'food', 'sports'], facets: [] },
  { id: 'family',          label: 'Family',            emoji: '👨‍👩‍👧', tagline: 'Kid- and family-programmed things to do',                          categories: [], facets: ['family'] },
  { id: 'arts-stage',      label: 'Arts & Stage',      emoji: '🎭',   tagline: 'Galleries, theater, film & comedy',                                categories: ['visual-art', 'theater', 'film', 'comedy'], facets: [] },
  { id: 'give-back',       label: 'Give Back',         emoji: '💛',   tagline: 'Fundraisers, benefits & volunteering',                             categories: [], facets: ['fundraiser'] },
  { id: 'outdoors-active', label: 'Outdoors & Active', emoji: '🌲',   tagline: 'Parks, sports, fitness, festivals & markets',                      categories: ['outdoors', 'sports', 'fitness', 'festival', 'market'], facets: [] },
])

// ── Backfill map: v1 single category → v2 content category ─────────
export const V1_TO_V2 = Object.freeze({
  music:     { categories: ['music'],      setFacet: null },
  art:       { categories: ['visual-art'], setFacet: null },
  food:      { categories: ['food'],       setFacet: null },
  sports:    { categories: ['sports'],     setFacet: null },
  fitness:   { categories: ['fitness'],    setFacet: null },
  education: { categories: ['learning'],   setFacet: null },
  nature:    { categories: ['outdoors'],   setFacet: null },
  nonprofit: { categories: ['other'],      setFacet: 'is_fundraiser' },
  community: { categories: ['other'],      setFacet: null },
  other:     { categories: ['other'],      setFacet: null },
})

// ── Derived lookups (generated from CATEGORIES — never drift) ──────
export const CATEGORY_BY_SLUG = Object.freeze(Object.fromEntries(CATEGORIES.map((c) => [c.slug, c])))
const pick = (field) => Object.freeze(Object.fromEntries(CATEGORIES.map((c) => [c.slug, c[field]])))
export const CATEGORY_DISPLAY = pick('label')
export const CATEGORY_SHORT   = pick('short')
export const CATEGORY_EMOJI   = pick('emoji')
export const GRADIENT_MAP     = pick('gradient')
export const TAG_CLASS_MAP    = pick('tagClass')
export const ADMIN_CATEGORIES = Object.freeze(CATEGORIES.filter((c) => c.adminSelectable).map((c) => ({ value: c.slug, label: c.label })))
export const FILTERABLE_CATEGORIES = Object.freeze(CATEGORIES.filter((c) => c.filterable))
export function isValidCategory(slug) { return Object.prototype.hasOwnProperty.call(CATEGORY_BY_SLUG, slug) }
export function gradientFor(category) { return GRADIENT_MAP[category] ?? 'gradient-default' }
