/**
 * themes.js
 *
 * Single source of truth for theme options. Every theme is a CSS class
 * (.theme-<id>) defined in themes.css that overrides the brand-coupled
 * tokens. The useTheme hook always applies a class so DEFAULT_THEME can
 * be swapped freely without touching globals.css.
 *
 * Storage: localStorage only. The user's choice persists across
 * sessions but never leaves the device — zero backend cost. If/when
 * we want the choice tied to an account, move the persistence into
 * Supabase (the picker UI doesn't need to change).
 */

export const THEMES = [
  // ── New Akron Pulse rebrand palettes (top of the list) ──
  {
    id: 'akron-pulse',
    name: 'Civic Teal',
    description: 'Petrol teal with warm coral — the new default.',
  },
  {
    id: 'grand-piano',
    name: 'Grand Piano',
    description: 'Concert hall monochrome — ivory, black, and warm charcoal.',
  },
  {
    id: 'pulse-red',
    name: 'Pulse Red',
    description: 'Vermilion heartbeat on cream.',
  },
  {
    id: 'twilight-plum',
    name: 'Twilight Plum',
    description: 'Deep plum lifted by dusty gold.',
  },
  {
    id: 'forest-amber',
    name: 'Forest & Amber',
    description: 'Grounded forest green with honey amber.',
  },
  // ── Original Turnout-era palettes (preserved) ──
  {
    id: 'civic-classic',
    name: 'Civic Classic',
    description: 'The original — warm amber on cream.',
  },
  {
    id: 'harbor-civic',
    name: 'Harbor Civic',
    description: 'Editorial navy with terracotta.',
  },
  {
    id: 'violet-hour',
    name: 'Violet Hour',
    description: 'Rebeccapurple and jewel teal.',
  },
  {
    id: 'boardwalk',
    name: 'Boardwalk',
    description: 'Teal shore with tomato sunset.',
  },
  {
    id: 'olive-grove',
    name: 'Olive Grove',
    description: 'Muted olives on sand dune.',
  },
  {
    id: 'arcade-night',
    name: 'Arcade Night',
    description: 'Hot pink and sapphire on shadow grey.',
  },
  {
    id: 'stargazer',
    name: 'Stargazer',
    description: 'Twilight indigo with dusty lavender.',
  },
  {
    id: 'prime-time',
    name: 'Prime Time',
    description: 'Primary colors on oxford navy.',
  },
]

export const DEFAULT_THEME = 'akron-pulse'
export const THEME_STORAGE_KEY = 'akronpulse.theme'
// Pre-rebrand key. useTheme migrates this into THEME_STORAGE_KEY on first
// load so users' saved palette survives the rename. Safe to remove after
// enough time has passed that no live user still has the old key.
export const LEGACY_THEME_STORAGE_KEY = 'turnout.theme'

export const isValidTheme = (id) => THEMES.some((t) => t.id === id)
