/**
 * themes.js
 *
 * Single source of truth for theme options. The default ("civic-classic")
 * IS the :root palette in globals.css — no class is applied for it.
 * Every other option is a CSS class (.theme-<id>) defined in themes.css
 * that overrides the brand-coupled tokens.
 *
 * Storage: localStorage only. The user's choice persists across
 * sessions but never leaves the device — zero backend cost. If/when
 * we want the choice tied to an account, move the persistence into
 * Supabase (the picker UI doesn't need to change).
 */

export const THEMES = [
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

export const DEFAULT_THEME = 'civic-classic'
export const THEME_STORAGE_KEY = 'turnout.theme'

export const isValidTheme = (id) => THEMES.some((t) => t.id === id)
